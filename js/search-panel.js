(function (w) {
    var PHONE_MQ = w.matchMedia('(max-width: 767px)');
    var KB_SHRINK = 140;
    var BATCH = 20;   // 预取批大小（分片）
    var TOP = 10;     // 正文段展示条数
    var CACHE_NAME = 'search-index-v1';
    // 缓存总量上限：全量索引约 3.2MB + 分片头寸；超限时按分片 FIFO 淘汰，避免无限增长
    var CACHE_MAX_BYTES = 10 * 1024 * 1024;  // 内存退路的字节预算
    function $(s, r) { return (r || document).querySelector(s); }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }

    var scrim, panel, entries, lastTrigger, sinput, xbtn, catsEl, resultsEl, statusEl, catsWrap;
    var meta = null;
    var loading = null;
    var announceTimer = null;
    var composing = false;
    var selectedCat = '全部';

    // 正文检索状态：ascii 倒排与 meta 并行拉，cn 在 ascii 到位后后台补
    var IDX = { manifest: null, meta: null, ascii: null, cn: null, shards: {} };
    var memCache = new Map();   // url -> { data, size }，Cache Storage 不可用时的内存退路
    var memSize = 0;            // 内存退路已占用字节
    // 分组结果、已展示条数与折叠状态：折叠与「加载更多」都从这里取
    var groups = { title: [], tag: [], cat: [], section: [] };
    var shownCount = { tag: 5 };
    var grpCollapsed = {};
    var TAG_STEP = 5;
    var bodyRequested = false;
    var bodySeq = 0;      // 每次查询递增，废掉过期批次
    var curQuery = '';
    var bodySlot = null;  // 正文段挂载点（固定在元数据段之后）
    var metaTotal = 0;    // 元数据段条数，供正文到达后重播总数

    function root() {
        var el = $('.panel') || $('.scrim');
        return (el && el.dataset && el.dataset.root) ? el.dataset.root : '/';
    }

    function syncSoftKb() {
        var vv = w.visualViewport;
        var compressed = PHONE_MQ.matches && !!vv && (w.innerHeight - vv.height) > KB_SHRINK;
        if (panel) panel.classList.toggle('kb', compressed);
    }

    function cacheAvailable() {
        return (typeof caches !== 'undefined' && caches && typeof caches.open === 'function');
    }
    function cachedFetch(url) {
        // 优先 Cache Storage；不可用时退内存；失败静默降级到网络
        if (cacheAvailable()) {
            return caches.open(CACHE_NAME).then(function (cache) {
                return cache.match(url).then(function (res) {
                    if (res) return res.json();
                    return null;
                });
            }).catch(function () { return null; });
        }
        var m = memCache.get(url);
        return Promise.resolve(m ? m.data : null);
    }
    function cacheStore(url, data, json) {
        // 静默降级：配额满/隐私模式等写入失败不影响检索
        var size = (json && json.length) || 0;
        if (cacheAvailable()) {
            try {
                caches.open(CACHE_NAME).then(function (cache) {
                    var body = new Response(json, { headers: { 'content-type': 'application/json' } });
                    cache.put(url, body).then(function () {
                        // 超限 FIFO 淘汰：按 Cache Storage keys 顺序删到上限
                        enforceLimit();
                    }).catch(function () {});
                }).catch(function () {});
            } catch (e) {}
        } else {
            // 内存退路
            if (memSize + size > CACHE_MAX_BYTES) {
                // FIFO：删最老的分片
                for (var k of memCache.keys()) {
                    if (memSize + size <= CACHE_MAX_BYTES) break;
                    var v = memCache.get(k);
                    memCache.delete(k);
                    memSize -= (v.size || 0);
                }
            }
            memCache.set(url, { data: data, size: size });
            memSize += size;
        }
    }
    // Cache Storage 没有 cheap 的字节统计接口，用文件数当预算：分片中位 17KB，
    // 200 个文件 ≈ 3.4MB，加三份索引仍低于浏览器配额；超出按插入顺序删最老的。
    var CACHE_MAX_FILES = 200;
    function enforceLimit() {
        if (!cacheAvailable()) return;
        caches.open(CACHE_NAME).then(function (cache) {
            cache.keys().then(function (keys) {
                if (keys.length <= CACHE_MAX_FILES) return;
                keys.slice(0, keys.length - CACHE_MAX_FILES).forEach(function (req) {
                    cache.delete(req).catch(function () {});
                });
            }).catch(function () {});
        }).catch(function () {});
    }

    function fetchJson(url) {
        return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }

    function fetchIndexJson(url) {
        return cachedFetch(url).then(function (cached) {
            if (cached) return cached;
            return fetchJson(url).then(function (data) {
                try { cacheStore(url, data, JSON.stringify(data)); } catch (e) {}
                return data;
            });
        });
    }

    function toMap(data) {
        var map = {};
        (data.terms || []).forEach(function (e) { map[e[0]] = e[1]; });
        return map;
    }

    // 清单每次走网络（131 B）；失败时退回缓存里那份
    function manifestFetch() {
        var url = root() + 'search/manifest.json';
        return fetchJson(url).then(function (data) {
            try { cacheStore(url, data, JSON.stringify(data)); } catch (e) {}
            return data;
        }).catch(function () {
            return cachedFetch(url).then(function (cached) {
                if (!cached) throw new Error('manifest unavailable');
                return cached;
            });
        });
    }

    // 打开面板时校验清单：文件名没变就不重下索引，变了才整体重载
    function revalidate() {
        if (!meta) return loadIndex();
        var prev = IDX.manifest || {};
        return manifestFetch().then(function (m) {
            if (m.meta === prev.meta && m.ascii === prev.ascii && m.cn === prev.cn) return meta;
            meta = null;
            IDX = { manifest: null, meta: null, ascii: null, cn: null, shards: {} };
            loading = null;
            bodyRequested = false;
            return loadIndex();
        }).catch(function () { return meta; });
    }

    function loadIndex() {
        if (meta) return Promise.resolve(meta);
        if (loading) return loading;
        loading = manifestFetch()
            .then(function (m) {
                IDX.manifest = m;
                return fetchIndexJson(root() + 'search/' + m.meta).then(function (data) {
                    meta = data; IDX.meta = data; buildCats(); return data;
                });
            })
            .catch(function (err) {
                loading = null;
                if (!meta) {
                    if (resultsEl) resultsEl.innerHTML = '<div class="empty">索引加载失败，<button type="button" class="retry-btn" onclick="window.SearchPanel&&window.SearchPanel.open()">重试</button></div>';
                }
                console.error('Failed to load search index:', err);
            });
        return loading;
    }

    // 正文倒排（ascii，随后 cn）等第一次有非空查询再拉：
    // 打开面板只请求清单与 meta，元数据结果立刻可用
    function ensureBodyIndex() {
        if (!IDX.manifest || bodyRequested) return;
        bodyRequested = true;
        var m = IDX.manifest;
        fetchIndexJson(root() + 'search/' + m.ascii).then(function (data) {
            IDX.ascii = toMap(data);
            rerunBody();
            return fetchIndexJson(root() + 'search/' + m.cn).then(function (data) {
                IDX.cn = toMap(data);
                rerunBody();
            });
        }).catch(function (err) {
            bodyRequested = false;
            console.error('Failed to load body index:', err);
        });
    }

    function firstCats() {
        var set = {};
        (meta || []).forEach(function (m) { if (m.c && m.c.length) set[m.c[0]] = 1; });
        return Object.keys(set).sort();
    }

    function buildCats() {
        if (!catsEl) return;
        var cats = ['全部'].concat(firstCats());
        catsEl.innerHTML = cats.map(function (c) {
            return '<button class="chip' + (c === selectedCat ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>';
        }).join('');
        catsEl.querySelectorAll('.chip').forEach(function (ch) {
            ch.addEventListener('click', function () {
                selectedCat = ch.dataset.c;
                catsEl.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('on', x === ch); });
                render(sinput.value);
            });
        });
        updateFade();
    }

    function analyzeQuery(q) {
        var ascii = (q.toLowerCase().match(/[a-z0-9][a-z0-9+#._-]*/g) || []).filter(function (t) { return t.length >= 2; });
        var cnSegs = q.match(/[\u4e00-\u9fff]+/g) || [];
        var bigrams = [];
        cnSegs.forEach(function (seg) { for (var i = 0; i + 2 <= seg.length; i++) bigrams.push(seg.slice(i, i + 2)); });
        return { ascii: ascii, cnSegs: cnSegs, cnBigrams: bigrams };
    }

    function tokenize(q) {
        var a = analyzeQuery(q);
        return a.ascii.concat(a.cnBigrams);
    }

    function countOccurrences(haystack, needle) {
        if (!haystack || !needle) return 0;
        var h = haystack, n = needle, total = 0, idx = 0;
        // case-insensitive for ascii needles; cn needles exact
        if (/[a-z0-9]/.test(needle)) { h = h.toLowerCase(); n = n.toLowerCase(); }
        while ((idx = h.indexOf(n, idx)) !== -1) { total++; idx += n.length > 0 ? n.length : 1; }
        return total;
    }

    function inCat(m) { return selectedCat === '全部' || (m.c && m.c[0] === selectedCat); }

    /* ---------- 正文候选（倒排 → 篇级 AND） ---------- */

    // 缺失项（被 df>=3 过滤或语料不存在）从 AND 条件里摘掉，靠剩余项出候选；
    // 全部缺失 → 无候选（空集）；没有该类词 → null（该类无约束）
    function intersectTerms(terms, map, approx, missing) {
        if (!terms.length) return null;
        var set = null, present = 0;
        terms.forEach(function (t) {
            var p = map[t];
            if (!p || !p.length) { missing.push(t); return; }
            present++;
            var d = {};
            p.forEach(function (e) { d[e[0]] = 1; approx[e[0]] = (approx[e[0]] || 0) + e[1]; });
            if (set === null) set = d;
            else {
                var next = {};
                Object.keys(set).forEach(function (k) { if (d[k]) next[k] = 1; });
                set = next;
            }
        });
        return present ? set : {};
    }

    function bodyCandidates(aq) {
        // 缺失项（df>=3 被过滤或语料不存在）从 AND 条件里摘掉：对应集合留 null（无约束）
        var res = { asciiSet: null, cnSet: null, approx: {}, asciiMissing: [], cnMissing: [], asciiPending: false, cnPending: false };
        if (IDX.ascii) {
            res.asciiSet = intersectTerms(aq.ascii, IDX.ascii, res.approx, res.asciiMissing);
        } else if (aq.ascii.length) {
            res.asciiPending = true;
        }
        if (IDX.cn) {
            res.cnSet = intersectTerms(aq.cnBigrams, IDX.cn, res.approx, res.cnMissing);
        } else if (aq.cnBigrams.length) {
            res.cnPending = true;
        }
        return res;
    }

    function combineSets(a, b) {
        if (a === null) return b;
        if (b === null) return a;
        var out = {};
        Object.keys(a).forEach(function (k) { if (b[k]) out[k] = 1; });
        return out;
    }

    function fetchShard(file) {
        if (IDX.shards[file]) return IDX.shards[file];
        var p = fetchIndexJson(root() + 'search/' + file)
            .catch(function (err) { console.error('Failed to load shard:', file, err); return null; });
        IDX.shards[file] = p;
        return p;
    }

    // 分片纯文本上的字面计数（不取倒排 tf）
    function countShard(sh, needles) {
        var secs = [];
        var total = 0, pos = -1, firstText = '';
        sh.s.forEach(function (sec, idx) {
            var c = 0;
            needles.forEach(function (n) { c += countOccurrences(sec.x, n); });
            if (c > 0) {
                secs.push({ t: sec.t || '正文开头', c: c, i: sec.i });
                total += c;
                if (pos < 0) { pos = idx; firstText = sec.x; }
            }
        });
        return { total: total, pos: pos, secs: secs, snip: snippet(firstText, needles) };
    }

    function snippet(text, needles) {
        if (!text) return '';
        var idx = -1, found = '';
        for (var i = 0; i < needles.length && idx < 0; i++) {
            var n = needles[i];
            var ascii = /[a-z0-9]/.test(n);
            var hay = ascii ? text.toLowerCase() : text;
            var nd = ascii ? n.toLowerCase() : n;
            idx = hay.indexOf(nd);
            found = nd;
        }
        var start = idx > 30 ? idx - 30 : 0;
        var slice = text.slice(start, start + 120);
        return (start > 0 ? '…' : '') + highlight(slice, needles) + (text.length > start + 120 ? '…' : '');
    }

    function highlight(s, needles) {
        var out = esc(s);
        needles.forEach(function (n) {
            var e = esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (!e) return;
            var re = new RegExp(e, /[a-z0-9]/.test(n) ? 'gi' : 'g');
            out = out.replace(re, function (m) { return '<mark>' + m + '</mark>'; });
        });
        return out;
    }

    function bodyNote(text) {
        if (bodySlot) bodySlot.innerHTML = '<div class="body-note">' + esc(text) + '</div>';
    }

    var gid = 0;

    // 段头即折叠开关：点一下收起该段条目，长列表里不用滚到最底才找到下一段
    function grpOpen(key, label, n) {
        gid += 1;
        var collapsed = !!grpCollapsed[key];
        return '<div class="grp' + (collapsed ? ' collapsed' : '') + '" role="group" aria-labelledby="gh' + gid + '">'
            + '<div class="ghead" id="gh' + gid + '" role="button" tabindex="0" data-grp="' + key
            + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '">'
            + '<svg class="gchev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
            + '<span class="glabel">' + esc(label) + '</span>'
            + ' <span class="cnt">' + n + '<span class="sr-only"> 条</span></span></div>';
    }

    // 标题 / 标签 / 分类目录 / 小节四段的条目行
    function rowHtml(key, r) {
        if (key === 'title') {
            return '<a class="item" href="' + itemHref(r.m, '') + '">'
                + '<div class="ititle">' + esc(r.m.t) + '<span class="cnt-badge hits">' + r.count + ' 次</span></div>'
                + '<div class="imeta"><span>' + esc((r.m.c || []).join(' · ')) + '</span><span class="dot" aria-hidden="true">·</span><span>' + esc((r.m.g || []).join(', ')) + '</span></div>'
                + '</a>';
        }
        if (key === 'tag') {
            return '<a class="item" href="' + itemHref(r.m, '') + '">'
                + '<div class="ititle">' + esc((r.tags || r.m.g).map(function (g) { return '#' + g; }).join(' ')) + '<span class="cnt-badge hits">' + r.count + ' 篇</span></div>'
                + '<div class="imeta"><span>' + esc(r.m.t) + '</span></div>'
                + '</a>';
        }
        if (key === 'cat') {
            return '<a class="item" href="' + itemHref(r.m, '') + '">'
                + '<div class="ititle">' + esc(r.m.t) + '<span class="cnt-badge hits">' + r.count + ' 次</span></div>'
                + '<div class="imeta"><span>' + esc((r.m.c || []).join(' · ')) + '</span></div>'
                + '</a>';
        }
        return '<a class="item" href="' + itemHref(r.m, '') + '">'
            + '<div class="ititle">' + esc(r.heading) + '<span class="cnt-badge hits">' + r.count + ' 次</span></div>'
            + '<div class="imeta"><span>' + esc(r.m.t) + '</span></div>'
            + '</a>';
    }

    function moreLabel(key) {
        var left = (groups[key] || []).length - (shownCount[key] || 0);
        return left > 0 ? '还有 ' + left + ' 篇候选' : null;
    }

    // 追加下一页（标签段按 5 条一页），按钮跟着后移，取完就摘掉
    function loadMoreGroup(key) {
        var list = groups[key] || [];
        var btn = resultsEl.querySelector('.more[data-g="' + key + '"]');
        var start = shownCount[key] || 0;
        var next = list.slice(start, start + TAG_STEP);
        shownCount[key] = start + next.length;
        if (!btn) return;
        btn.insertAdjacentHTML('beforebegin', next.map(function (r) { return rowHtml(key, r); }).join(''));
        var label = moreLabel(key);
        if (label) btn.textContent = label;
        else btn.parentNode.removeChild(btn);
    }

    function toggleGroup(head) {
        var key = head.getAttribute('data-grp');
        var grp = head.parentNode;
        var collapsed = !grp.classList.contains('collapsed');
        grp.classList.toggle('collapsed', collapsed);
        head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        grpCollapsed[key] = collapsed;
    }

    function loadMore(key) {
        if (key === 'body') loadMoreBody();
        else loadMoreGroup(key);
    }

    function itemHref(m, anchor) {
        return esc(m.u) + '?sq=' + encodeURIComponent(curQuery) + (anchor || '');
    }

    function bodyItemHtml(r) {
        var m = meta[r.idx];
        var anchor = r.secs.length && r.secs[0].i ? '#' + encodeURIComponent(r.secs[0].i) : '';
        var html = '<a class="item" href="' + itemHref(m, anchor) + '">'
            + '<div class="ititle">' + esc(m.t) + '<span class="cnt-badge hits">' + r.total + ' 次</span></div>'
            + '<div class="imeta"><span>' + esc((m.c || []).join(' · ')) + '</span></div>'
            + '<div class="isnip">' + r.snip + '</div></a>';
        if (r.secs.length) {
            html += '<button class="sec-toggle" type="button" aria-expanded="false">'
                + '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
                + '<span class="lbl">展开命中小节</span>'
                + '<span class="cnt-badge neutral">' + r.secs.length + '</span></button>'
                + '<div class="secs" hidden>';
            r.secs.forEach(function (sec) {
                var href = sec.i ? itemHref(m, '#' + encodeURIComponent(sec.i)) : itemHref(m, '');
                html += '<a class="sec" href="' + href + '"><span class="t">' + esc(sec.t) + '</span><span class="c">' + sec.c + ' 次</span></a>';
            });
            html += '</div>';
        }
        return html;
    }

    // 正文段还有候选时的按钮文案：先展示已确认的多余命中，再看是否还有未拉的分片
    function bodyMoreLabel() {
        if (!bodyState) return null;
        var left = bodyState.hits.length - bodyState.shown;
        if (left > 0) return '还有 ' + left + ' 篇候选';
        if (bodyState.i < bodyState.keys.length) return '继续加载候选';
        return null;
    }

    function renderBodyGroup() {
        if (!bodySlot || !bodyState) return;
        var st = bodyState;
        if (!st.hits.length) { bodySlot.innerHTML = ''; return; }
        var shown = st.hits.slice(0, st.shown);
        var html = grpOpen('body', '正文命中', st.hits.length);
        if (st.cnPending) html += '<div class="body-note">正文索引加载中</div>';
        shown.forEach(function (r) { html += bodyItemHtml(r); });
        var moreText = bodyMoreLabel();
        if (moreText) html += '<button class="more" type="button" data-g="body">' + moreText + '</button>';
        bodySlot.innerHTML = html + '</div>';
    }

    function sortHits(a, b) {
        if (b.total !== a.total) return b.total - a.total;
        if (a.pos !== b.pos) return a.pos - b.pos;
        return String(meta[a.idx].t).localeCompare(String(meta[b.idx].t));
    }

    // 取下一批候选分片做字面计数，凑不满 TOP 就继续；done 在批次用尽或凑满后调用
    function fetchNextBatch(done) {
        var st = bodyState;
        var seq = st.seq;
        var slice = st.keys.slice(st.i, st.i + BATCH);
        st.i += slice.length;
        if (!slice.length) { done(); return; }
        Promise.all(slice.map(function (d) {
            return fetchShard(IDX.meta[d].f).then(function (sh) { return { d: d, sh: sh }; });
        })).then(function (list) {
            if (!bodyState || seq !== bodyState.seq) return;
            list.forEach(function (it) {
                if (!it.sh) return;
                var r = countShard(it.sh, st.needles);
                if (r.total > 0) { r.idx = it.d; st.hits.push(r); }
            });
            if (st.hits.length < TOP && st.i < st.keys.length) { fetchNextBatch(done); return; }
            done();
        });
    }

    function loadMoreBody() {
        if (!bodyState) return;
        bodyState.shown += TOP;
        if (bodyState.hits.length < bodyState.shown && bodyState.i < bodyState.keys.length) {
            fetchNextBatch(function () {
                bodyState.hits.sort(sortHits);
                renderBodyGroup();
                announce(metaTotal + bodyState.hits.length);
            });
            return;
        }
        renderBodyGroup();
    }

    // bodyKey 记录已算过的 (查询, 分类, ascii 就绪, cn 就绪) 组合，避免重复渲染把用户的展开态折叠掉
    var bodyKey = null;

    function rerunBody() {
        if (!curQuery || !IDX.meta) return;
        var key = curQuery + '|' + selectedCat + '|' + (IDX.ascii ? 1 : 0) + '|' + (IDX.cn ? 1 : 0);
        if (key === bodyKey) return;
        bodyKey = key;
        runBody(curQuery, ++bodySeq);
    }

    // 候选按近似分降序分批拉分片，字面计数后重排；已确认命中 < 10 且候选未尽则续拉下一批
    function runBody(q, seq) {
        if (!bodySlot || !IDX.meta) return;
        var aq = analyzeQuery(q);
        var needles = aq.ascii.concat(aq.cnSegs);
        if (!needles.length) { bodySlot.innerHTML = ''; return; }
        var cand = bodyCandidates(aq);
        // 倒排未到位不产生假结果：只提示「正文索引加载中」，不出正文段
        if (cand.asciiPending || cand.cnPending) { bodyNote('正文索引加载中'); return; }

        var set = combineSets(cand.asciiSet, cand.cnSet);
        // 限定分类：倒排候选是全站的，不在这里过滤就把别的分类正文结果原样搬过来
        var keys = (set ? Object.keys(set).map(Number) : []).filter(function (d) { return inCat(meta[d]); });
        if (!keys.length) { bodySlot.innerHTML = ''; return; }
        keys.sort(function (a, b) {
            var x = cand.approx[b] || 0, y = cand.approx[a] || 0;
            if (x !== y) return x - y;
            return a - b;
        });

        bodyState = {
            seq: seq, keys: keys, i: 0, hits: [], shown: TOP,
            needles: needles, cnPending: cand.cnPending
        };
        bodyNote(cand.cnPending ? '正文索引加载中' : '正文检索中…');
        fetchNextBatch(function () {
            bodyState.hits.sort(sortHits);
            renderBodyGroup();
            var empty = $('.empty', resultsEl);
            if (bodyState.hits.length && empty) empty.parentNode.removeChild(empty);
            announce(metaTotal + bodyState.hits.length);
        });
    }

    function render(q) {
        q = (q || '').trim();
        curQuery = q;
        if (!meta) { resultsEl.innerHTML = '<div class="empty">没有结果，换个关键词试试</div>'; return; }
        var toks = tokenize(q);
        if (!q || !toks.length) {
            resultsEl.innerHTML = '<div class="empty">没有结果，换个关键词试试</div><div class="body-slot"></div>';
            bodySlot = $('.body-slot', resultsEl);
            metaTotal = 0;
            announce(0);
            return;
        }
        // group accumulators
        var titleHits = [], tagHits = [], sectionHits = [], catHits = [];
        // 字段级 AND：每个 token 都出现在该字段才算命中，次数仍按字面出现次数累计。
        // 只要求「任一 token 出现」会让多词查询被单字命中淹掉（实测「内存屏障」命中几十条只含「内存」的小节）。
        function fieldHits(text, needles) {
            if (!text) return 0;
            var hay = text.toLowerCase();
            for (var i = 0; i < needles.length; i++) {
                if (hay.indexOf(needles[i]) === -1) return 0;
            }
            var n = 0;
            needles.forEach(function (t) { n += countOccurrences(text, t); });
            return n;
        }

        meta.forEach(function (m) {
            if (!inCat(m)) return;
            var tc = fieldHits(m.t, toks);
            if (tc > 0) titleHits.push({ m: m, count: tc });

            var tags = m.g || [];
            var tg = fieldHits(tags.join(' '), toks);
            if (tg > 0) {
                var matched = tags.filter(function (g) {
                    var gl = g.toLowerCase();
                    return toks.every(function (t) { return gl.indexOf(t) !== -1; });
                });
                tagHits.push({ m: m, count: tg, tags: matched });
            }

            (m.h || []).forEach(function (h) {
                var sc = fieldHits(h, toks);
                if (sc > 0) sectionHits.push({ m: m, heading: h, count: sc });
            });

            var cg = fieldHits((m.c || []).join(' '), toks);
            if (cg > 0) catHits.push({ m: m, count: cg });
        });

        function sortDesc(a, b) {
            if (b.count !== a.count) return b.count - a.count;
            return String(a.m.t || a.m.t).localeCompare(String(b.m.t || b.m.t));
        }
        titleHits.sort(sortDesc);
        tagHits.sort(sortDesc);
        sectionHits.sort(function (a, b) {
            if (b.count !== a.count) return b.count - a.count;
            if (a.m.t !== b.m.t) return String(a.m.t).localeCompare(String(b.m.t));
            return String(a.heading).localeCompare(String(b.heading));
        });
        catHits.sort(sortDesc);

        groups = { title: titleHits, tag: tagHits, cat: catHits, section: sectionHits };
        shownCount = { tag: Math.min(TAG_STEP, tagHits.length) };
        gid = 0;

        var GROUP_ORDER = [
            ['title', '标题命中'],
            ['tag', '标签命中'],
            ['cat', '分类目录'],
            ['section', '目录']
        ];
        var html = '';
        GROUP_ORDER.forEach(function (g) {
            var key = g[0];
            var list = groups[key];
            if (!list.length) return;
            html += grpOpen(key, g[1], list.length);
            list.slice(0, shownCount[key] === undefined ? list.length : shownCount[key]).forEach(function (r) {
                html += rowHtml(key, r);
            });
            var label = moreLabel(key);
            if (label) html += '<button class="more" type="button" data-g="' + key + '">' + label + '</button>';
            html += '</div>';
        });

        if (!titleHits.length && !tagHits.length && !sectionHits.length && !catHits.length) {
            html += '<div class="empty">没有结果，换个关键词试试</div>';
        }

        // 正文段固定排在元数据段之后；正文结果到位后一次性填入，不就地重排
        html += '<div class="body-slot"></div>';
        resultsEl.innerHTML = html;
        bodySlot = $('.body-slot', resultsEl);

        metaTotal = titleHits.length + tagHits.length + sectionHits.length + catHits.length;
        announce(metaTotal);
        ensureBodyIndex();
        bodyKey = q + '|' + selectedCat + '|' + (IDX.ascii ? 1 : 0) + '|' + (IDX.cn ? 1 : 0);
        runBody(q, ++bodySeq);
    }

    function announce(total) {
        if (composing) return;
        if (!statusEl) return;
        clearTimeout(announceTimer);
        announceTimer = setTimeout(function () {
            statusEl.textContent = total ? ('找到 ' + total + ' 条结果') : '没有找到结果';
        }, 400);
    }

    function updateFade() {
        if (!catsEl || !catsWrap) return;
        var canScroll = catsEl.scrollLeft + catsEl.clientWidth < catsEl.scrollWidth - 1;
        catsWrap.classList.toggle('more-right', canScroll);
    }

    function open() {
        scrim.classList.add('on');
        panel.classList.add('on');
        setTimeout(function () { if (sinput) sinput.focus(); }, 0);
        syncSoftKb();
        // 加载失败时保留 loadIndex 写入的重试提示，不要被空态渲染盖掉
        revalidate().then(function () { if (meta) render(sinput.value); });
    }
    function close() {
        scrim.classList.remove('on');
        panel.classList.remove('on');
        panel.classList.remove('kb');
        // 回到真正打开面板的那个入口：桌面入口在 ≤1023px 是 display:none，聚焦不上
        if (lastTrigger) lastTrigger.focus();
    }

    var initialized = false;

    function init() {
        // 幂等：脚本被重复引入或 DOMContentLoaded 被重复派发时不能重复绑定（派生事件监听会成对触发）
        if (initialized) return;
        initialized = true;
        scrim = $('.scrim'); panel = $('.panel');
        entries = Array.prototype.slice.call(document.querySelectorAll('.search-entry'));
        sinput = $('.sinput'); xbtn = $('.xbtn');
        catsWrap = $('.cats-wrap');
        catsEl = $('.cats');
        resultsEl = $('.results');
        statusEl = $('p.sr-only[aria-live="polite"]') || $('.sr-only[aria-live="polite"]');
        entries.forEach(function (btn) {
            btn.addEventListener('click', function () { lastTrigger = btn; open(); });
            btn.addEventListener('keydown', function () { lastTrigger = btn; });
        });
        if (scrim) scrim.addEventListener('click', close);
        if (xbtn) xbtn.addEventListener('click', close);
        // PC 档键盘：↑↓ 在结果间移动焦点，Enter 交给原生链接/按钮；大屏与手机档只留 Esc
        var PC_MQ = w.matchMedia('(min-width: 1024px)');
        function moveFocus(step) {
            var nodes = Array.prototype.slice.call(
                resultsEl.querySelectorAll('a.item, .sec-toggle, .more, a.sec')
            ).filter(function (n) { return n.offsetParent !== null; });
            if (!nodes.length) return false;
            var i = nodes.indexOf(document.activeElement);
            nodes[Math.min(nodes.length - 1, Math.max(0, i < 0 ? 0 : i + step))].focus();
            return true;
        }
        document.addEventListener('keydown', function (e) {
            if (!panel || !panel.classList.contains('on')) return;
            if (e.key === 'Escape') { close(); return; }
            if (!PC_MQ.matches) return;
            if (e.key === 'ArrowDown' && moveFocus(1)) e.preventDefault();
            else if (e.key === 'ArrowUp' && moveFocus(-1)) e.preventDefault();
            else if (e.key === 'Enter' && document.activeElement === sinput) {
                if (moveFocus(0)) e.preventDefault();
            }
        });
        if (sinput) {
            sinput.addEventListener('input', function () { render(sinput.value); });
            sinput.addEventListener('compositionstart', function () { composing = true; });
            sinput.addEventListener('compositionend', function () { composing = false; render(sinput.value); });
        }
        if (resultsEl) {
            // 结果区统一事件委托：展开小节 / 折叠段 / 加载更多
            resultsEl.addEventListener('click', function (e) {
                var target = e.target;
                var head = target.closest ? target.closest('.ghead') : null;
                if (head) { toggleGroup(head); return; }
                var more = target.closest ? target.closest('.more') : null;
                if (more) { loadMore(more.getAttribute('data-g')); return; }
                var btn = target.closest ? target.closest('.sec-toggle') : null;
                if (!btn) return;
                var secs = btn.nextElementSibling;
                if (!secs || !secs.classList.contains('secs')) return;
                var open = btn.getAttribute('aria-expanded') === 'true';
                btn.setAttribute('aria-expanded', open ? 'false' : 'true');
                secs.hidden = open;
            });
            resultsEl.addEventListener('keydown', function (e) {
                var head = e.target.closest ? e.target.closest('.ghead') : null;
                if (!head) return;
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    toggleGroup(head);
                }
            });
        }
        if (catsEl) {
            catsEl.addEventListener('scroll', updateFade);
            // PC 鼠标只有竖轮：真能横滚时把竖轮映射成横向滚动
            catsEl.addEventListener('wheel', function (e) {
                if (!PC_MQ.matches || e.deltaY === 0 || e.deltaX !== 0) return;
                if (catsEl.scrollWidth <= catsEl.clientWidth) return;
                e.preventDefault();
                catsEl.scrollLeft += e.deltaY;
            }, { passive: false });
            updateFade();
            w.addEventListener('resize', updateFade);
        }
        if (w.visualViewport) {
            w.visualViewport.addEventListener('resize', syncSoftKb);
            w.visualViewport.addEventListener('scroll', syncSoftKb);
        }
        w.addEventListener('resize', syncSoftKb);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    w.SearchPanel = { open: open, close: close };
})(window);
