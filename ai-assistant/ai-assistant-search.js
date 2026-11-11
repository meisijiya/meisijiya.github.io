/*
 * 分层检索
 *
 * 直接把全站正文塞给模型会烧光 token，所以检索分三层，每层都只往后传很少的东西：
 *   L0 本地 BM25 —— 用构建期生成的轻量索引打分，0 token，不联网
 *   L1 查询改写 —— 让模型把口语问题改写成 3~6 个检索词，约 200 token
 *   L2 语义排序 —— 把 L0 的前 20 条压成极简列表交给模型重排，约 1600 token
 * 真正的正文永远由 read_section 工具按需读取。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var INDEX_URL = '/ai-assistant/index.json';
    var K1 = 1.2;
    var B = 0.75;

    var index = null;
    var loading = null;
    var docStats = null;
    var modelCaller = null;

    /*
     * 跨文章读正文：走主题侧站内搜索的分片，不再下整页 HTML。
     * 契约只有三个字段：manifest.v、meta[i].f、分片 {v,u,t,s:[{i,t,l,x}]}。
     * 缓存与站内搜索面板共用同一个 Cache Storage 名与同一套 key 拼法。
     */
    /*
     * 索引路径跟站内搜索面板一致：根路径取页面上的 data-root（主题的
     * .panel/.scrim 上带 data-root），不是写死 '/'——站点换子路径部署时
     * 写死会 404，而面板照常用。
     */
    function siteRoot() {
        var host = document.querySelector('.panel[data-root], .scrim[data-root]');
        var root = host && host.getAttribute('data-root') ? host.getAttribute('data-root') : '/';
        if (!root) root = '/';
        if (root.charAt(root.length - 1) !== '/') root += '/';
        return root;
    }

    var SEARCH_ROOT = siteRoot() + 'search/';
    var CACHE_NAME = 'search-index-v1';
    var ARTICLE_CACHE = Object.create(null);
    var metaCache = null;
    var metaLoading = null;
    var manifestSig = null;

    function cacheGet(key) {
        if (typeof caches === 'undefined' || !caches || !caches.open) return Promise.resolve(null);
        return caches.open(CACHE_NAME)
            .then(function (cache) { return cache.match(key); })
            .then(function (hit) { return hit ? hit.json() : null; })
            .catch(function () { return null; });
    }

    function cachePut(key, data) {
        if (typeof caches === 'undefined' || !caches || !caches.open) return;
        try {
            caches.open(CACHE_NAME).then(function (cache) {
                return cache.put(key, new Response(JSON.stringify(data), {
                    headers: { 'Content-Type': 'application/json' }
                }));
            }).catch(function () { /* 缓存失败不影响本次读取 */ });
        } catch (e) { /* 同上 */ }
    }

    function fetchJson(url) {
        return fetch(url, { credentials: 'same-origin' }).then(function (res) {
            if (!res.ok) throw new Error('索引请求失败：HTTP ' + res.status);
            return res.json();
        });
    }

    function loadJson(url) {
        return cacheGet(url).then(function (hit) {
            if (hit) return hit;
            return fetchJson(url).then(function (data) {
                cachePut(url, data);
                return data;
            });
        });
    }

    /*
     * 清单走 network-first：站点重建后清单文件名会变，
     * cache-first 会一直喂旧清单，助手从此「站内索引里没有这篇文章」。
     * 网络不通才回落缓存。
     */
    function loadManifest() {
        var url = SEARCH_ROOT + 'manifest.json';
        return fetchJson(url).then(function (data) {
            cachePut(url, data);
            return data;
        }).catch(function (err) {
            return cacheGet(url).then(function (hit) {
                if (hit) return hit;
                throw err;
            });
        });
    }

    function loadMeta() {
        if (metaCache) return Promise.resolve(metaCache);
        if (metaLoading) return metaLoading;
        metaLoading = loadManifest().then(function (manifest) {
            if (!manifest || manifest.v !== 2) throw new Error('站内索引格式已变');
            // 清单变了：旧的分片缓存作废（同一 URL 的文章内容可能已经变了）
            var sig = String(manifest.meta || '');
            if (manifestSig !== null && manifestSig !== sig) {
                ARTICLE_CACHE = Object.create(null);
            }
            manifestSig = sig;
            return loadJson(SEARCH_ROOT + manifest.meta);
        }).then(function (meta) {
            metaCache = meta;
            return meta;
        }).catch(function (err) {
            metaLoading = null;
            throw err;
        });
        return metaLoading;
    }

    function normalizeUrl(url) {
        var value = String(url || '');
        // location.pathname 里的中文是百分号编码的，索引里的 u 是原样中文；不解码就对不上
        if (value.indexOf('%') !== -1) {
            try { value = decodeURIComponent(value); } catch (e) { /* 解不开就按原样比 */ }
        }
        return value.length > 1 && value.charAt(value.length - 1) === '/' ? value.slice(0, -1) : value;
    }

    function findEntry(meta, url) {
        var wanted = normalizeUrl(url);
        var keys = Object.keys(meta || {});
        for (var i = 0; i < keys.length; i++) {
            var entry = meta[keys[i]];
            if (entry && normalizeUrl(entry.u) === wanted) return entry;
        }
        return null;
    }

    /* 读一篇文章的小节：{ title, sections: [{i,t,l,x}] }，按 url 缓存 Promise */
    function loadArticle(url) {
        var key = normalizeUrl(url);
        if (ARTICLE_CACHE[key]) return ARTICLE_CACHE[key];
        ARTICLE_CACHE[key] = loadMeta().then(function (meta) {
            var entry = findEntry(meta, key);
            if (!entry || !entry.f) throw new Error('站内索引里没有这篇文章');
            return loadJson(SEARCH_ROOT + entry.f);
        }).then(function (shard) {
            if (!shard || shard.v !== 2 || !Array.isArray(shard.s)) throw new Error('站内索引格式已变');
            return { title: shard.t || '', sections: shard.s };
        }).catch(function (err) {
            delete ARTICLE_CACHE[key];
            throw err;
        });
        return ARTICLE_CACHE[key];
    }

    function tokenize(text) {
        var tokens = [];
        var lower = (text || '').toLowerCase();
        var ascii = lower.match(/[a-z0-9]+/g) || [];
        for (var i = 0; i < ascii.length; i++) {
            if (ascii[i].length >= 2) tokens.push(ascii[i]);
        }
        var cjk = lower.match(/[\u4e00-\u9fa5]+/g) || [];
        for (var c = 0; c < cjk.length; c++) {
            var run = cjk[c];
            if (run.length === 1) {
                tokens.push(run);
                continue;
            }
            for (var k = 0; k + 1 < run.length; k++) {
                tokens.push(run.substr(k, 2));
            }
        }
        return tokens;
    }

    function parseTerms(str) {
        var map = Object.create(null);
        var parts = (str || '').split(/\s+/);
        for (var i = 0; i < parts.length; i++) {
            var pair = parts[i].split(':');
            if (pair.length !== 2) continue;
            var tf = parseInt(pair[1], 10);
            if (!tf) continue;
            map[pair[0]] = tf;
        }
        return map;
    }

    function buildStats() {
        var df = Object.create(null);
        var avgLen = 0;
        var docs = index.docs;
        for (var i = 0; i < docs.length; i++) {
            var terms = parseTerms(docs[i].terms);
            avgLen += Object.keys(terms).length;
            for (var key in terms) {
                df[key] = (df[key] || 0) + 1;
            }
        }
        docStats = {
            df: df,
            avgLen: docs.length ? avgLen / docs.length : 0,
            total: docs.length
        };
    }

    function loadIndex() {
        if (index) return Promise.resolve(index);
        if (loading) return loading;
        loading = fetch(INDEX_URL, { credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('索引加载失败：HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                index = data;
                buildStats();
                loading = null;
                return index;
            })
            .catch(function (err) {
                loading = null;
                throw err;
            });
        return loading;
    }

    function idf(term) {
        var df = docStats.df[term] || 0;
        var n = docStats.total;
        return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    }

    /* L0：本地打分，标题与标题列表命中权重更高 */
    function bm25(queryTokens) {
        if (!index || !docStats) return [];
        var docs = index.docs;
        var scored = [];
        for (var i = 0; i < docs.length; i++) {
            var doc = docs[i];
            var terms = parseTerms(doc.terms);
            var score = 0;
            for (var t = 0; t < queryTokens.length; t++) {
                var term = queryTokens[t];
                var tf = terms[term];
                if (!tf) continue;
                var denom = tf + K1 * (1 - B + B * (Object.keys(terms).length / (docStats.avgLen || 1)));
                score += idf(term) * (tf * (K1 + 1)) / denom;
            }
            var title = (doc.title || '').toLowerCase();
            // headText 是构建期拼好的全部小节标题（换行分隔），检索时只做子串命中判断
            var head = (doc.headText || '').toLowerCase();
            var sum = (doc.summary || '').toLowerCase();
            for (var q = 0; q < queryTokens.length; q++) {
                var word = queryTokens[q];
                if (title.indexOf(word) >= 0) score += 3;
                if (head.indexOf(word) >= 0) score += 2;
                if (sum.indexOf(word) >= 0) score += 1.5;
            }
            // 零分判定必须放在加权之后：词表只留高频词，
            // 冷门词常常只出现在小节标题里（如「深拷贝」），
            // 先判零会把这类文章直接剔掉，标题命中根本轮不到加分
            if (score <= 0) continue;
            scored.push({ doc: doc, score: score });
        }
        scored.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.doc.url < b.doc.url ? -1 : 1;
        });
        return scored;
    }

    /* L1：让模型把口语问题改写成检索词 */
    function expand(query) {
        if (!modelCaller) return Promise.resolve([]);
        var prompt = '把下面的中文提问改写成 3 到 6 个检索词，每行一个，不要编号，不要解释，只输出检索词本身。\n\n提问：' + query;
        return modelCaller(prompt, { maxTokens: 120 })
            .then(function (text) {
                return (text || '')
                    .split('\n')
                    .map(function (line) { return line.replace(/^[\s\-*\d.、]+/, '').trim(); })
                    .filter(function (line) { return line && line.length <= 24; })
                    .slice(0, 6);
            })
            .catch(function () { return []; });
    }

    /* L2：把候选压成极简列表交给模型重排 */
    function rerank(query, candidates) {
        if (!modelCaller || !candidates.length) return Promise.resolve(candidates.slice(0, 5));
        var lines = candidates.map(function (item, i) {
            var summary = (item.doc.summary || '').slice(0, 80);
            return (i + 1) + '. ' + item.doc.title + ' | ' + summary;
        });
        var prompt = '下面是候选文章，按与提问的相关度排序，只输出最多 5 行，每行一个序号，不要解释。\n\n提问：' + query + '\n\n候选：\n' + lines.join('\n');
        return modelCaller(prompt, { maxTokens: 80 })
            .then(function (text) {
                var order = [];
                (text || '').split('\n').forEach(function (line) {
                    var m = line.match(/(\d+)/);
                    if (m) {
                        var idx = parseInt(m[1], 10) - 1;
                        if (idx >= 0 && idx < candidates.length && order.indexOf(idx) < 0) order.push(idx);
                    }
                });
                if (!order.length) return candidates.slice(0, 5);
                var picked = order.slice(0, 5).map(function (idx) { return candidates[idx]; });
                for (var i = 0; i < candidates.length && picked.length < 5; i++) {
                    if (order.indexOf(i) < 0) picked.push(candidates[i]);
                }
                return picked;
            })
            .catch(function () { return candidates.slice(0, 5); });
    }

    /* 兜底：分词命中不了时，直接拿原问句去标题、小节标题、摘要里找子串 */
    function substringSearch(query, limit) {
        if (!index || !query) return [];
        var needle = String(query).toLowerCase().replace(/\s+/g, '');
        if (needle.length < 2) return [];
        var scored = [];
        for (var i = 0; i < index.docs.length; i++) {
            var doc = index.docs[i];
            var title = (doc.title || '').toLowerCase().replace(/\s+/g, '');
            var head = (doc.headText || '').toLowerCase().replace(/\s+/g, '');
            var sum = (doc.summary || '').toLowerCase().replace(/\s+/g, '');
            var score = 0;
            if (title.indexOf(needle) >= 0) score += 3;
            if (head.indexOf(needle) >= 0) score += 2;
            if (sum.indexOf(needle) >= 0) score += 1;
            if (score > 0) scored.push({ doc: doc, score: score });
        }
        scored.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.doc.url < b.doc.url ? -1 : 1;
        });
        return scored.slice(0, limit || 20);
    }

    function search(query, options) {
        var opts = options || {};
        var limit = opts.limit || 5;
        return loadIndex().then(function () {
            var baseTokens = tokenize(query);
            var local = bm25(baseTokens);
            if (!opts.withModel) {
                var fallback = local.length ? local : substringSearch(query, limit);
                return {
                    items: fallback.slice(0, limit).map(function (item) { return item.doc; }),
                    expanded: [],
                    mode: 'local'
                };
            }
            return expand(query).then(function (terms) {
                var tokens = baseTokens.slice();
                for (var i = 0; i < terms.length; i++) {
                    tokens = tokens.concat(tokenize(terms[i]));
                }
                var merged = bm25(tokens);
                var pool = merged.length ? merged : local;
                if (!pool.length) pool = substringSearch(query, 20);
                return rerank(query, pool.slice(0, 20)).then(function (picked) {
                    return {
                        items: picked.map(function (item) { return item.doc; }),
                        expanded: terms,
                        mode: 'model'
                    };
                });
            });
        });
    }

    AI.search = {
        loadIndex: loadIndex,
        tokenize: tokenize,
        search: search,
        loadArticle: loadArticle,
        cacheName: CACHE_NAME,
        setModelCaller: function (fn) {
            modelCaller = fn;
        },
        indexUrl: INDEX_URL
    };
})();
