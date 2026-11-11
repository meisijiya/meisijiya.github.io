/*
 * 助手可调用的工具
 *
 * 工具是「按需加载内容」的唯一入口：模型想看哪一节正文、想找哪篇文章，
 * 都必须显式调用工具取回来。这样注入的 token 始终可控，模型也不会凭空编内容。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var MAX_SECTION_CHARS = 5000;
    var MAX_LIST_ITEMS = 20;
    var MAX_OUTLINE_ITEMS = 80;
    /* 索引格式变更只提示一次，避免每次跨文章读取都刷一条 */
    var shardWarned = false;

    function currentUrl() {
        return window.location.pathname;
    }

    /* 截断后总长不超过 limit，否则「最多 5000 字」的约定会被尾巴撑破 */
    function truncate(text, limit) {
        var value = text || '';
        if (value.length <= limit) return value;
        var marker = '\n（内容过长，已截断）';
        return value.slice(0, Math.max(0, limit - marker.length)) + marker;
    }

    function matchSection(sections, keyword) {
        if (!keyword) return null;
        var needle = keyword.trim().toLowerCase();
        var exact = null;
        var loose = null;
        for (var i = 0; i < sections.length; i++) {
            var title = sections[i].title.toLowerCase();
            if (title === needle) { exact = sections[i]; break; }
            if (!loose && (title.indexOf(needle) >= 0 || needle.indexOf(title) >= 0)) loose = sections[i];
            if (!loose && sections[i].id && sections[i].id.toLowerCase() === needle) loose = sections[i];
        }
        return exact || loose;
    }

    /* 先按 id 精确命中，再退回标题片段匹配 */
    function matchHeading(outline, keyword) {
        if (!keyword) return null;
        var needle = keyword.trim().toLowerCase();
        for (var i = 0; i < outline.length; i++) {
            if (outline[i].id && outline[i].id.toLowerCase() === needle) return outline[i];
        }
        return matchSection(outline, keyword);
    }

    function listArticles(args) {
        var keyword = ((args && args.keyword) || '').trim().toLowerCase();
        return AI.search.loadIndex().then(function (index) {
            var docs = index.docs.filter(function (doc) {
                if (!keyword) return true;
                var haystack = (doc.title + ' ' + (doc.categories || []).join(' ') + ' ' + (doc.tags || []).join(' ') + ' ' + (doc.summary || '')).toLowerCase();
                return haystack.indexOf(keyword) >= 0;
            });
            var items = docs.slice(0, MAX_LIST_ITEMS).map(function (doc) {
                return {
                    url: doc.url,
                    title: doc.title,
                    categories: doc.categories,
                    date: doc.date,
                    summary: (doc.summary || '').slice(0, 80)
                };
            });
            var payload = { total: docs.length, items: items };
            // 关键词过滤没命中时给下一步：换词或去掉过滤条件
            if (!items.length) {
                payload.suggestion = keyword
                    ? '没有文章命中关键词「' + keyword + '」：换一个关键词或同义词，或者去掉 keyword 列出全部文章。'
                    : '站内没有可列出的文章：确认索引是否已加载，或改用 search_articles 检索。';
            }
            return payload;
        });
    }

    function searchArticles(args) {
        var query = ((args && args.query) || '').trim();
        if (!query) {
            return Promise.resolve({
                query: query,
                items: [],
                note: '缺少查询词。',
                suggestion: '补一个关键词或同义词重查，或者先用 list_articles 看看站内有哪些文章再检索。'
            });
        }
        return AI.search.search(query, { limit: 5, withModel: true }).then(function (result) {
            var items = result.items.map(function (doc) {
                return {
                    url: doc.url,
                    title: doc.title,
                    categories: doc.categories,
                    date: doc.date,
                    summary: (doc.summary || '').slice(0, 120)
                };
            });
            var payload = {
                query: query,
                expandedTerms: result.expanded,
                items: items
            };
            // 检索没命中时，把「换个词 / 先缩小范围」写进结果里：
            // 只回一句「没有结果」，模型只会把同一个查询原样再发一遍
            if (!items.length) {
                payload.suggestion = '换一个关键词或同义词重查，或先用 list_articles 缩小范围再检索，不要把同一个调用原样再发一遍。';
            }
            return payload;
        });
    }

    /*
     * 第一步：不给 section，只给标题目录。
     * 这一步一个正文字都不给，模型先看结构、再决定读哪一节。
     */
    function outlineResponse(outline, url, articleTitle) {
        var items = outline;
        var note = '先选一个标题';
        if (items.length > MAX_OUTLINE_ITEMS) {
            items = items.slice(0, MAX_OUTLINE_ITEMS);
            note = '先选一个标题（标题目录过长，只列前 ' + MAX_OUTLINE_ITEMS + ' 个）';
        }
        return {
            note: note,
            outline: items.map(function (item) {
                return { title: item.title, level: item.level };
            }),
            url: url,
            articleTitle: articleTitle,
            hint: '带上 section 参数再取该标题正文'
        };
    }

    /*
     * 第二步：带上 section，取该标题的直属正文。
     * 正文只含这一层的内容，子标题的正文靠 children 再往下取。
     */
    function sectionResponse(url, articleTitle, detail) {
        var body = detail.ownText || '';
        var res = {
            url: url,
            articleTitle: articleTitle,
            section: detail.title,
            path: detail.path,
            text: truncate(body, MAX_SECTION_CHARS),
            children: detail.children.map(function (child) {
                return { title: child.title, level: child.level };
            }),
            maxChars: MAX_SECTION_CHARS
        };
        if (body.length > MAX_SECTION_CHARS) res.truncated = true;
        return res;
    }

    /* 匹配不到：把可用标题摆出来，模型换标题重试，读者也能看懂为什么空 */
    function missResponse(outline, url, articleTitle) {
        var titles = outline.map(function (item) { return item.title; });
        var note = '没有匹配到小节。下面是可用的候选标题，换一个更接近的标题重查。';
        if (titles.length > MAX_OUTLINE_ITEMS) {
            titles = titles.slice(0, MAX_OUTLINE_ITEMS);
            note = '没有匹配到小节。下面是可用的候选标题，换一个更接近的标题重查（只列前 ' + MAX_OUTLINE_ITEMS + ' 个）。';
        }
        return {
            url: url,
            articleTitle: articleTitle,
            note: note,
            headings: titles,
            suggestion: '换一个更接近的标题重查，不要把同一个调用原样再发一遍。'
        };
    }


    /* 统计子串出现次数：query 定位按它排序，不区分大小写由调用方先转好 */
    function countOccurrences(text, needle) {
        if (!text || !needle) return 0;
        var count = 0;
        var from = 0;
        while (true) {
            var at = text.indexOf(needle, from);
            if (at < 0) break;
            count += 1;
            from = at + needle.length;
        }
        return count;
    }

    /*
     * 本篇按词定位：扫整篇所有小节，标题命中优先，其次正文出现次数。
     * 纯本地、0 网络：DOM 已经在内存里，读者问的多半就是这一篇里的词。
     */
    function locateInArticle(query) {
        var needle = String(query || '').trim().toLowerCase();
        if (!needle) return [];
        var outline = AI.context.outline();
        var hits = [];
        for (var i = 0; i < outline.length; i++) {
            var item = outline[i];
            var detail = AI.context.sectionOutline(item.id);
            if (!detail) continue;
            var title = String(item.title || '').toLowerCase();
            var titleHit = title.indexOf(needle) >= 0;
            var count = countOccurrences(String(detail.ownText || '').toLowerCase(), needle);
            if (!titleHit && !count) continue;
            hits.push({ item: item, detail: detail, titleHit: titleHit, count: count, order: i });
        }
        hits.sort(function (a, b) {
            if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
            if (b.count !== a.count) return b.count - a.count;
            return a.order - b.order;
        });
        return hits;
    }

    /* 命中：回第一个命中小节的直属正文，其余命中标题摆出来供追问 */
    function locatedResponse(url, articleTitle, hits, query) {
        var first = hits[0];
        var res = sectionResponse(url, articleTitle, first.detail);
        res.query = query;
        res.note = '本篇按「' + query + '」定位命中「' + first.item.title + '」';
        if (hits.length > 1) {
            res.candidates = hits.slice(1, 6).map(function (hit) { return hit.item.title; });
        }
        return res;
    }

    /* 未命中：给出可用标题，模型换词重查，读者也能看懂为什么空 */
    function locateMissResponse(outline, url, articleTitle, query) {
        var titles = outline.map(function (item) { return item.title; }).slice(0, MAX_OUTLINE_ITEMS);
        return {
            url: url,
            articleTitle: articleTitle,
            query: query,
            note: '本篇没有出现「' + query + '」。下面是本文的小节标题，可以换一个更接近的词，或改用 search_articles 查全站。',
            headings: titles,
            suggestion: '换成本文里的原词重查，或用 search_articles 查其他文章。'
        };
    }

    function readSection(args) {
        var url = ((args && args.url) || '').trim();
        var keyword = ((args && args.section) || '').trim();
        var isCurrent = !url || url === currentUrl();

        if (isCurrent) {
            var outline = AI.context.outline();
            if (!outline.length) {
                return Promise.resolve({
                    note: '当前页面没有可读取的文章正文。',
                    url: currentUrl(),
                    suggestion: '当前页取不到正文：先用 search_articles 找到文章 url，再对那个 url 调用 read_section（先不带 section 拿目录）。'
                });
            }
            var articleTitle = AI.context.articleTitle();
            var query = ((args && args.query) || '').trim();
            /* 显式给了标题就按标题走；否则先用 query 在本篇定位 */
            if (!keyword && query) {
                var located = locateInArticle(query);
                if (located.length) return Promise.resolve(locatedResponse(currentUrl(), articleTitle, located, query));
                return Promise.resolve(locateMissResponse(outline, currentUrl(), articleTitle, query));
            }
            if (!keyword) {
                return Promise.resolve(outlineResponse(outline, currentUrl(), articleTitle));
            }
            var hit = matchHeading(outline, keyword);
            if (!hit) {
                return Promise.resolve(missResponse(outline, currentUrl(), articleTitle));
            }
            var detail = AI.context.sectionOutline(hit.id);
            if (!detail) {
                return Promise.resolve(missResponse(outline, currentUrl(), articleTitle));
            }
            return Promise.resolve(sectionResponse(currentUrl(), articleTitle, detail));
        }

        /*
         * 跨文章优先读主题侧分片：{i,t,l,x} 正好是小节锚点、标题、级别与直属正文，
         * 省掉整页 HTML 与一次 DOM 解析。格式变了才退回整页 HTML。
         */
        return AI.search.loadArticle(url).then(function (article) {
            var outline = outlineFromSections(article.sections);
            if (!keyword) return outlineResponse(outline, url, article.title);
            var hit = matchHeading(outline, keyword);
            if (hit) {
                var hitDetail = detailFromSections(article.sections, hit.id);
                if (hitDetail) return sectionResponse(url, article.title, hitDetail);
                return missResponse(outline, url, article.title);
            }
            /*
             * 标题没命中：在正文里找关键词。分片里有每节的直属正文，
             * 跨文章调用带 query 时不该只回目录——模型要的是定位到具体小节。
             */
            var best = null;
            var bestCount = 0;
            for (var si = 0; si < article.sections.length; si++) {
                var sec = article.sections[si];
                if (!sec.i) continue;
                var hits = countOccurrences(String(sec.x || '').toLowerCase(), keyword.toLowerCase());
                if (hits > bestCount) { bestCount = hits; best = sec; }
            }
            if (best) {
                var bodyDetail = detailFromSections(article.sections, best.i);
                if (bodyDetail) return sectionResponse(url, article.title, bodyDetail);
            }
            return missResponse(outline, url, article.title);
        }).catch(function (err) {
            /*
             * 只有「索引格式变了」才提示一次：主题与助手是两个独立发布的子模块，
             * 格式对不上时不能静默变慢，也不能每次都弹。其余错误继续静默兜底。
             */
            var changed = /格式已变/.test(String(err && err.message));
            var fallback = readFromHtml(url, keyword);
            if (!changed || shardWarned) return fallback;
            shardWarned = true;
            return fallback.then(function (res) {
                if (res) {
                    res.note = (res.note ? res.note + '；' : '') + '站内索引格式已变，本次改用整页读取';
                }
                return res;
            });
        });
    }

    /* 分片里的小节数组就是目录：锚点、标题、级别都在，无需再抓页面 */
    function outlineFromSections(sections) {
        var outline = [];
        for (var i = 0; i < sections.length; i++) {
            var sec = sections[i];
            if (!sec.i) continue;
            outline.push({ id: sec.i, title: sec.t, level: sec.l });
        }
        return outline;
    }

    /*
     * 由分片算「直属正文 + 子标题」：ownText 就是 x；
     * 子标题是紧随其后、级别更大的一串；标题路径由向上更低级别的标题拼出。
     */
    function detailFromSections(sections, id) {
        var at = -1;
        for (var i = 0; i < sections.length; i++) {
            if (sections[i].i === id) { at = i; break; }
        }
        if (at < 0) return null;
        var current = sections[at];
        var children = [];
        for (var j = at + 1; j < sections.length; j++) {
            if (!sections[j].i) continue;
            if (sections[j].l <= current.l) break;
            children.push({ title: sections[j].t, level: sections[j].l });
        }
        var path = [];
        var level = current.l;
        for (var k = at - 1; k >= 0; k--) {
            var sec = sections[k];
            if (!sec.i) continue;
            if (sec.l < level) {
                path.unshift(sec.t);
                level = sec.l;
            }
        }
        path.push(current.t);
        return { title: current.t, path: path, ownText: current.x || '', children: children };
    }

    /* 兜底：分片取不到（索引升级、文章不在索引里）时仍能读整页 HTML */
    function readFromHtml(url, keyword) {
        return fetch(url, { credentials: 'same-origin' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        }).then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var container = doc.querySelector('.post-content');
            if (!container) throw new Error('该页面没有文章正文容器');
            var titleEl = doc.querySelector('.post-title') || doc.querySelector('h1');
            var articleTitle = titleEl ? titleEl.textContent.trim() : '';
            var outline = AI.context.outlineOf(container);
            if (!keyword) return outlineResponse(outline, url, articleTitle);
            var hit = matchHeading(outline, keyword);
            if (!hit) return missResponse(outline, url, articleTitle);
            var detail = AI.context.sectionOutlineOf(container, hit.id, articleTitle);
            if (!detail) return missResponse(outline, url, articleTitle);
            return sectionResponse(url, articleTitle, detail);
        });
    }

    var DEFINITIONS = [
        {
            name: 'list_articles',
            description: '列出博客文章的目录。用于回答「有哪些文章」「某某分类下有什么」这类问题。返回 url、标题、分类、日期与摘要。',
            parameters: {
                type: 'object',
                properties: {
                    keyword: { type: 'string', description: '可选关键词，用于按标题、分类、标签或摘要过滤' }
                },
                required: []
            }
        },
        {
            name: 'search_articles',
            description: '在全站文章中做语义检索，返回最相关的若干篇文章（标题、分类、摘要、链接）。回答「某某东西在哪篇文章讲过」时使用；先检索拿到候选，再调用 read_section 取正文，不要只把标题当答案。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索词或问题' }
                },
                required: ['query']
            }
        },
        {
            name: 'read_section',
            description: '读取某篇文章里某个小节的正文，分两步走：第一步不带 section（section 留空），只拿回这篇文章的标题目录，不含任何正文；第二步带上 section（标题 id 或标题片段），取回该标题的直属正文，并附带它的直接子标题 children。需要更深的内容，就按 children 里的子标题继续调用，一次只下钻一层。返回的正文只含该标题自己下面的内容，父标题正文不含子标题正文，所以一篇长文永远不会被整篇灌进上下文。url 留空表示当前文章。section 必须是真实存在的标题：不确定时先用 search_articles 找到文章，再用不带 section 的调用拿目录，不要凭猜测填标题。',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: '文章链接，形如 /2026/04/17/.../；留空表示当前文章' },
                    section: { type: 'string', description: '小节标题或标题片段；留空则只返回标题目录' },
                    query: { type: 'string', description: '要定位的词或短句：在本篇所有小节里找，标题命中优先，其次正文出现次数；命中就回该小节直属正文' }
                },
                required: []
            }
        }
    ];

    /*
     * 工具失败也要给模型一条能走的路：
     * 只回一句错误信息，模型多半会把同一个调用原样再发一遍。
     * 这里统一把失败包成 { error, suggestion }，由主流程压成给模型看的文本。
     */
    function failureResult(err, name) {
        var message = String(err && err.message ? err.message : err);
        var suggestion;
        if (name === 'read_section') {
            suggestion = 'url 不对或页面取不到：先用 search_articles 找到文章 url，再用不带 section 的 read_section 拿目录。';
        } else if (name === 'search_articles') {
            suggestion = '检索本身失败：换一个更短的关键词重试，或先用 list_articles 看站内有哪些文章。';
        } else {
            suggestion = '换一个工具或换参数重试，不要把同一个调用原样再发一遍。';
        }
        return { error: message, suggestion: suggestion };
    }

    AI.tools = {
        definitions: function () {
            return DEFINITIONS;
        },
        execute: function (name, args) {
            var promise;
            try {
                if (name === 'list_articles') promise = listArticles(args);
                else if (name === 'search_articles') promise = searchArticles(args);
                else if (name === 'read_section') promise = readSection(args);
                else return Promise.resolve(failureResult(new Error('未知工具：' + name), name));
            } catch (err) {
                return Promise.resolve(failureResult(err, name));
            }
            // 跨文章 fetch 之类的失败是异步抛的，只 catch 同步异常会漏掉
            return Promise.resolve(promise).catch(function (err) {
                return failureResult(err, name);
            });
        }
    };
})();
