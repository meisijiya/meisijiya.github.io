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

    /* 工具面没有删除能力：删除不可撤销，走面板 UI（见 47-tasks.js 的 remove） */

    /* 清单条目精简成「标识、标题、状态、时长」：清单工具的返回值计入注入预算 */
    function taskItem(item) {
        var res = { id: item.id, kind: item.kind, title: item.title, status: item.status };
        // 层级要回给模型：不加 parentId 它没法在同一棵树里继续挂子条目
        if (item.parentId) res.parentId = item.parentId;
        var duration = AI.tasks.elapsedOf(item);
        if (duration > 0) res.durationMs = Math.round(duration);
        return res;
    }

    function listTasks(args) {
        var kind = (args && args.kind) || null;
        if (kind !== 'task' && kind !== 'todo' && kind !== null) {
            return Promise.resolve({
                items: [],
                total: 0,
                error: 'kind 只能是 task、todo 或留空',
                suggestion: '去掉 kind 看全部清单，或传 task / todo 分开看。'
            });
        }
        var all = AI.tasks.list(kind ? { kind: kind } : {});
        return Promise.resolve({
            items: all.map(taskItem),
            total: all.length
        });
    }

    function addTasks(args) {
        var input = (args && args.items) || [];
        if (!Array.isArray(input) || !input.length) {
            return Promise.resolve({
                added: 0,
                ids: [],
                error: 'items 是空的',
                suggestion: '把要加入的条目放进 items 数组（每条给 title，阅读任务另给 url），重试。'
            });
        }
        if (input.length > MAX_LIST_ITEMS) {
            return Promise.resolve({
                added: 0,
                ids: [],
                error: '一次最多添加 ' + MAX_LIST_ITEMS + ' 条',
                suggestion: '分几批添加，每批不超过 ' + MAX_LIST_ITEMS + ' 条。'
            });
        }
        /*
         * 一次调用建树：条目可以带 ref（本次调用内的临时名），子条目用 parentRef 指向它。
         * 模型拿不到「还没创建的条目的 id」，不给临时名就只能先 add 再 list 再补一轮，
         * 而写预算只有 3 轮。
         */
        var refMap = {};
        var staged = [];
        for (var i = 0; i < input.length; i++) {
            var row = input[i] || {};
            var parentId = '';
            if (row.parentRef) {
                parentId = refMap[row.parentRef] || '';
            } else if (row.parentId) {
                parentId = String(row.parentId);
            }
            var created = AI.tasks.add({
                kind: row.kind === 'todo' ? 'todo' : 'task',
                title: row.title,
                url: row.url,
                categories: row.categories,
                durationMs: row.durationMs,
                status: row.status,
                parentId: parentId,
                source: 'ai'
            });
            if (!created) {
                staged.push(null);
                continue;
            }
            if (row.ref) refMap[String(row.ref)] = created.id;
            staged.push(created);
        }
        var okItems = staged.filter(function (one) { return !!one; });
        var result = { added: okItems.length, ids: okItems.map(function (one) { return one.id; }) };
        var added = result.added;
        var payload = { added: added, ids: result.ids };
        if (added < input.length) {
            payload.note = '有 ' + (input.length - added) + ' 条没通过校验（标题为空或字段不对），已跳过。';
        }
        return Promise.resolve(payload);
    }

    function suggestReading(args) {
        return (AI.suggest && AI.suggest.load ? AI.suggest.load() : Promise.reject(new Error('suggest 模块未加载')))
            .then(function (data) {
                var raw = (data && Array.isArray(data.items)) ? data.items : [];
                var items = raw.slice(0, MAX_LIST_ITEMS).map(function (it) {
                    return {
                        title: it.title,
                        url: it.url,
                        categories: Array.isArray(it.categories) ? it.categories : [],
                        durationMs: (AI.suggest && AI.suggest.estimate) ? AI.suggest.estimate(it) : 300000
                    };
                });
                if (AI.suggest && typeof AI.suggest.showCard === 'function') {
                    try { AI.suggest.showCard(items); } catch (e) { /* UI 未挂载时忽略 */ }
                }
                return { items: items };
            })
            .catch(function (err) {
                return { items: [], error: String(err && err.message ? err.message : err), suggestion: '先跑 hexo generate 生成阅读清单，再重试。' };
            });
    }

    function completeTask(args) {
        var id = ((args && args.id) || '').trim();
        if (!id) {
            return Promise.resolve({
                id: '',
                done: false,
                error: '缺少 id',
                suggestion: '先用 list_tasks 拿到条目的 id，再带 id 调 complete_task。'
            });
        }
        var item = AI.tasks.get(id);
        if (!item) {
            return Promise.resolve({
                id: id,
                done: false,
                error: '清单里没有这个 id',
                suggestion: '先用 list_tasks 核对 id 是否真实存在，不要把同一个 id 原样再发一遍。'
            });
        }
        var done = !!(args && args.done);
        var updated = AI.tasks.complete(id, done);
        if (!updated) {
            return Promise.resolve({
                id: id,
                done: item.status === 'done',
                error: '当前状态是 ' + item.status + '，不能直接改成 ' + (done ? 'done' : 'todo'),
                suggestion: '已完成与未完成之间可来回切换；先确认条目当前的状态。'
            });
        }
        return Promise.resolve({ id: id, done: updated.status === 'done' });
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
        },
        {
            name: 'list_tasks',
            description: '只读列出访客的清单（阅读任务与待办是同一张表，用 kind 区分）。kind 留空列出全部，kind="task" 只看带站内链接的阅读任务，kind="todo" 只看访客自己写的待办。返回每条的标识、标题、状态与已用时长，不含正文。用于回答「我今天要读什么」「清单里还有哪些没读」这类问题。',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', description: '可选：task（阅读任务）或 todo（待办）；留空列出全部' }
                },
                required: []
            }
        },
        {
            name: 'add_tasks',
            description: '把一批条目加入访客的清单。items 每条给 title（标题），阅读任务另给 url（站内链接）与可选 categories、durationMs（预估时长，毫秒）；kind 默认 task。重要：未得到访客明确要求时只给建议、不得直接调本工具——先把要加的清单摆给访客看，等访客点头再落盘；访客说「都加上」「加吧」之后才调。完成可撤销，本工具面没有删除能力：清单条目只能由访客在面板里处理。要表达「先做这一步、再往下做这几步」时用层级：给条目 ref（临时名），子条目用 parentRef 指向它，一次调用就能建出树；挂到已有条目下用 parentId。层级最多 4 层，更深的拆成并列父条目。',
            parameters: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        description: '要加入的条目列表',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string', description: '标题（必填）' },
                                url: { type: 'string', description: '站内链接，阅读任务用；待办不要给' },
                                categories: { type: 'array', items: { type: 'string' }, description: '可选：文章分类' },
                                durationMs: { type: 'number', description: '可选：预估阅读时长（毫秒）' },
                                parentId: { type: 'string', description: '可选：父条目标识（来自 list_tasks）；要挂在本次新建的条目下时改用 parentRef' },
                                ref: { type: 'string', description: '可选：本次调用内的临时名，供子条目的 parentRef 引用' },
                                parentRef: { type: 'string', description: '可选：父条目的临时名（同一次调用里另一个条目的 ref）' }
                            },
                            required: ['title']
                        }
                    }
                },
                required: ['items']
            }
        },
        {
            name: 'complete_task',
            description: '标记清单条目完成或撤销完成。done=true 标完成，done=false 撤销（回到未完成）。只按标识操作，先用 list_tasks 拿到真实的 id。完成可以撤销；本工具面没有删除能力，不要试图删除清单条目。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '条目标识，来自 list_tasks' },
                    done: { type: 'boolean', description: 'true 标完成，false 撤销完成' }
                },
                required: ['id', 'done']
            }
        },
        {
            name: 'suggest_reading',
            description: '只读：从构建期阅读清单取一份阅读建议候选，返回 {items:[{title,url,categories,durationMs}]}。只给建议、不落盘：未得到访客明确要求时不得调用 add_tasks——先把建议摆给访客看，等访客说「都加上」「加吧」再落盘；访客说「跳过」就丢弃。清单类工具，0 次模型往返。',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        {
            name: 'update_memory',
            description: '把读者明说过的事实写进「读者画像」（她对你的记忆）：你是在替读者记她自己说过的话，比如「我喜欢短答」「我在准备软件测试实习面试」「我关心 Redis 缓存」。用法：entries 是一组键值对，key 用短名词（偏好 / 正在准备 / 关心……），value 写读者原话里的事实；text 可选，是一段说明性文字，整体作为一条记录写入。只写读者明确说过的内容：推断出来的要以「推断：」开头写清，读者可能不会认。禁止写入密码、密钥、身份证号、住址、电话、邮箱、第三方（他人）的私密数据、健康与医疗细节——这类内容会被直接拒写，不要尝试。也不要写「称呼」（叫读者笨蛋是固定行为，不进画像）。返回 {memory, changed, chars}：memory 是当前全部画像条目，changed 表示这次写入有没有改变内容（哈希一致就是没变），chars 是当前总字数（上限 400，超限会整体拒绝、不会截断；超限时返回里带 entries 现有条目，先合并压缩再整批重写）。读者手改过的条目带保护标记，写入会被跳过并在返回的 skipped 里列出，不要重复尝试覆盖。不要用它记录临时任务或检索结果——那属于清单与检索工具。',
            parameters: {
                type: 'object',
                properties: {
                    entries: {
                        type: 'array',
                        description: '要写入的画像条目，每条 {key, value}；同 key 覆盖',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', description: '短名词，如「偏好」「正在准备」' },
                                value: { type: 'string', description: '读者说过的事实，保持原意' }
                            },
                            required: ['key', 'value']
                        }
                    },
                    text: { type: 'string', description: '可选：整段说明文字，作为一条记录写入画像' }
                },
                required: ['entries']
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

    /*
     * 写画像：助手替读者记她自己说过的话，不需要读者点头。
     * 拒写的原因要写进返回里（超限 / 敏感 / 保护条目），模型据此自己改写重写。
     */
    function updateMemory(args) {
        var input = args || {};
        var entries = [];
        var list = Array.isArray(input.entries) ? input.entries : [];
        for (var i = 0; i < list.length; i++) {
            var one = list[i] || {};
            var key = String(one.key == null ? '' : one.key).trim();
            if (!key) continue;
            entries.push({ key: key, value: String(one.value == null ? '' : one.value) });
        }
        var text = String(input.text == null ? '' : input.text).trim();
        if (text) entries.push({ key: '补充', value: text });

        if (!entries.length) {
            return Promise.resolve({
                error: '没有可写入的条目',
                suggestion: 'entries 至少给一条 {key, value}；没有内容就不要调这个工具。',
                memory: AI.memory ? AI.memory.get() : { entries: [] },
                changed: false,
                chars: AI.memory ? AI.memory.chars() : 0
            });
        }

        var result = AI.memory.apply(entries, { source: 'ai' });
        if (!result.ok) {
            var payload = {
                error: '',
                suggestion: '',
                memory: result.memory,
                changed: false,
                chars: result.chars
            };
            if (result.reason === 'over-limit') {
                payload.error = '画像超出 ' + result.limit + ' 字上限，本次没有写入';
                payload.suggestion = '先看返回里的 entries（现有条目），把能合并的合并、能缩短的缩短，再整批重写一次；不要自己截断内容，也不要只加不删。';
                payload.chars = result.chars;
                // 超限时要让模型看到现有条目，否则「压缩后重写」只是空话
                payload.entries = result.entries || (result.memory && result.memory.entries) || [];
                payload.limit = result.limit;
            } else if (result.reason === 'sensitive') {
                var cats = [];
                for (var h = 0; h < result.hits.length; h++) {
                    cats.push(result.hits[h].key + '（' + result.hits[h].categories.join('/') + '）');
                }
                payload.error = '以下内容属于敏感信息，没有写入：' + cats.join('、');
                payload.suggestion = '去掉敏感信息再写，或者干脆不记这条；不要换一种说法再试。';
            } else {
                payload.error = '没有写入任何条目';
                payload.suggestion = '检查 entries 的形状：每条要有 key 与 value。';
            }
            return Promise.resolve(payload);
        }

        var out = {
            memory: result.memory,
            changed: !!result.changed,
            chars: result.chars,
            written: result.written
        };
        if (result.skipped && result.skipped.length) {
            out.skipped = result.skipped;
            out.note = '以下条目是读者自己改过的，已跳过没有覆盖：' + result.skipped.join('、');
        }
        return Promise.resolve(out);
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
                else if (name === 'list_tasks') promise = listTasks(args);
                else if (name === 'add_tasks') promise = addTasks(args);
                else if (name === 'complete_task') promise = completeTask(args);
                else if (name === 'suggest_reading') promise = suggestReading(args);
                else if (name === 'update_memory') promise = updateMemory(args);
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
