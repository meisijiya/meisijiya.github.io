/*
 * 助手主流程
 *
 * 负责三件事：
 *   1. 配置：Provider 协议、Base URL、密钥、模型、系统提示词预设，全部存本机 localStorage
 *   2. 对话：把「当前读到的小节 + 标题路径 + 目录」作为上下文喂给模型，
 *      需要正文时让模型自己调 read_section，按需取，不整篇塞
 *   3. 划词：选中正文就冒出「问 AI」气泡，把选中的片段作为引用挂到上下文
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var STORAGE_KEY = 'ai-assistant.config';
    var MAX_TOOL_ROUNDS = 3;
    var MAX_INJECTED_CHARS = 12000;
    var SECTION_CHARS = 1200;
    var HEADINGS_LIMIT = 80;

    /*
     * 预设只调语气，不定人设、也不限字数：
     * 人设由 buildSystemPrompt 的 base 给，字数上限会和「写明出自哪篇哪一节」打架，
     * 模型多半为了压字数把出处砍掉。
     */
    var PRESETS = [
        {
            id: 'default',
            name: '默认讲解',
            prompt: '语气：先给结论，再按「是什么、为什么、怎么用」展开。'
        },
        {
            id: 'interview',
            name: '面试视角',
            prompt: '语气：按面试官口吻——先给追问点，再给标准答案和常见翻车点，句子短，不要铺垫。'
        },
        {
            id: 'source',
            name: '源码视角',
            prompt: '语气：从实现细节讲问题——先讲数据流与调用链，再给结论，涉及代码时给出关键片段。'
        },
        {
            id: 'plain',
            name: '通俗类比',
            prompt: '语气：先用一个日常类比讲清原理，再补技术定义，避免术语堆砌。'
        },
        {
            id: 'custom',
            name: '自定义',
            prompt: ''
        }
    ];

    var state = {
        config: {
            protocol: 'openai',
            baseUrl: '',
            apiKey: '',
            model: '',
            presetId: 'default',
            systemPrompt: PRESETS[0].prompt
        },
        messages: [],
        // 会话（聊天历史）：每个会话一份 provider 历史，内存里按 id 分开存。
        // localStorage 里只留纯文字（工具过程不进历史），刷新后按文字重建。
        histories: {},
        sessionId: null,
        useContext: true,
        quote: '',
        controller: null,
        sources: []
    };

    /* ------------------------------------------------------------ 配置存取 */

    function loadConfig() {
        var raw = null;
        try {
            raw = window.localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            /* 无痕模式等场景下 localStorage 会抛异常，忽略即可 */
            return;
        }
        if (!raw) return;
        try {
            var saved = JSON.parse(raw);
            if (saved && typeof saved === 'object') {
                Object.keys(state.config).forEach(function (key) {
                    if (typeof saved[key] === 'string') state.config[key] = saved[key];
                });
            }
        } catch (e) {
            /* 配置损坏时用默认值，别把用户挡在门外 */
        }
    }

    function saveConfig() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.config));
        } catch (e) {
            /* 存不下就算了，本次会话仍然可用 */
        }
    }

    function presetById(id) {
        for (var i = 0; i < PRESETS.length; i++) {
            if (PRESETS[i].id === id) return PRESETS[i];
        }
        return PRESETS[0];
    }

    /* ------------------------------------------------------------ 会话历史 */

    /*
     * 会话（聊天历史）与 provider 历史是两套东西：
     *  - 会话存储在 ui.js 的 AI.sessions 里，本机 localStorage，只存纯文字；
     *  - provider 历史（state.messages）是真正发给模型的消息数组，含工具块，
     *    内存里按会话 id 分开存，切走再切回来能接着上次继续；
     *  - 页面刷新后 provider 历史从存储里的纯文字重建（工具过程不跨刷新保留）。
     */

    // 正在回答时不允许换会话：这一轮的上下文属于原会话
    var sessionReverting = false;

    function providerHistory(id) {
        if (!state.histories[id]) {
            var stored = AI.sessions ? AI.sessions.getMessages(id) : [];
            var list = [];
            for (var i = 0; i < stored.length; i++) {
                list.push({
                    role: stored[i].role,
                    content: [{ type: 'text', text: stored[i].content }]
                });
            }
            state.histories[id] = list;
        }
        return state.histories[id];
    }

    function ensureSession() {
        if (!AI.sessions) return null;
        var id = AI.sessions.currentId();
        if (!id) {
            // 没有任何会话时开一条：消息不能因为没建会话而丢
            var created = AI.sessions.create();
            id = created ? created.id : AI.sessions.currentId();
        }
        if (id && state.sessionId !== id) {
            state.sessionId = id;
            state.messages = providerHistory(id);
        }
        return id;
    }

    function onSessionChange(info) {
        if (!info) return;
        // 改标题不改上下文：改名可能落在任意一条会话上，
        // 跟着切会把正在用的上下文和来源一起换掉
        if (info.reason === 'rename') return;
        var id = info.id;
        if (state.controller && !sessionReverting) {
            // 正在回答：把会话切回去，这一轮的上下文不换
            if (id !== state.sessionId) {
                sessionReverting = true;
                try {
                    AI.sessions.select(state.sessionId);
                } finally {
                    sessionReverting = false;
                }
            }
            return;
        }
        if (!id) {
            state.sessionId = null;
            state.messages = [];
        } else {
            state.sessionId = id;
            state.messages = providerHistory(id);
        }
        // 来源是这一轮读出来的，属于原会话：换会话就得清掉
        state.sources = [];
        AI.ui.setSources([]);
    }

    // 存一条会话消息（纯文字）：显示给读者的那段话
    function persistTurn(role, text) {
        if (!AI.sessions) return;
        var content = String(text || '').trim();
        if (!content) return;
        try {
            AI.sessions.appendMessage({ role: role, content: content });
        } catch (e) {
            // 存不下就算了，界面照常
        }
    }

    /* -------------------------------------------------------------- 上下文 */

    function currentContext(sectionId) {
        if (!state.useContext) return null;
        var section = AI.context.currentSection();
        var title = AI.context.articleTitle();
        if (!section && !title) return null;
        // 注入用「直属正文」（到下一个标题为止）；子标题正文要靠模型按标题再查，
        // 跟着当前小节一起塞进来就是全量注入
        var own = '';
        var haveOutline = false;
        try {
            var outline = AI.context.sectionOutline ? AI.context.sectionOutline(sectionId || AI.context.currentSectionId()) : null;
            if (outline) {
                // 空串也是合法结果：标题后面紧跟子标题时，直属正文本来就是空的
                // （例如 </h2><h3> 相邻）。这种情况回退到 section.text 等于把
                // 整棵子树又灌进提示词，所以只有「查不到这个标题」才回退
                own = outline.ownText || '';
                haveOutline = true;
            }
        } catch (err) {
            own = '';
        }
        if (!haveOutline && !sectionId && section && section.text) own = section.text;
        var text = own ? own.slice(0, SECTION_CHARS) : '';
        // 标题路径的第一级就是文章标题（h1），文章名已经单独给出一份，这里去掉重复
        var path = section ? section.path.slice() : [];
        if (path.length && title && path[0] === title) path.shift();
        return {
            article: title,
            section: path.join(' / '),
            text: text,
            headings: AI.context.listHeadings().slice(0, HEADINGS_LIMIT)
        };
    }

    /*
     * 系统提示分两层，顺序固定：稳定前缀 → 变动段 →（本轮追加引导）。
     *
     *   稳定前缀：人设、工作方式、回答要求、预设语气。同一轮会话里逐字不变，
     *     前缀缓存才能命中它；往这里插一个字，后面每一轮的前缀缓存全部作废。
     *   变动段：当前文章、当前小节、当前小节正文、本文小节目录、读者划选的片段。
     *     读者滚动或划选就会变，只能排在稳定前缀后面。
     *   追加引导：收尾催办、计划催办、策略调整这类只对本轮有效的话，
     *     由 composeSystem 挂在最末尾，永远不挤进稳定前缀。
     */
    function buildSystemLayers() {
        var stable = [
            '你是「老江湖的博客」里的 AI 阅读助手，服务于正在读这篇文章的读者。',
            '',
            '工作方式（按这个顺序做）：',
            '1. 先判断问题需不需要站内资料。不需要就直接答，别绕工具。要查就现在调用工具，不要只说「我去找一下」就停下。',
            '2. 需要站内资料时：search_articles 找候选 → read_section 读出候选里真正相关的那几段正文。只读必要的几段（通常 1 到 3 段），别把整篇灌进来。',
            '3. 取正文要逐级下钻，不要一次性注入整篇文章：',
            '   - 先只取目录（只看标题层级），在目录里定位到目标标题；',
            '   - 再按标题取该标题的直属正文；父标题下还有子标题时，正文只取直属那部分；',
            '   - 需要更细的内容，再按子标题继续查，一次只下一层。',
            '4. 读到的正文就是你作答的事实来源：先给结论，再引用正文里的关键点，并写明出自哪篇哪一节。',
            '5. 读完够用的几段就立刻作答：不要为了「更全面」继续往下钻，答案的质量不取决于读了多少段。',
            '6. 正文没读到就直说没读到，不许只罗列链接或标题冒充答案。',
            '7. 找不到就说找不到，并列出可能相关的标题供读者自己判断。',
            '8. 工具没拿到内容时不要原样重复同一个调用：先看结果里给的候选标题或替代建议，换一个更接近的标题、换一个关键词重查，或者停下来用已经读到的内容作答。',
            '',
            '回答要求：',
            '9. 以读者当前阅读的小节为背景；用简体中文回答，代码放进代码块。',
            '10. 不要贴一长串链接：最多引用 3 篇，并说清每篇适合谁看。'
        ];

        var preset = presetById(state.config.presetId);
        if (preset.id === 'custom') {
            if (state.config.systemPrompt) {
                stable.push('', state.config.systemPrompt);
            }
        } else if (preset.prompt) {
            stable.push('', preset.prompt);
        }

        var variable = [];
        var ctx = currentContext();
        if (ctx) {
            if (ctx.article) variable.push('【当前文章】' + ctx.article);
            if (ctx.section) variable.push('【当前小节】' + ctx.section);
            if (ctx.text) variable.push('', '【当前小节正文】', ctx.text);
            if (ctx.headings && ctx.headings.length) {
                variable.push('', '【本文小节目录】');
                for (var i = 0; i < ctx.headings.length; i++) {
                    variable.push('- ' + ctx.headings[i].text);
                }
            }
        }
        if (state.quote) {
            variable.push('', '【读者划选的片段】', state.quote);
        }

        return { stable: stable.join('\n'), variable: variable.join('\n') };
    }

    /*
     * 把两层拼成当轮请求的 system。guidance 是这一轮才生效的追加引导：
     * 只挂在本轮末尾，下一轮就没有了，也不写进历史消息。
     */
    function composeSystem(guidance) {
        var layers = buildSystemLayers();
        var parts = [layers.stable];
        if (layers.variable) parts.push(layers.variable);
        var tail = (guidance || '').trim();
        if (tail) parts.push(tail);
        return parts.join('\n\n');
    }

    // 兼容旧调用：完整系统提示（稳定前缀 + 变动段），不带任何追加引导
    function buildSystemPrompt() {
        return composeSystem('');
    }

    function refreshContextBar() {
        var ctx = currentContext();
        AI.ui.setContext({
            article: ctx ? ctx.article : '',
            section: ctx ? ctx.section : '',
            quote: state.quote,
            enabled: state.useContext
        });
    }

    /* ------------------------------------------------------------ 模型调用 */

    function configForRequest() {
        return AI.provider.normalizeConfig(state.config);
    }

    function hasUsableConfig() {
        var cfg = configForRequest();
        return !!(cfg.endpoint && cfg.apiKey && cfg.model);
    }

    /* 检索层的查询改写与重排要用模型，但不能带工具，否则会绕回主循环 */
    AI.search.setModelCaller(function (prompt, options) {
        var cfg = configForRequest();
        if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
            return Promise.reject(new Error('未配置 Provider'));
        }
        var text = '';
        var iterator = AI.provider.streamChat(cfg, {
            system: '',
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        });
        return (async function () {
            for await (var ev of iterator) {
                if (ev.type === 'text') text += ev.text;
                else if (ev.type === 'error') throw new Error(ev.error.title);
            }
            return text;
        })();
    });

    function parseArgs(raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }

    function collectSources(result) {
        if (!result) return;
        var items = result.items || [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].url && !state.sources.some(function (s) { return s.url === items[i].url; })) {
                state.sources.push({ url: items[i].url, title: items[i].title, kind: 'candidate' });
            }
        }
        if (result.url && result.section) {
            // 读过正文的那条是「引用」，检索命中只是「候选」：
            // 展示上限会截断，引用必须排在前面，否则用户看到的全是没读过的候选。
            var quoted = state.sources.filter(function (s) { return s.url === result.url; })[0];
            if (quoted) {
                quoted.kind = 'quoted';
                quoted.title = result.articleTitle || quoted.title;
            } else {
                state.sources.push({
                    url: result.url,
                    title: result.articleTitle || result.section,
                    kind: 'quoted'
                });
            }
        }
    }

    /*
     * 工具结果真正进模型的内容：只留模型要用的字段。
     * 直接 JSON.stringify 整个 result 会把 outline/headings/path 全塞进去，
     * 目录步一次就是几 KB，注入预算两三轮就顶格，模型读不到正文。
     */
    function compactToolResult(result) {
        if (!result) return '';
        if (result.outline && result.outline.length) {
            // 目录步必须带 url：模型下一步按标题取正文时要回传 url，
            // 不带的话 read_section 会当成「当前文章」，正文就读串了
            var head = '文章：《' + (result.articleTitle || '') + '》\n';
            if (result.url) head += 'url: ' + result.url + '\n';
            head += '可选的小节标题（选一个再查正文）：\n' + result.outline.map(function (item) {
                return '- ' + item.title;
            }).join('\n');
            return head;
        }
        if (result.section) {
            var lines = ['文章：《' + (result.articleTitle || '') + '》'];
            if (result.url) lines.push('url: ' + result.url);
            lines.push('小节：' + result.section, '正文：', result.text || '');
            if (result.children && result.children.length) {
                lines.push('下面这些子标题还没取正文，需要更细可以继续按标题查：');
                lines.push(result.children.map(function (child) {
                    return '- ' + child.title;
                }).join('\n'));
            }
            return lines.join('\n');
        }
        if (result.items && result.items.length) {
            return '候选文章：\n' + result.items.map(function (doc) {
                var brief = doc.summary ? '：' + doc.summary.slice(0, 60) : '';
                return '- ' + doc.title + brief + '（' + (doc.url || '') + '）';
            }).join('\n');
        }
        /*
         * 工具没拿到内容时，不能只回一句「没有结果」：
         * 模型拿到无信息量的结果只会把同一个调用原样再发一遍。
         * 这里把候选标题、替代调用写进结果里，模型才知道下一步该改什么。
         */
        if (result.headings && result.headings.length) {
            var miss = ['未命中这个小节标题。下面是可用的候选标题，换一个更接近的标题重查：'];
            for (var h = 0; h < result.headings.length; h++) {
                miss.push('- ' + result.headings[h]);
            }
            if (result.suggestion) miss.push('建议：' + result.suggestion);
            return miss.join('\n');
        }
        if (result.items && !result.items.length) {
            var empty = [];
            if (result.query) {
                empty.push('检索「' + result.query + '」没有命中任何文章。');
            } else {
                empty.push('没有符合筛选条件的文章。');
            }
            empty.push(result.suggestion
                || '换一个关键词或同义词重查，或先用 list_articles 缩小范围再检索，不要把同一个调用原样再发一遍。');
            return empty.join('\n');
        }
        if (result.error) {
            return '工具执行失败：' + result.error + '\n替代调用：' + (result.suggestion
                || '换一个工具或换参数重试，不要把同一个调用原样再发一遍。');
        }
        if (result.note) return result.note + (result.suggestion ? '\n建议：' + result.suggestion : '');
        return JSON.stringify(result);
    }

    /*
     * 收尾轮兜底：这轮读过什么要留个底，
     * 模型一个字都没写出来时，至少把查到的内容列给用户，
     * 不能只留一句「已达上限」——只以工具卡收尾等于没答。
     */
    function noteFromResult(result) {
        if (!result) return '';
        if (result.section) {
            var head = '《' + (result.articleTitle || '') + '》· ' + result.section;
            return result.text ? head + '：' + result.text.slice(0, 80) : head;
        }
        if (result.items && result.items.length) {
            return '检索到：' + result.items.slice(0, 3).map(function (doc) {
                return doc.title;
            }).join('、');
        }
        return '';
    }

    /*
     * 收尾轮的催办话术：只挂在本轮的 system 上。
     * 措辞里不再自带前导换行——system 的分段由 composeSystem 统一负责，
     * 催办段必须永远落在最后一段，不能混进稳定前缀。
     */
    function finalNudge(reason) {
        if (reason === 'injected') {
            return '注入正文已达上限。请基于已经读到的内容给出最终回答，不要再调用工具，也不要再读新内容。';
        }
        if (reason === 'answer-now') {
            // 上一轮收尾模型还在要工具、没写字，这轮必须逼它把答案写出来
            return '现在直接输出最终答案正文。不要再请求任何工具，也不要只列清单或标题，就用已经读到的内容把答案写完。';
        }
        return '工具调用次数已用完。请基于已经读到的内容给出最终回答，不要再调用工具。';
    }

    /*
     * 工具预算快用完时逼模型换策略。
     * 模型连续展开无关小节是最常见的空转：预算耗尽，答案还是没写。
     * 这段话只对本轮有效，所以同样只进当轮 system，不进历史。
     */
    function strategyGuidance(remaining) {
        var lines = [];
        if (remaining > 0) {
            lines.push('【工具预算】只剩 ' + remaining + ' 次工具机会了。');
            lines.push('1. 只读最相关的那一节就作答，不要再展开别的章节。');
        } else {
            lines.push('【工具预算】已经用完，不会再有新的工具机会。');
            // 预算为 0 时不能再让模型去「读一节」，但要点不变：
            // 就用已经读到的那一节作答，别再展开别的
            lines.push('1. 就用已经读到的最相关的那一节作答，不要再展开别的章节。');
        }
        lines.push('2. 或者干脆停止调用工具，直接用已经读到的内容把答案写完。');
        lines.push('3. 已经读到的正文才是事实来源；没读到的地方不要编。');
        return lines.join('\n');
    }

    /*
     * 模型只说「我先去站内找找」就停了：这是兼容层上很常见的一类空转，
     * 读者看到的是一句计划而不是答案。识别出来就再给一轮，逼它真的调工具。
     * 判定要窄：只认「第一人称 + 打算查」的短句，
     * 「我先说结论」这种正常开头不能被当成计划。
     */
    function looksLikePlan(text) {
        var t = (text || '').trim();
        if (!t || t.length > 200) return false;
        var head = t.slice(0, 40);
        // 「我来」不能漏：兼容层上「我来站内找一下…」是最常见的一种空转，
        // 漏判它，读者看到的就是一句计划而不是答案
        if (!/(我先|让我|我这就|我来|稍等|我去|我准备|我打算)/.test(head)) return false;
        // 「我先说结论」「我先给你看看」这类是正常直答，不能当成计划丢掉
        if (/(结论|建议|答案|总结|因为|所以|如下|给你|为你|帮你)/.test(head)) return false;
        // 检索动词必须出现在前 40 字里：正文里随口提到「找」不算
        if (!/(查|搜|找|检索|翻|看看|看一下|读)/.test(head)) return false;
        // 带冒号的多半是正文（「我来找出根源：因为…」），别把真答案当计划丢掉
        if (head.indexOf('：') !== -1 || head.indexOf(':') !== -1) return false;
        return true;
    }

    /*
     * UI 层的新接口（过程分组、用量统计、抽屉高度）是并行加进来的：
     * 缺一个或抛错都不该影响提问本身，所以统一走这个安全调用。
     */
    function safeUi(fn, arg) {
        if (typeof fn !== 'function') return null;
        try {
            return fn(arg);
        } catch (e) {
            return null;
        }
    }

    /*
     * usage 的字段缺一块就是 null：累加时继续保持 null，
     * 别拿 0 充数，否则「没拿到用量」会被显示成「0 tokens」。
     */
    function addUsage(total, value) {
        if (value == null) return total;
        var num = Number(value);
        if (!isFinite(num)) return total;
        return (total == null ? 0 : total) + num;
    }

    async function runTurn() {
        var cfg = configForRequest();
        if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
            AI.ui.setError({ title: '配置不完整', hint: '请先填写 Base URL、API 密钥与模型。' });
            return;
        }

        var controller = new AbortController();
        state.controller = controller;
        AI.ui.setBusy(true);
        AI.ui.setError(null);

        // 本次提问的统计：多轮工具调用之间要累加，不是覆盖
        var turnStart = Date.now();
        var firstTextAt = null;
        // 思考耗时按「思考事件开始 → 正文开始」的时间跨度算，不拿首字时间当思考时间
        // （首字时间里含工具往返与排队，用它算会明显偏小）
        var thinkSpan = 0;
        var thinkStartedAt = null;
        var usage = { input: null, output: null, cache: null };
        var toolCallCount = 0;
        // 这轮读到的内容留个底：收尾轮模型没写出正文时用它兜底
        var readNotes = [];
        // 过程分组：工具卡与思考块都挂进去，收尾时折叠并排到答案之后
        safeUi(AI.ui.beginProcess);

        var rounds = 0;
        var injected = 0;
        var forceFinal = false;
        var finalReason = '';
        // 收尾轮里模型只想要工具、一个字都没写时，重试一次（只重试一次）
        var finalRetried = false;
        // 模型只说「我先去站内找找」就停时，重试一次逼它真的调工具（只重试一次）
        var planRetried = false;
        // 本轮追加引导（计划催办用）：只挂进这一轮的 system，用完即弃。
        // 不写进 state.messages——写进历史的话，下一轮模型还会读到上一轮的催办，
        // 容易照着过期指令继续跑。
        var pendingGuidance = '';
        // 循环轮次硬上限：模型一直要工具时不能让页面卡住
        var iterations = 0;
        // 本轮最终答案（纯文字）：会话历史只存读者看到的那段话
        var finalText = '';

        try {
            for (;;) {
                iterations += 1;
                var holder = AI.ui.appendMessage('assistant', '');
                var body = holder.body;
                var buffer = '';
                var toolCalls = [];
                var thinkingBlocks = [];
                var failure = null;
                var renderQueued = false;
                var waiting = true;

                // 等待模型首字时显示等待条，拿到字就撤掉
                AI.ui.setPending(true);

                function paint() {
                    renderQueued = false;
                    body.innerHTML = AI.ui.renderMarkdown(buffer);
                    // 重绘是整体覆盖气泡内容，用量行会被抹掉，得补回来
                    // （rAF 排队的重绘可能落在 finally 的 setUsage 之后）
                    if (usage.input != null || usage.output != null || usage.cache != null) {
                        // 字段要和 finally 里那次一致：少了用时与思考两段，
                        // 补回来的行会比最终行更简
                        if (thinkStartedAt !== null) {
                            thinkSpan += Date.now() - thinkStartedAt;
                            thinkStartedAt = null;
                        }
                        safeUi(AI.ui.setUsage, {
                            input: usage.input,
                            output: usage.output,
                            cache: usage.cache,
                            thinkMs: thinkSpan,
                            totalMs: Date.now() - turnStart
                        });
                    }
                }

                /*
                 * 本轮请求的 system = 稳定前缀 + 变动段 + 本轮追加引导。
                 *
                 * 追加引导（计划催办 / 收尾催办 / 策略引导）用完即弃：
                 * 它只出现在这一轮发给 Provider 的 system 里，绝不写进 state.messages。
                 * 写进历史的话，下一轮模型还会读到上一轮的催办，
                 * 容易照着过期指令继续跑（例如上一轮说「别再调工具」，
                 * 这一轮却当成永久约束）。
                 */
                var remaining = MAX_TOOL_ROUNDS - rounds;
                var guidanceParts = [];
                if (pendingGuidance) guidanceParts.push(pendingGuidance);
                // 预算快用完就逼模型换策略：只读最相关的一节，或者干脆停手作答
                if (remaining <= 1) guidanceParts.push(strategyGuidance(remaining));
                // 收尾轮的话最具体，放最后
                if (forceFinal) guidanceParts.push(finalNudge(finalReason));
                var systemText = composeSystem(guidanceParts.join('\n\n'));
                pendingGuidance = '';

                var iterator = AI.provider.streamChat(cfg, {
                    system: systemText,
                    messages: state.messages,
                    tools: AI.tools.definitions(),
                    toolChoice: forceFinal ? 'none' : 'auto',
                    signal: controller.signal
                });

                for await (var ev of iterator) {
                    if (ev.type === 'text') {
                        // 思考耗时从提问开始算到第一个正文 token，thinking 块不算
                        if (firstTextAt === null) firstTextAt = Date.now();
                        if (waiting) {
                            waiting = false;
                            AI.ui.setPending(false);
                        }
                        buffer += ev.text;
                        if (thinkStartedAt !== null) {
                            // 模型开始写正文，这段思考到此为止
                            thinkSpan += Date.now() - thinkStartedAt;
                            thinkStartedAt = null;
                        }
                        if (!renderQueued) {
                            renderQueued = true;
                            window.requestAnimationFrame(paint);
                        }
                    } else if (ev.type === 'usage') {
                        // 每轮 usage 的 input 是「这一轮请求的上下文」，含系统提示 + 全部历史 + 工具结果。
                        // 直接相加会把同一段上下文重复计三四次（输入虚高），所以输入与缓存取最后一轮，
                        // 只有输出是各轮不重叠的，可以累加。
                        if (ev.input != null && isFinite(Number(ev.input))) usage.input = Number(ev.input);
                        if (ev.cache != null && isFinite(Number(ev.cache))) usage.cache = Number(ev.cache);
                        usage.output = addUsage(usage.output, ev.output);
                    } else if (ev.type === 'thinking') {
                        if (thinkStartedAt === null) thinkStartedAt = Date.now();
                        // 思考内容单独成块，不混进正文气泡
                        AI.ui.appendThinking(ev.text);
                    } else if (ev.type === 'thinking_blocks') {
                        // 思考块要原样带回下一轮请求，Anthropic 协议缺了会判 400
                        thinkingBlocks = ev.blocks || [];
                    } else if (ev.type === 'tool_call') {
                        toolCalls.push(ev);
                    } else if (ev.type === 'error') {
                        failure = ev.error;
                        break;
                    } else if (ev.type === 'done') {
                        break;
                    }
                }
                paint();

                if (failure) {
                    if (failure.kind === 'cors' || failure.kind === 'network') {
                        AI.ui.setError(failure);
                    } else {
                        body.innerHTML = AI.ui.renderMarkdown('**' + failure.title + '**\n\n' + (failure.hint || ''));
                    }
                    break;
                }

                var content = [];
                // 思考块排在最前：Anthropic 协议要求 assistant 轮原样带回 thinking + signature
                for (var th = 0; th < thinkingBlocks.length; th++) {
                    content.push({
                        type: 'thinking',
                        thinking: thinkingBlocks[th].thinking || '',
                        signature: thinkingBlocks[th].signature || ''
                    });
                }
                if (buffer) content.push({ type: 'text', text: buffer });

                if (!toolCalls.length) {
                    if (!planRetried && !forceFinal && looksLikePlan(buffer)) {
                        // 模型只说了打算做什么就停了：再给一轮，逼它真的调工具。
                        // 不催这一下，读者看到的就是一句「我去找找」的空话。
                        planRetried = true;
                        state.messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
                        // 催办话术只挂本轮 system：不拼进 state.messages，
                        // 也不覆盖整段 system（覆盖会丢掉稳定前缀，前缀缓存全废）
                        pendingGuidance = '你上一条只说了打算做什么，没有调用工具。现在直接调用 search_articles 找候选文章，不要再描述计划。';
                        if (holder.body && holder.body.parentNode) holder.body.remove();
                        continue;
                    }
                    if (!buffer) {
                        // 模型这一轮什么字都没吐：别留一个空灰框，
                        // 有读过内容就用它兜底，没有就如实说明
                        body.innerHTML = AI.ui.renderMarkdown(readNotes.length
                            ? '模型这轮没写出正文，先把已经查到的内容列给你：\n\n' + readNotes.join('\n\n')
                            : '（模型没有返回内容）');
                        finalText = readNotes.length
                            ? '模型这轮没写出正文，先把已经查到的内容列给你：\n\n' + readNotes.join('\n\n')
                            : '（模型没有返回内容）';
                    } else {
                        finalText = buffer;
                    }
                    state.messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
                    break;
                }

                // 硬上限：模型一直要工具时循环必须自己停。
                // 正常流程到这里最多第 6 轮（3 轮工具 + 1 轮收尾 + 1 轮重试），
                // 这道闸只兜住「收尾轮也拿不到答案」这类异常路径。
                if (iterations > MAX_TOOL_ROUNDS + 4) {
                    // 最坏路径：3 轮工具 + 1 轮计划重试 + 1 轮收尾 + 1 轮收尾重试
                    var gateAnswer = buffer;
                    if (!gateAnswer && readNotes.length) {
                        gateAnswer = '模型这轮没写出正文，先把已经查到的内容列给你：\n\n' + readNotes.join('\n\n');
                    }
                    body.innerHTML = AI.ui.renderMarkdown(
                        (gateAnswer ? gateAnswer + '\n\n' : '') + '（已达到最大轮次，先给出目前的结论。）'
                    );
                    finalText = (gateAnswer ? gateAnswer + '\n\n' : '') + '（已达到最大轮次，先给出目前的结论。）';
                    break;
                }

                if (forceFinal) {
                    // 收尾轮里模型还要调工具：不再执行。
                    // 执行只会让注入继续涨、用户最后看到的还是工具卡而不是答案。
                    // 调用原样写回对话，再补一条合成 tool_result 维持协议配对
                    // （Anthropic 要求每个 tool_use 都有对应的 tool_result），
                    // 然后把这一轮已经写出来的正文当答案。
                    for (var f = 0; f < toolCalls.length; f++) {
                        content.push({
                            type: 'tool_use',
                            id: toolCalls[f].id,
                            name: toolCalls[f].name,
                            input: parseArgs(toolCalls[f].arguments)
                        });
                    }
                    state.messages.push({ role: 'assistant', content: content });
                    state.messages.push({
                        role: 'user',
                        content: toolCalls.map(function (call) {
                            return {
                                type: 'tool_result',
                                tool_use_id: call.id,
                                // 工具结果里只留事实：工具没被执行、原因是什么。
                                // 「不要再调工具、请直接作答」是给模型的指令，
                                // 它属于当轮 system（finalNudge），
                                // 写进历史的话会在后续每一轮里反复出现。
                                content: '工具未执行：这一轮已经进入收尾阶段，不再执行新的工具调用。'
                            };
                        })
                    });

                    if (!buffer && !finalRetried) {
                        // 模型这轮一个字都没写、还想要工具：再给一次机会。
                        // 直接 break 的话用户看到的只有兜底清单，不是答案。
                        finalRetried = true;
                        finalReason = 'answer-now';
                        if (holder.body && holder.body.parentNode) holder.body.remove();
                        continue;
                    }

                    var tail = finalReason === 'injected'
                        ? '（注入正文已达上限，以上是最后一轮的结论。）'
                        : '（已达到工具调用次数上限，以上是最后一轮的结论。）';
                    var answer = buffer;
                    if (!answer) {
                        // 模型这轮一个字都没写：把已经查到的内容兜底列出来，
                        // 否则用户只看到一句「已达上限」，等于没答
                        answer = readNotes.length
                            ? '模型这轮没写出正文，先把已经查到的内容列给你：\n\n' + readNotes.join('\n\n') + '\n\n' + tail
                            : tail;
                    } else {
                        answer = buffer + '\n\n' + tail;
                    }
                    body.innerHTML = AI.ui.renderMarkdown(answer);
                    finalText = answer;
                    break;
                }

                if (rounds >= MAX_TOOL_ROUNDS) {
                    // 工具预算用完：再给一轮「不许再调工具」，把已读到的内容写成答案。
                    // 直接 break 的后果是用户只看到一串工具卡、没有答案。
                    if (!buffer && holder.body && holder.body.parentNode) holder.body.remove();
                    forceFinal = true;
                    finalReason = 'tools';
                    continue;
                }

                for (var i = 0; i < toolCalls.length; i++) {
                    content.push({
                        type: 'tool_use',
                        id: toolCalls[i].id,
                        name: toolCalls[i].name,
                        input: parseArgs(toolCalls[i].arguments)
                    });
                }
                state.messages.push({ role: 'assistant', content: content });

                var results = [];
                for (var t = 0; t < toolCalls.length; t++) {
                    var call = toolCalls[t];
                    var args = parseArgs(call.arguments);
                    var result = await AI.tools.execute(call.name, args);
                    // 过程分组要报「本次提问用了多少次工具」，只数真正执行的
                    toolCallCount += 1;
                    // 注入预算按真正进模型的内容算，不是按整个 result 的 JSON 算
                    var payload = compactToolResult(result);
                    injected += payload.length;
                    var note = noteFromResult(result);
                    if (note) readNotes.push(note);
                    collectSources(result);
                    AI.ui.appendToolCard(call, result);
                    results.push({
                        type: 'tool_result',
                        tool_use_id: call.id,
                        content: payload
                    });
                }
                state.messages.push({ role: 'user', content: results });

                // 这一轮真的执行了工具，轮次要计上：
                // 计数放在执行之后，continue 的路径才不会漏算。
                rounds += 1;

                if (injected > MAX_INJECTED_CHARS) {
                    // 注入预算用完也留一轮收尾：直接 break 的话用户同样只看到工具卡
                    if (!buffer && holder.body && holder.body.parentNode) holder.body.remove();
                    forceFinal = true;
                    finalReason = 'injected';
                    continue;
                }

                // 这一轮只有工具调用、没有正文：把空气泡删掉。
                // 思考块与工具卡是气泡的兄弟节点，不会被一起删掉。
                if (!buffer && holder.body && holder.body.parentNode) {
                    holder.body.remove();
                }
            }
        } catch (err) {
            AI.ui.setError(AI.provider.classifyError({ networkError: err }));
        } finally {
            AI.ui.setPending(false);
            AI.ui.setBusy(false);
            AI.ui.setSources(state.sources);
            state.controller = null;

            // 收尾统计：一个正文 token 都没吐出来时思考耗时按 0 记
            var totalMs = Date.now() - turnStart;
            // 先写用量再收过程分组：分组会被移到消息流末尾，
            // 顺序反了用量行就跑到分组下面去了
            if (thinkStartedAt !== null) {
                thinkSpan += Date.now() - thinkStartedAt;
                thinkStartedAt = null;
            }
            safeUi(AI.ui.setUsage, {
                input: usage.input,
                output: usage.output,
                cache: usage.cache,
                thinkMs: thinkSpan,
                totalMs: totalMs
            });
            safeUi(AI.ui.endProcess, { toolCalls: toolCallCount, thinkMs: thinkSpan });
            // 回答落进会话历史：读者回头看时能看到自己问过什么、答了什么
            if (finalText) persistTurn('assistant', finalText);
        }
    }

    // 测试缝：往历史里塞一条用户消息，不经过 UI，也不自动发请求。
    // 门禁脚本用它把「历史长什么样」和「界面长什么样」拆开，才能单独验历史有没有被污染
    function pushUserMessage(text) {
        var value = (text || '').trim();
        if (!value) return;
        state.messages.push({ role: 'user', content: [{ type: 'text', text: value }] });
    }

    function send(text) {
        var value = (text || '').trim();
        if (!value) return;
        var message = value;
        if (state.quote) {
            message = value + '\n\n（我划选的内容：' + state.quote + '）';
        }
        // 会话：一条会话同时装提问与回答，先保证有会话可装
        ensureSession();
        state.messages.push({ role: 'user', content: [{ type: 'text', text: message }] });
        persistTurn('user', message);
        AI.ui.appendMessage('user', message);
        state.sources = [];
        AI.ui.setSources([]);
        return runTurn();
    }

    /* -------------------------------------------------------------- 划词 */

    function selectionInsideArticle() {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
        var text = (sel.toString() || '').trim();
        if (!text || text.length > 600) return null;
        var node = sel.getRangeAt(0).startContainer;
        var el = node.nodeType === 1 ? node : node.parentElement;
        while (el) {
            if (el.classList && el.classList.contains('post-content')) {
                return { text: text, rect: sel.getRangeAt(0).getBoundingClientRect() };
            }
            el = el.parentElement;
        }
        return null;
    }

    function onPointerUp() {
        var picked = selectionInsideArticle();
        if (!picked) {
            AI.ui.hideBubble();
            return;
        }
        AI.ui.showBubble(picked.rect, function () {
            state.quote = picked.text;
            refreshContextBar();
            AI.ui.setOpen(true);
            AI.ui.setState('chat');
            AI.ui.refs.composer.focus();
        });
    }

    /* ------------------------------------------------------------ 界面事件 */

    function fillSettings() {
        var refs = AI.ui.refs;
        var cfg = state.config;

        // 预设是自绘下拉，选项写在列表里，选中态由 aria-selected 标出
        refs.presetList.innerHTML = '';
        PRESETS.forEach(function (preset) {
            var item = document.createElement('li');
            item.setAttribute('role', 'option');
            item.dataset.preset = preset.id;
            item.setAttribute('aria-selected', preset.id === cfg.presetId ? 'true' : 'false');
            item.textContent = preset.name;
            refs.presetList.appendChild(item);
        });
        refs.presetText.textContent = presetById(cfg.presetId).name;

        var inputs = document.querySelectorAll('.ai-settings [data-field]');
        for (var i = 0; i < inputs.length; i++) {
            var field = inputs[i].dataset.field;
            if (field === 'systemPrompt') {
                inputs[i].value = cfg.presetId === 'custom' ? cfg.systemPrompt : presetById(cfg.presetId).prompt;
            } else {
                inputs[i].value = cfg[field] || '';
            }
        }
        var segs = document.querySelectorAll('.ai-seg[data-protocol]');
        for (var t = 0; t < segs.length; t++) {
            segs[t].setAttribute('aria-checked', segs[t].dataset.protocol === cfg.protocol ? 'true' : 'false');
        }
        updateEndpointPreview();
    }

    /* 地址栏下面那行预览：填什么，最终就往哪儿发请求 */
    function updateEndpointPreview() {
        var preview = AI.ui.refs.endpoint;
        if (!preview) return;
        var endpoint = AI.provider.normalizeConfig(state.config).endpoint;
        preview.textContent = endpoint || '—';
    }

    /* 选中某个预设：回填提示词文本，并把下拉按钮上的名字换掉 */
    function applyPreset(id) {
        var refs = AI.ui.refs;
        var preset = presetById(id);
        state.config.presetId = preset.id;
        state.config.systemPrompt = preset.prompt;
        var textarea = document.querySelector('.ai-settings [data-field="systemPrompt"]');
        if (textarea) textarea.value = preset.prompt;
        markPreset(preset.id, preset.name);
    }

    /* 把下拉的选中态与按钮文字同步到某个预设上 */
    function markPreset(id, name) {
        var refs = AI.ui.refs;
        var items = refs.presetList.querySelectorAll('li[data-preset]');
        for (var i = 0; i < items.length; i++) {
            items[i].setAttribute('aria-selected', items[i].dataset.preset === id ? 'true' : 'false');
        }
        refs.presetText.textContent = name || (presetById(id) || {}).name || '';
    }

    /* 复制到剪贴板：现代 API 不可用或被拒时退回 execCommand */
    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).catch(function () {
                return legacyCopy(text);
            });
        }
        return legacyCopy(text);
    }

    function legacyCopy(text) {
        return new Promise(function (resolve, reject) {
            var area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', 'readonly');
            area.style.position = 'fixed';
            area.style.top = '0';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            var ok = false;
            try {
                ok = document.execCommand('copy');
            } catch (err) {
                ok = false;
            }
            document.body.removeChild(area);
            if (ok) resolve();
            else reject(new Error('复制失败'));
        });
    }

    /*
     * 事件委托：动作属性挂在祖先上，按钮里的 SVG 图标、图标里的 path 才是 target，
     * 直接读 target.dataset 什么都取不到（点发送、点关闭都没反应，得点很多次）。
     * 一律用 closest 往上找最近的那个带 data-* 的祖先；
     * SVG 元素同样有 closest，所以点图标也能命中按钮。
     */
    function closestDataNode(node) {
        if (!node || !node.closest) return null;
        return node.closest('[data-act], [data-protocol], [data-state]');
    }

    function onClick(event) {
        var target = event.target;
        var hit = closestDataNode(target);
        var action = hit && hit.dataset.act ? hit.dataset.act : null;
        var protocol = hit && hit.dataset.protocol ? hit.dataset.protocol : null;
        var view = hit && hit.dataset.state ? hit.dataset.state : null;
        var refs = AI.ui.refs;

        // 下拉展开时，点别处先收起（按钮与选项本身除外）
        if (!refs.presetList.hidden &&
            !refs.presetList.contains(target) &&
            !refs.presetButton.contains(target)) {
            AI.ui.closePresetList();
        }

        // 协议分段控件没有 data-act，靠 data-protocol 识别
        if (protocol) {
            state.config.protocol = protocol;
            fillSettings();
            return;
        }

        // 头部视图分段控件靠 data-state 识别
        if (view) {
            if (view === 'settings') fillSettings();
            AI.ui.setState(view);
            return;
        }

        // 预设下拉的选项
        var presetItem = target.closest ? target.closest('li[data-preset]') : null;
        if (presetItem) {
            applyPreset(presetItem.dataset.preset);
            AI.ui.closePresetList();
            return;
        }

        if (action === 'close') {
            AI.ui.setOpen(false);
            return;
        }
        if (action === 'preset-toggle') {
            if (refs.presetList.hidden) AI.ui.openPresetList();
            else AI.ui.closePresetList();
            return;
        }
        if (action === 'save') {
            var inputs = document.querySelectorAll('.ai-settings [data-field]');
            for (var i = 0; i < inputs.length; i++) {
                var field = inputs[i].dataset.field;
                state.config[field] = inputs[i].value.trim();
            }
            saveConfig();
            if (!hasUsableConfig()) {
                AI.ui.setSaved(false, '配置不完整');
                return;
            }
            AI.ui.setSaved(true);
            return;
        }
        if (action === 'toggle-key') {
            var input = document.querySelector('.ai-settings [data-field="apiKey"]');
            var hidden = input.type === 'password';
            input.type = hidden ? 'text' : 'password';
            hit.textContent = hidden ? '隐藏' : '显示';
            hit.setAttribute('aria-pressed', hidden ? 'true' : 'false');
            return;
        }
        if (action === 'copy-code') {
            var wrap = hit.closest ? hit.closest('.ai-code-wrap') : null;
            var code = wrap ? wrap.querySelector('code') : null;
            if (!code) return;
            copyText(code.textContent).then(function () {
                hit.textContent = '已复制';
                window.setTimeout(function () {
                    hit.textContent = '复制代码';
                }, 1500);
            }, function () {
                hit.textContent = '复制失败';
                window.setTimeout(function () {
                    hit.textContent = '复制代码';
                }, 1500);
            });
            return;
        }
        if (action === 'send') {
            var value = refs.composer.value.trim();
            if (!value) return;
            refs.composer.value = '';
            refs.sendBtn.disabled = true;
            send(value);
            return;
        }
        if (action === 'toggle-context') {
            state.useContext = !state.useContext;
            refreshContextBar();
            return;
        }
        if (action === 'clear-quote') {
            state.quote = '';
            refreshContextBar();
            return;
        }
    }

    function onInput(event) {
        var target = event.target;
        // 输入框里没有字时发送按钮不可点
        if (target === AI.ui.refs.composer) {
            AI.ui.refs.sendBtn.disabled = !target.value.trim();
            return;
        }
        var field = target.dataset ? target.dataset.field : null;
        if (!field) return;
        if (field === 'systemPrompt') {
            state.config.systemPrompt = target.value;
            state.config.presetId = 'custom';
            markPreset('custom', '自定义');
        } else {
            state.config[field] = target.value;
            // 地址或协议一改，预览的那行地址跟着变
            updateEndpointPreview();
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            // 请求还在跑时先中止请求，否则收起浮窗
            if (state.controller) {
                state.controller.abort();
                return;
            }
            AI.ui.setOpen(false);
            AI.ui.hideBubble();
            return;
        }
        // 上下文行是 role=button，回车与空格都能切换
        var toggle = event.target && event.target.closest
            ? event.target.closest('[data-act="toggle-context"]')
            : null;
        if (toggle && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            state.useContext = !state.useContext;
            refreshContextBar();
            return;
        }
        /*
         * 输入框里回车即发送、Shift+Enter 才换行：
         * 提问框不是草稿箱，发一条消息要按两个键是多余的。
         * Ctrl/Cmd+Enter 也照常发送（这条分支不区分修饰键）。
         */
        if (event.key === 'Enter' && event.target === AI.ui.refs.composer) {
            // 中文输入法组词时回车是「上屏」，当成发送会把刚打出的半句发出去
            if (event.isComposing || event.keyCode === 229) return;
            if (event.shiftKey) return;
            event.preventDefault();
            var value = AI.ui.refs.composer.value.trim();
            if (!value) return;
            AI.ui.refs.composer.value = '';
            AI.ui.refs.sendBtn.disabled = true;
            send(value);
        }
    }

    /*
     * 悬浮球可以拖到任意位置，落位后记住；浮窗贴着球展开。
     * 拖拽用 Pointer Events 统一鼠标与触摸，拖动超过阈值才算拖，
     * 否则仍然当作点击开合面板。
     */
    var FAB_POSITION_KEY = 'ai-assistant.fab-position';
    var DRAG_THRESHOLD = 5;
    var suppressNextFabClick = false;

    function loadFabPosition() {
        try {
            var raw = window.localStorage.getItem(FAB_POSITION_KEY);
            if (!raw) return null;
            var saved = JSON.parse(raw);
            if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') return saved;
        } catch (e) {
            // 隐私模式或配额满时读不到位置，退回默认落位即可
        }
        return null;
    }

    function saveFabPosition(position) {
        try {
            window.localStorage.setItem(FAB_POSITION_KEY, JSON.stringify(position));
        } catch (e) {
            // 存不下不影响使用，只是下次回到默认位置
        }
    }

    /*
     * 窄屏（≤767px）面板是底部抽屉：位置由样式钉在底部，拖标题栏改的是高度；
     * 宽屏才是拖标题栏挪浮窗。两种行为不能混：窄屏拖动不许移动浮窗。
     */
    var DRAWER_MIN_RATIO = 0.4;
    var DRAWER_MAX_RATIO = 0.92;

    function clampDrawerHeight(px) {
        var min = Math.round(window.innerHeight * DRAWER_MIN_RATIO);
        var max = Math.round(window.innerHeight * DRAWER_MAX_RATIO);
        return Math.min(max, Math.max(min, Math.round(px)));
    }

    /* 当前抽屉高度：UI 层记的值优先，没有就用面板实际高度兜底 */
    function currentDrawerHeight(panel) {
        var saved = safeUi(AI.ui.getDrawerHeight);
        if (typeof saved === 'number' && isFinite(saved) && saved > 0) return saved;
        var box = panel.getBoundingClientRect();
        if (box && box.height) return box.height;
        return Math.round(window.innerHeight * 0.74);
    }

    /* 浮窗本身也能拖：宽屏拖头部挪窗，窄屏拖头部调抽屉高度 */
    function bindPanelDrag() {
        var panel = AI.ui.refs.panel;
        if (!panel) return;
        var head = panel.querySelector('.ai-panel-head');
        if (!head) return;

        var dragging = false;
        var moved = false;
        var resizing = false;
        var startX = 0;
        var startY = 0;
        var panelX = 0;
        var panelY = 0;
        var fabX = 0;
        var fabY = 0;
        var startHeight = 0;

        function capture(event) {
            if (!head.setPointerCapture) return;
            try {
                head.setPointerCapture(event.pointerId);
            } catch (e) {
                // 某些浏览器对鼠标捕获会抛错，不影响拖拽本身
            }
        }

        head.addEventListener('pointerdown', function (event) {
            if (event.button !== undefined && event.button !== 0) return;
            // 头部上的按钮与输入框不参与拖拽；上下文行也是可点的（data-act），
            // 窄屏它是抽屉把手的一部分，手指一抖就会误改高度，所以一起排除
            if (event.target && event.target.closest &&
                event.target.closest('button, a, input, select, textarea, [data-act]')) {
                return;
            }
            dragging = true;
            moved = false;
            startX = event.clientX;
            startY = event.clientY;

            if (AI.ui.isNarrow()) {
                // 窄屏是底部抽屉：高度才是用户想调的东西
                resizing = true;
                startHeight = currentDrawerHeight(panel);
                head.classList.add('is-dragging');
                capture(event);
                return;
            }

            resizing = false;
            var pbox = panel.getBoundingClientRect();
            var fbox = AI.ui.refs.fab.getBoundingClientRect();
            panelX = pbox.left;
            panelY = pbox.top;
            fabX = fbox.left;
            fabY = fbox.top;
            head.classList.add('is-dragging');
            capture(event);
        });

        head.addEventListener('pointermove', function (event) {
            if (!dragging) return;
            var dx = event.clientX - startX;
            var dy = event.clientY - startY;
            if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            moved = true;
            event.preventDefault();

            if (resizing) {
                // 往上拖（dy 为负）变高，往下拖变矮，范围夹在 40vh ~ 92vh
                safeUi(AI.ui.setDrawerHeight, clampDrawerHeight(startHeight - dy));
                return;
            }

            // 先夹窗，再用实际移动量挪球，两者不会走散
            var pos = AI.ui.setPanelPosition(panelX + dx, panelY + dy);
            AI.ui.setFabPosition(fabX + (pos.x - panelX), fabY + (pos.y - panelY));
        });

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            var wasResizing = resizing;
            resizing = false;
            head.classList.remove('is-dragging');
            // 窄屏调的是高度，浮窗落位不变，别把高度当位置存回去
            if (moved && !wasResizing && !AI.ui.isCompact()) saveFabPosition(AI.ui.getFabPosition());
        }

        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);
    }

    function bindFabDrag() {
        var fab = AI.ui.refs.fab;
        var dragging = false;
        var moved = false;
        var startX = 0;
        var startY = 0;
        var originX = 0;
        var originY = 0;

        fab.addEventListener('pointerdown', function (event) {
            if (event.button !== undefined && event.button !== 0) return;
            // 上一次拖拽可能把抑制标记留在 true（拖到球外松手时 click 落在别处，
            // 标记没人清）。click 一定发生在下一次 pointerdown 之前，
            // 所以这里清一次残留，不会影响本次拖拽的抑制。
            suppressNextFabClick = false;
            var box = fab.getBoundingClientRect();
            dragging = true;
            moved = false;
            startX = event.clientX;
            startY = event.clientY;
            originX = box.left;
            originY = box.top;
            fab.classList.add('is-dragging');
            if (fab.setPointerCapture) {
                try {
                    fab.setPointerCapture(event.pointerId);
                } catch (e) {
                    // 某些浏览器对鼠标捕获会抛错，不影响拖拽本身
                }
            }
        });

        fab.addEventListener('pointermove', function (event) {
            if (!dragging) return;
            var dx = event.clientX - startX;
            var dy = event.clientY - startY;
            if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
            moved = true;
            event.preventDefault();
            AI.ui.setFabPosition(originX + dx, originY + dy);
            if (AI.ui.isOpen()) {
                // 拖动期间锁住展开侧：球越过中线时窗不应翻到另一边
                AI.ui.setSideLock(true);
                AI.ui.placePanel();
            }
        });

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            fab.classList.remove('is-dragging');
            if (moved) {
                // 紧凑视口（≤1023px）的落位是临时的：主题右下有目录按钮，
                // 这一档的坐标不写回存储，免得带到宽屏里去
                if (!AI.ui.isCompact()) saveFabPosition(AI.ui.getFabPosition());
                // 拖动结束后的那次 click 不应该再开合面板，用标记而不是
                // 事件拦截：click 监听器早已注册，拦截顺序不可靠
                suppressNextFabClick = true;
                // 松手后按球的新位置重排一次（这次不锁侧）
                AI.ui.setSideLock(false);
                if (AI.ui.isOpen()) AI.ui.placePanel();
            }
        }

        fab.addEventListener('pointerup', endDrag);
        fab.addEventListener('pointercancel', endDrag);
    }

    function init() {
        loadConfig();
        AI.ui.mount();
        AI.context.init();

        fillSettings();
        AI.ui.setOpen(false);
        AI.ui.setState(hasUsableConfig() ? 'chat' : 'settings');
        refreshContextBar();

        /*
         * 会话历史接线：
         *  - 订阅会话变化：切换会话时把 provider 历史换成那条会话的；
         *  - 刷新页面后接着上次那条会话：存储里只有纯文字，
         *    provider 历史按文字重建（工具过程不跨刷新保留）。
         */
        if (typeof AI.ui.onSessionChange === 'function') {
            AI.ui.onSessionChange(onSessionChange);
        }
        if (AI.sessions) {
            var restoredId = AI.sessions.currentId();
            if (restoredId) {
                state.sessionId = restoredId;
                state.messages = providerHistory(restoredId);
                // 界面可能已经自己画过一遍（渲染归 ui.js），别画两遍
                if (typeof AI.ui.renderSessionMessages === 'function'
                    && (!AI.ui.refs.stream || !AI.ui.refs.stream.querySelector('.ai-msg'))) {
                    AI.ui.renderSessionMessages(AI.sessions.getMessages(restoredId));
                }
            }
        }

        document.addEventListener('click', onClick);
        document.addEventListener('input', onInput);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mouseup', onPointerUp);
        document.addEventListener('selectionchange', function () {
            if (!window.getSelection() || window.getSelection().isCollapsed) AI.ui.hideBubble();
        });

        /*
         * 落位规则按断点分档：
         *  - ≤1023px：主题在右下角有自己的目录按钮，助手一律靠左下，
         *    并且不把桌面坐标带进来（否则 900px 窗口里会和目录按钮重叠）。
         *  - >1023px：用用户上次拖拽的位置，没有就默认右下。
         */
        var savedPosition = loadFabPosition();
        if (AI.ui.isCompact()) {
            var compactFallback = AI.ui.defaultFabPosition();
            AI.ui.setFabPosition(compactFallback.x, compactFallback.y);
        } else if (savedPosition) {
            AI.ui.setFabPosition(savedPosition.x, savedPosition.y);
        } else {
            var fallback = AI.ui.defaultFabPosition();
            AI.ui.setFabPosition(fallback.x, fallback.y);
        }
        bindFabDrag();
        bindPanelDrag();

        AI.ui.refs.fab.addEventListener('click', function () {
            if (suppressNextFabClick) {
                suppressNextFabClick = false;
                return;
            }
            // 关闭中面板还没补 hidden，所以问的是 is-open 而不是 hidden
            var open = !AI.ui.isOpen();
            AI.ui.setOpen(open);
            if (open) {
                AI.ui.setState(hasUsableConfig() ? 'chat' : 'settings');
                if (hasUsableConfig()) AI.ui.refs.composer.focus();
            }
        });

        AI.context.onChange(function () {
            refreshContextBar();
        });

        /*
         * 视口变化后的落位策略：
         *  - 只在跨越断点时换落位规则（≤1023px 紧凑档 / >1023px 宽屏档），
         *    单纯的 resize（比如手机地址栏收放、键盘弹起）只把球夹回视口内，
         *    不动用户刚拖好的位置。
         *  - 宽屏档回用户上次拖拽的位置，紧凑档回默认落位（主题右下有目录按钮）。
         */
        function applyViewportLayout() {
            AI.ui.syncViewport();
            if (AI.ui.isCompact()) {
                var fallback = AI.ui.defaultFabPosition();
                AI.ui.setFabPosition(fallback.x, fallback.y);
            } else {
                var saved = loadFabPosition();
                var current = saved || AI.ui.getFabPosition();
                AI.ui.setFabPosition(current.x, current.y);
            }
            AI.ui.placePanel();
        }

        window.addEventListener('resize', function () {
            // 窄屏标记跟着视口走，CSS 靠它把浮窗变成底部抽屉
            AI.ui.syncViewport();
            // 缩放后把球夹回视口内（不改变落位规则，避免每次 resize 都重置位置）
            var current = AI.ui.getFabPosition();
            if (current.x || current.y) AI.ui.setFabPosition(current.x, current.y);
            // 转屏后视口高度变了，之前拖出来的抽屉高度可能越界，重新夹一次
            if (AI.ui.isNarrow()) {
                var drawer = safeUi(AI.ui.getDrawerHeight);
                if (typeof drawer === 'number' && isFinite(drawer) && drawer > 0) {
                    safeUi(AI.ui.setDrawerHeight, clampDrawerHeight(drawer));
                }
            }
            AI.ui.placePanel();
        });

        // 跨断点时才换落位规则
        if (window.matchMedia) {
            var compactQuery = window.matchMedia('(max-width: 1023px)');
            var onBreakpointChange = function () {
                applyViewportLayout();
            };
            if (compactQuery.addEventListener) {
                compactQuery.addEventListener('change', onBreakpointChange);
            } else if (compactQuery.addListener) {
                compactQuery.addListener(onBreakpointChange);
            }
        }

        // 上下文条要等文章标题和小节都识别出来之后再刷一次，
        // 否则初始化早期渲染的空值会一直留在界面上
        window.requestAnimationFrame(refreshContextBar);
    }

    // 测试缝：把纯函数挂出来，门禁脚本才能直接验「到底注入了哪段正文」。
    // 挂的是纯函数，没有副作用，也不在生产路径上被调用
    AI.main = {
        currentContext: currentContext,
        buildSystemPrompt: buildSystemPrompt,
        // 分层自证：门禁要能逐字比对稳定前缀，并确认追加引导只挂在尾部
        systemLayers: buildSystemLayers,
        composeSystem: composeSystem,
        compactToolResult: compactToolResult,
        strategyGuidance: strategyGuidance,
        finalNudge: finalNudge,
        // 回合自证：门禁要能驱动真实的主流程，逐轮观察发给 Provider 的 system/messages
        runTurn: runTurn,
        pushUserMessage: pushUserMessage,
        // 提问自证：走完整的 send 路径（入会话、追加历史、渲染、跑一轮），
        // 门禁要能看见「一问一答都进了会话历史」
        send: send,
        // 会话自证：门禁要能看见「当前会话 + provider 历史长什么样」，
        // 以及换会话之后历史有没有跟着换
        sessionSnapshot: function () {
            var list = [];
            for (var i = 0; i < state.messages.length; i++) {
                var m = state.messages[i] || {};
                var text = '';
                var content = m.content;
                if (typeof content === 'string') {
                    text = content;
                } else if (Array.isArray(content)) {
                    for (var j = 0; j < content.length; j++) {
                        var part = content[j] || {};
                        if (part.type === 'text' && typeof part.text === 'string') text += part.text;
                    }
                }
                list.push({ role: m.role, text: text, blocks: Array.isArray(content) ? content.length : 0 });
            }
            return { sessionId: state.sessionId, messages: list };
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
