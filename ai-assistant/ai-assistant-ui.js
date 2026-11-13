/*
 * 助手界面的 DOM 与渲染
 *
 * 这一层只管「长什么样、怎么显示」，不碰网络与状态机；
 * 状态与流程在 ai-assistant-main.js。
 * 结构与类名对齐 Open Design 原型（ai-widget.html），样式在 ai-assistant.css。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var refs = {};
    var errorNode = null;
    var pendingNode = null;
    var closeTimer = null;
    // 本轮「过程」分组的挂载点：工具卡与思考块都归到这里，beginProcess 建、endProcess 收
    var processNode = null;
    var processBody = null;
    // 窄屏抽屉高度（px）：用户拖出来的值，切回宽屏也要留着
    var drawerHeight = null;

    /*
     * 悬浮球图片与本脚本同目录（source/ai-assistant/fab.jpg）。
     * 从脚本自身的地址推导，不能把站点根路径写死——文章页 URL 很深，
     * 相对路径会指到别处去。
     */
    var FAB_IMAGE = (function () {
        var current = document.currentScript;
        var src = current && current.getAttribute ? current.getAttribute('src') : null;
        if (!src) return 'ai-assistant/fab.jpg';
        try {
            // src 可能是根相对路径（/ai-assistant/…），要先按页面地址解析成绝对地址
            return new URL('fab.jpg', new URL(src, document.baseURI)).href;
        } catch (e) {
            return 'ai-assistant/fab.jpg';
        }
    })();

    /* ---------------------------------------------------------------- 基础 */

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    /*
     * 图标统一走描边路径：描边与填充色交给 CSS 的令牌决定，
     * 这里不再写死颜色，浅色深色两套令牌才能各管各的。
     */
    function icon(paths, className) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        if (className) svg.setAttribute('class', className);
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        for (var i = 0; i < paths.length; i++) {
            var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', paths[i]);
            svg.appendChild(path);
        }
        return svg;
    }

    var ICONS = {
        close: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
        send: ['M12 19.5V5', 'M6.5 10.5 12 5l5.5 5.5'],
        // 停止：实心方块（描边图标在这里看不出「按下去会停」）
        stop: ['M7.5 7.5h9v9h-9z'],
        chevron: ['M6.5 9.5l5.5 5.5 5.5-5.5'],
        // 上下文：一叠层，表示「这次带哪些资料」
        context: ['M12 4.5l7 3.4-7 3.4-7-3.4z', 'M5 12l7 3.4 7-3.4', 'M5 15.6l7 3.4 7-3.4'],
        source: ['M6.5 3.5h8l4 4v13h-12z', 'M14.5 3.5v4h4'],
        // 滚动导航：一上一下
        chevronUp: ['M6.5 14.5 12 9l5.5 5.5'],
        chevronDown: ['M6.5 9.5 12 15l5.5-5.5'],
        // 回退：向左的折角箭头
        rewind: ['M10 6 5 11l5 5', 'M5 11h8a6 6 0 0 1 0 12h-1']
    };

    /* ---------------------------------------------------------- 会话存储 */

    /*
     * 聊天历史只留在本机：localStorage 存一份 JSON，读不出来就退回内存，
     * 界面照常能用。写入做 300ms 防抖——一轮对话会连着改好几次
     * （消息、标题、当前会话），每次都落盘既慢又容易撞上配额。
     */
    var SESSION_KEY = 'ai-assistant.sessions';
    var SESSION_LIMIT = 30;
    var SESSION_MESSAGE_LIMIT = 200;
    var SESSION_TITLE_LIMIT = 20;
    var SESSION_SAVE_DELAY = 300;

    var sessionStore = null;
    var sessionSaveTimer = null;
    // 外部订阅者（主流程接线用）：只有会话本身变了才通知，追加消息不通知
    var sessionCallbacks = [];
    // 回答进行中：会话操作要锁住，主流程此时也会把会话切回原来那条
    var sessionBusy = false;
    // 消息区当前画的是哪条会话，同一条不画第二次
    var paintedSessionId = null;
    // 主流程注册回退处理：界面只知道「回退第几条用户消息」，改上下文是它的事
    var rewindHandler = null;
    // 会话下拉里的临时状态：正在改名 / 正在等确认删除
    var renamingSessionId = null;
    var confirmingSessionId = null;
    // 改名输入框是刚画出来的,要把焦点抢过来——但只在「用户刚点了重命名」这一轮抢,
    // 否则存储一变就重画列表,焦点会被从输入框抢走
    var pendingRenameFocus = false;

    function newSessionId() {
        return 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function emptyStore() {
        return { sessions: [], currentId: null };
    }

    function findSessionIn(store, id) {
        if (!store || !id) return null;
        for (var i = 0; i < store.sessions.length; i++) {
            if (store.sessions[i].id === id) return store.sessions[i];
        }
        return null;
    }

    /*
     * 落盘的数据一律重新洗一遍结构：正文只认 role/content，
     * 过程留档走 sanitizeProcess（工具块与结果原文一律丢掉），条数超上限的丢最旧的。
     */
    function normalizeSession(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var messages = [];
        var list = Array.isArray(raw.messages) ? raw.messages : [];
        for (var i = 0; i < list.length; i++) {
            var one = list[i];
            if (!one || (one.role !== 'user' && one.role !== 'assistant')) continue;
            var entry = {
                role: one.role,
                content: typeof one.content === 'string' ? one.content : ''
            };
            // 刷新后要能把时间线与来源重画出来，所以过程留档必须放行
            var proc = sanitizeProcess(one.process);
            if (proc) entry.process = proc;
            messages.push(entry);
        }
        if (messages.length > SESSION_MESSAGE_LIMIT) {
            messages = messages.slice(messages.length - SESSION_MESSAGE_LIMIT);
        }
        var now = Date.now();
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : newSessionId(),
            title: typeof raw.title === 'string' ? raw.title : '',
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
            messages: messages
        };
    }

    function readStore() {
        var raw = null;
        try {
            raw = window.localStorage.getItem(SESSION_KEY);
        } catch (e) {
            // 无痕模式或存储被禁：退回内存，界面照常用
            return emptyStore();
        }
        if (!raw) return emptyStore();
        var data = null;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            // 存坏了就当没有，别让一段坏 JSON 卡住整个助手
            return emptyStore();
        }
        if (!data || typeof data !== 'object') return emptyStore();
        var store = emptyStore();
        var list = Array.isArray(data.sessions) ? data.sessions : [];
        for (var i = 0; i < list.length; i++) {
            var one = normalizeSession(list[i]);
            if (one) store.sessions.push(one);
        }
        store.currentId = typeof data.currentId === 'string' ? data.currentId : null;
        if (!findSessionIn(store, store.currentId)) {
            // 当前会话可能已经不在了，指针要落到还剩的那一条
            store.currentId = store.sessions.length
                ? store.sessions[store.sessions.length - 1].id
                : null;
        }
        return store;
    }

    function store() {
        if (!sessionStore) sessionStore = readStore();
        return sessionStore;
    }

    /*
     * 落盘失败（配额满）时不能默默吞掉：一条长会话的过程留档就能顶到 5MB，
     * 之后所有会话的正文都存不进去，用户却什么都不知道。
     * 退让顺序：先砍旧会话的过程留档，再砍旧会话本身，当前会话最后动。
     */
    function pruneForQuota(data) {
        var sessions = data.sessions || [];
        var currentId = data.currentId;
        for (var i = 0; i < sessions.length; i++) {
            if (sessions[i].id === currentId) continue;
            for (var j = 0; j < sessions[i].messages.length; j++) {
                delete sessions[i].messages[j].process;
            }
        }
        // 还装不下就丢最旧的会话（当前会话与最近 8 条留着）
        var recent = sessions.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; }).slice(0, 8);
        var kept = [];
        for (var k = 0; k < sessions.length; k++) {
            var one = sessions[k];
            if (one.id === currentId || recent.indexOf(one) !== -1) kept.push(one);
        }
        if (kept.length < sessions.length) {
            data.sessions = kept;
            return true;
        }
        return false;
    }

    function saveNow() {
        var data = store();
        try {
            window.localStorage.setItem(SESSION_KEY, JSON.stringify(data));
            return true;
        } catch (e) {
            // 配额满：砍旧数据再试一次
            if (!pruneForQuota(data)) return false;
            try {
                window.localStorage.setItem(SESSION_KEY, JSON.stringify(data));
                if (typeof showToast === 'function') showToast('本机存储已满：旧会话的过程记录已清理');
                return true;
            } catch (e2) {
                // 存储被禁或还是装不下：留在内存里继续用
                return false;
            }
        }
    }

    function scheduleSave() {
        if (sessionSaveTimer) window.clearTimeout(sessionSaveTimer);
        sessionSaveTimer = window.setTimeout(function () {
            sessionSaveTimer = null;
            saveNow();
        }, SESSION_SAVE_DELAY);
    }

    function copyMessages(session) {
        if (!session) return [];
        return session.messages.map(function (m) {
            var out = { role: m.role, content: m.content };
            // 过程留档要拷一份：直接把 store 里的对象给出去，调用方一改就改了存储
            if (m.process) {
                out.process = {
                    think: m.process.think || '',
                    tools: (m.process.tools || []).map(function (t) {
                        return { name: t.name, status: t.status, detail: t.detail };
                    }),
                    sources: (m.process.sources || []).map(function (src) {
                        return { url: src.url, title: src.title, kind: src.kind };
                    }),
                    toolTotal: m.process.toolTotal || 0,
                    links: (m.process.links || []).map(function (l) {
                        return { text: l.text, url: l.url };
                    })
                };
            }
            return out;
        });
    }

    /*
     * 过程数据只用来「回头看」，永远不发给模型。
     * 上限写死在这里：思考留首 4000 字、工具留最近 12 次、来源留 20 条，
     * 否则一个长会话的 localStorage 会顶到配额，连正文都存不进去。
     */
    var PROCESS_TEXT_LIMIT = 4000;
    var PROCESS_TOOL_LIMIT = 12;
    var PROCESS_SOURCE_LIMIT = 50;
    var PROCESS_LINK_LIMIT = 40;

    function clip(value, limit) {
        var text = typeof value === 'string' ? value : String(value == null ? '' : value);
        text = text.trim();
        return text.length > limit ? text.slice(0, limit) + '…' : text;
    }

    function sanitizeProcess(input) {
        if (!input || typeof input !== 'object') return null;
        var proc = {};

        var think = clip(input.think, PROCESS_TEXT_LIMIT);
        if (think) proc.think = think;

        var tools = [];
        var toolTotal = 0;
        if (Array.isArray(input.tools)) {
            toolTotal = input.tools.length;
            input.tools.slice(-PROCESS_TOOL_LIMIT).forEach(function (one) {
                if (!one) return;
                var entry = { name: clip(one.name, 40), status: clip(one.status, 20) };
                var detail = clip(one.detail, 200);
                if (detail) entry.detail = detail;
                if (entry.name) tools.push(entry);
            });
        }
        if (tools.length) proc.tools = tools;
        // 真实次数与留档条数可能不同（只留最近 12 次），摘要要写真实次数
        if (toolTotal) proc.toolTotal = toolTotal;

        // 实时包上的链接清单：回看时原样恢复，保证刷新前后一致
        var links = [];
        if (Array.isArray(input.links)) {
            input.links.slice(0, PROCESS_LINK_LIMIT).forEach(function (one) {
                if (!one) return;
                var text = clip(one.text, 120);
                var url = clip(one.url, 300);
                if (text && url) links.push({ text: text, url: url });
            });
        }
        if (links.length) proc.links = links;

        var sources = [];
        if (Array.isArray(input.sources)) {
            // 引用过的来源排在前面再截断：候选满了 20 条时，
            // 真正读过的正文不能被截掉
            var orderedSources = input.sources.slice().sort(function (a, b) {
                return (a && a.kind === 'quoted' ? 0 : 1) - (b && b.kind === 'quoted' ? 0 : 1);
            });
            orderedSources.slice(0, PROCESS_SOURCE_LIMIT).forEach(function (one) {
                if (!one) return;
                var url = clip(one.url, 300);
                // 标题别截太短：截断后正文里的标题就匹配不上了，链接会消失
                var title = clip(one.title, 200);
                if (!url && !title) return;
                sources.push({ url: url, title: title, kind: one.kind === 'quoted' ? 'quoted' : 'candidate' });
            });
        }
        if (sources.length) proc.sources = sources;

        if (!proc.think && !proc.tools && !proc.sources && !proc.links) return null;
        return proc;
    }

    /*
     * 界面自己先动：会话变了就把消息区切成对应的内容。
     * 只认 create/select/remove 三种「当前会话换了」的情况，
     * 追加消息不重画——正文正在流式输出，重画会把流打断。
     */
    function handleStoreChange(reason, session, extra) {
        // 换会话/删会话时确认框必须收掉：它挂在 .ai-root 上，不收会浮在博客页面上
        if (reason === 'select' || reason === 'remove' || reason === 'create') closeRewindConfirm();
        // 回答进行中不重画消息区：主流程这时会把会话切回原来那条，
        // 重画等于把正在流式输出的回答抹掉
        if (!sessionBusy) {
            if (reason === 'create') {
                paintSessionMessages([], session ? session.id : null);
            } else if (reason === 'select') {
                var id = session ? session.id : null;
                var stored = copyMessages(session);
                // 同一条会话一般不画第二次：消息区已经是它了。
                // 但存储比画面多时（消息只写进了存储、没落到消息区）要补画，
                // 否则切回这条会话只剩一片空白
                if (id !== paintedSessionId || paintedMessageCount() < stored.length) {
                    paintSessionMessages(stored, id);
                }
            } else if (reason === 'remove') {
                var removed = extra && extra.removedId ? extra.removedId : null;
                // 删掉的正是消息区里那条：换成新当前会话的正文
                if (removed && removed === paintedSessionId) {
                    paintSessionMessages(copyMessages(session), session ? session.id : null);
                }
            }
        }
        updateSessionLabel();
        if (refs.sessionPanel && !refs.sessionPanel.hidden) renderSessionList();
    }

    /* 通知外部订阅者：只在会话本身变了的时候喊一声 */
    function notifySessionChange(reason, session, extra) {
        var payload = {
            id: session ? session.id : null,
            title: session ? session.title : '',
            messages: copyMessages(session),
            reason: reason
        };
        if (extra) {
            for (var key in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
            }
        }
        handleStoreChange(reason, session, extra);
        for (var i = 0; i < sessionCallbacks.length; i++) {
            try {
                sessionCallbacks[i](payload);
            } catch (e) {
                // 订阅者出错不能连累会话本身
            }
        }
    }

    function sessionsList() {
        var s = store();
        var out = [];
        for (var i = 0; i < s.sessions.length; i++) {
            var one = s.sessions[i];
            out.push({
                id: one.id,
                title: one.title,
                updatedAt: one.updatedAt,
                messageCount: one.messages.length
            });
        }
        // 最近动过的排前面
        out.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        return out;
    }

    function sessionsCurrentId() {
        var s = store();
        return s.currentId || null;
    }

    /* 只留最近的若干条，当前会话永远留着 */
    function trimSessions(s) {
        if (s.sessions.length <= SESSION_LIMIT) return;
        var keep = s.sessions.slice().sort(function (a, b) {
            return b.createdAt - a.createdAt;
        }).slice(0, SESSION_LIMIT);
        var kept = [];
        for (var i = 0; i < s.sessions.length; i++) {
            var one = s.sessions[i];
            var inKeep = false;
            for (var j = 0; j < keep.length; j++) {
                if (keep[j].id === one.id) { inKeep = true; break; }
            }
            if (inKeep || one.id === s.currentId) kept.push(one);
        }
        s.sessions = kept;
    }

    function sessionsCreate(title) {
        var s = store();
        var now = Date.now();
        // 时间戳严格递增：同一毫秒里建两条会话，排序才分得出先后
        for (var i = 0; i < s.sessions.length; i++) {
            if (s.sessions[i].createdAt >= now) now = s.sessions[i].createdAt + 1;
        }
        var session = {
            id: newSessionId(),
            title: typeof title === 'string' ? title.trim() : '',
            createdAt: now,
            updatedAt: now,
            messages: []
        };
        s.sessions.push(session);
        trimSessions(s);
        s.currentId = session.id;
        scheduleSave();
        notifySessionChange('create', session);
        return session;
    }

    function sessionsSelect(id) {
        var s = store();
        var session = findSessionIn(s, id);
        if (!session) return null;
        s.currentId = session.id;
        scheduleSave();
        notifySessionChange('select', session);
        return session;
    }

    function sessionsRemove(id) {
        var s = store();
        var session = findSessionIn(s, id);
        if (!session) return false;
        var wasCurrent = s.currentId === id;
        s.sessions.splice(s.sessions.indexOf(session), 1);
        if (wasCurrent) {
            // 当前会话被删：切到最近动过的那条，一条都不剩就落空
            var next = null;
            for (var i = 0; i < s.sessions.length; i++) {
                if (!next || s.sessions[i].updatedAt > next.updatedAt) next = s.sessions[i];
            }
            s.currentId = next ? next.id : null;
        }
        scheduleSave();
        notifySessionChange('remove', findSessionIn(s, s.currentId), { removedId: id });
        return true;
    }

    function sessionsRename(id, title) {
        var s = store();
        var session = findSessionIn(s, id);
        if (!session) return false;
        var name = typeof title === 'string' ? title.trim() : '';
        if (!name) return false;
        session.title = name;
        session.updatedAt = Date.now();
        scheduleSave();
        notifySessionChange('rename', session);
        return true;
    }

    function sessionsAppendMessage(msg) {
        var s = store();
        var session = findSessionIn(s, s.currentId);
        if (!session) {
            // 还没有会话就先开一条，消息不能因为没建会话而丢
            session = sessionsCreate();
        }
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return null;
        var content = typeof msg.content === 'string' ? msg.content : '';
        var entry = { role: msg.role, content: content };
        var proc = sanitizeProcess(msg.process);
        if (proc) entry.process = proc;
        session.messages.push(entry);
        if (session.messages.length > SESSION_MESSAGE_LIMIT) {
            session.messages.splice(0, session.messages.length - SESSION_MESSAGE_LIMIT);
        }
        session.updatedAt = Date.now();
        if (!session.title && msg.role === 'user') {
            // 没给标题就用第一条用户消息开头当标题
            session.title = content.replace(/\s+/g, ' ').trim().slice(0, SESSION_TITLE_LIMIT);
        }
        scheduleSave();
        // 追加消息只让界面自己知道（标题可能刚被填上），不惊动外部订阅者
        handleStoreChange('append', session);
        return { role: msg.role, content: content };
    }

    function sessionsSetMessages(messages) {
        var s = store();
        var session = findSessionIn(s, s.currentId);
        if (!session) session = sessionsCreate();
        var list = Array.isArray(messages) ? messages : [];
        var clean = [];
        for (var i = 0; i < list.length; i++) {
            var one = list[i];
            if (!one || (one.role !== 'user' && one.role !== 'assistant')) continue;
            var kept = {
                role: one.role,
                content: typeof one.content === 'string' ? one.content : ''
            };
            var keptProcess = sanitizeProcess(one.process);
            if (keptProcess) kept.process = keptProcess;
            clean.push(kept);
        }
        if (clean.length > SESSION_MESSAGE_LIMIT) {
            clean = clean.slice(clean.length - SESSION_MESSAGE_LIMIT);
        }
        session.messages = clean;
        session.updatedAt = Date.now();
        scheduleSave();
        handleStoreChange('set', session);
        return copyMessages(session);
    }

    function sessionsGetMessages(id) {
        var s = store();
        var session = findSessionIn(s, id || s.currentId);
        return copyMessages(session);
    }

    /* ------------------------------------------------------------ 会话界面 */

    /*
     * 面板里的会话入口：标题栏右边一个按钮，点开是历史会话列表。
     * 列表只存文字，工具过程不跨会话恢复，所以恢复后要补一行说明。
     */
    function formatSessionTime(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var now = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
            return pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
        return (d.getMonth() + 1) + '/' + d.getDate();
    }

    /* 消息区现在画着几条消息：用来判断画面是不是落后于存储 */
    function paintedMessageCount() {
        if (!refs.stream) return 0;
        return refs.stream.querySelectorAll('.ai-msg').length;
    }

    function paintSessionMessages(messages, sessionId) {
        if (!refs.stream) return;
        var list = Array.isArray(messages) ? messages : [];
        refs.stream.innerHTML = '';
        paintedSessionId = sessionId || null;
        // 空状态是 buildPanel 建的常驻节点，清空消息区后要接回去
        if (refs.emptyState) {
            refs.stream.appendChild(refs.emptyState);
            refs.emptyState.hidden = list.length > 0;
        }
        for (var i = 0; i < list.length; i++) {
            var one = list[i];
            if (!one || (one.role !== 'user' && one.role !== 'assistant')) continue;
            var isUser = one.role === 'user';
            var msg = el('article', 'ai-msg ' + (isUser ? 'ai-msg-user ai-msg--user' : 'ai-msg-ai ai-msg--assistant'));
            // 过程在答案上方：思考与工具调用结束时只折叠、不搬位置。
            // 时间线是消息流的兄弟节点（与实时一致）——塞进气泡容器里，
            // 两套布局的间距规则不同，刷新前后会长得不一样。
            var timeline = null;
            if (!isUser && one.process) {
                timeline = renderStoredProcess(one.process);
            }
            var body = el('div', 'ai-bubble');
            // 空正文（这一轮只留下了过程）不画空气泡，只留时间线与来源
            if (!isUser && !one.content) {
                if (timeline) refs.stream.appendChild(timeline);
                if (one.process && one.process.sources && one.process.sources.length) {
                    msg.appendChild(renderSourceList(one.process.sources));
                }
                refs.stream.appendChild(msg);
                continue;
            }
            if (isUser) {
                var row = el('div', 'ai-msg-row');
                row.appendChild(attachRewind(msg, body, i));
                row.appendChild(body);
                msg.appendChild(row);
            } else {
                msg.appendChild(body);
            }
            body.innerHTML = renderMarkdown(one.content || '');
            // 回看时也要能点：先按留档的链接清单原样恢复（与实时完全一致），
            // 再用来源兜底（老会话没有清单时才走这条）
            if (!isUser && one.process) {
                if (one.process.links && one.process.links.length) {
                    applyStoredLinks(body, one.process.links);
                } else if (one.process.sources) {
                    linkifySources(body, one.process.sources);
                }
            }
            if (!isUser && one.process && one.process.sources && one.process.sources.length) {
                // 历史来源同样按 5 条一组铺开，不一口气全展开
                msg.appendChild(renderSourceList(one.process.sources));
            }
            if (timeline) refs.stream.appendChild(timeline);
            refs.stream.appendChild(msg);
        }
        // 旧节点都被清掉了，指向它们的引用要跟着清
        errorNode = null;
        pendingNode = null;
        processNode = null;
        processBody = null;
        refs.answerMsg = null;
        // 重画完落在最新一条：读者要的是刚问的那轮答案，
        // 停在最早一条就得一路往下滑才看得到
        scrollToBottom();
    }

    function updateSessionLabel() {
        if (!refs.sessionLabel) return;
        var id = sessionsCurrentId();
        var session = id ? findSessionIn(store(), id) : null;
        var title = session && session.title ? session.title : '新会话';
        refs.sessionLabel.textContent = title;
        if (refs.sessionButton) {
            refs.sessionButton.setAttribute('aria-label', '会话：' + title);
        }
        applySessionBusyState();
    }

    /* 回答进行中把会话操作锁掉：这是防止半路换会话的唯一实际防线 */
    function applySessionBusyState() {
        if (refs.sessionButton) {
            refs.sessionButton.disabled = sessionBusy;
            refs.sessionButton.setAttribute('aria-disabled', sessionBusy ? 'true' : 'false');
        }
        if (refs.sessionNew) {
            refs.sessionNew.disabled = sessionBusy;
            refs.sessionNew.setAttribute('aria-disabled', sessionBusy ? 'true' : 'false');
        }
        if (refs.sessionList) {
            var nodes = refs.sessionList.querySelectorAll('button');
            for (var i = 0; i < nodes.length; i++) {
                nodes[i].disabled = sessionBusy;
                nodes[i].setAttribute('aria-disabled', sessionBusy ? 'true' : 'false');
            }
        }
    }

    function renderSessionList() {
        var list = refs.sessionList;
        if (!list) return;
        list.textContent = '';
        var items = sessionsList();
        var current = sessionsCurrentId();
        for (var i = 0; i < items.length; i++) {
            var one = items[i];
            var row = el('li', 'ai-session-item');
            row.dataset.sessionId = one.id;
            if (one.id === current) row.setAttribute('aria-current', 'true');
            if (one.id === renamingSessionId) {
                var input = el('input', 'ai-session-rename');
                input.type = 'text';
                input.value = one.title || '';
                input.setAttribute('aria-label', '会话名称');
                row.appendChild(input);
                bindRenameInput(input, one.id);
            } else {
                var pick = el('button', 'ai-session-pick');
                pick.type = 'button';
                pick.dataset.sessionId = one.id;
                pick.appendChild(el('span', 'ai-session-item-title', one.title || '新会话'));
                pick.appendChild(el('span', 'ai-session-item-meta', one.messageCount + ' 条 · ' + formatSessionTime(one.updatedAt)));
                row.appendChild(pick);
                if (one.id === confirmingSessionId) {
                    var confirmBox = el('span', 'ai-session-confirm');
                    confirmBox.appendChild(el('span', 'ai-session-confirm-text', '确认删除？'));
                    var yes = el('button', 'ai-session-op', '删除');
                    yes.type = 'button';
                    yes.dataset.op = 'confirm-delete';
                    yes.dataset.sessionId = one.id;
                    var no = el('button', 'ai-session-op', '取消');
                    no.type = 'button';
                    no.dataset.op = 'cancel-delete';
                    no.dataset.sessionId = one.id;
                    confirmBox.appendChild(yes);
                    confirmBox.appendChild(no);
                    row.appendChild(confirmBox);
                } else {
                    var ops = el('span', 'ai-session-ops');
                    var rename = el('button', 'ai-session-op', '重命名');
                    rename.type = 'button';
                    rename.dataset.op = 'rename';
                    rename.dataset.sessionId = one.id;
                    var del = el('button', 'ai-session-op', '删除');
                    del.type = 'button';
                    del.dataset.op = 'delete';
                    del.dataset.sessionId = one.id;
                    ops.appendChild(rename);
                    ops.appendChild(del);
                    row.appendChild(ops);
                }
            }
            list.appendChild(row);
            // 改名输入框要等进了文档再聚焦:游离节点上 focus() 是空操作,
            // 表现为改名框看着出来了却没焦点,敲的字全落到页面上
            if (pendingRenameFocus && one.id === renamingSessionId) {
                var renameInput = row.querySelector('.ai-session-rename');
                if (renameInput) {
                    renameInput.focus();
                    renameInput.select();
                }
            }
        }
        pendingRenameFocus = false;
        if (!items.length) {
            list.appendChild(el('li', 'ai-session-empty', '还没有历史会话'));
        }
        applySessionBusyState();
    }

    function bindRenameInput(input, id) {
        var done = false;
        function finish(save) {
            if (done) return;
            done = true;
            var value = input.value.trim();
            renamingSessionId = null;
            if (save && value) {
                sessionsRename(id, value);
            } else {
                renderSessionList();
            }
        }
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                finish(true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
            }
        });
        input.addEventListener('blur', function () { finish(true); });
        // 焦点与全选不能在这里做:此刻 input 还没进文档,
        // 对游离节点 focus()/select() 都是空操作。
        // 真正的聚焦在 renderSessionList() 把行挂上之后做。
    }

    function onSessionPanelClick(event) {
        var target = event.target;
        if (!target || !target.closest) return;
        // 改名输入框里的点击不算「选中这条会话」
        if (target.closest('.ai-session-rename')) return;
        var opNode = target.closest('[data-op]');
        if (opNode) {
            var op = opNode.dataset.op;
            var opId = opNode.dataset.sessionId || '';
            if (op === 'new') {
                onSessionNewClick();
            } else if (op === 'rename') {
                renamingSessionId = opId;
                confirmingSessionId = null;
                // 下一轮重画要把焦点抢到改名输入框上
                pendingRenameFocus = true;
                renderSessionList();
            } else if (op === 'delete') {
                confirmingSessionId = opId;
                renamingSessionId = null;
                renderSessionList();
            } else if (op === 'confirm-delete') {
                confirmingSessionId = null;
                sessionsRemove(opId);
                closeSessionPanel();
            } else if (op === 'cancel-delete') {
                confirmingSessionId = null;
                renderSessionList();
            }
            return;
        }
        var pick = target.closest('[data-session-id]');
        if (pick && !sessionBusy) {
            sessionsSelect(pick.dataset.sessionId);
            closeSessionPanel();
        }
    }

    function onSessionNewClick() {
        if (sessionBusy) return;
        sessionsCreate();
        closeSessionPanel();
        if (refs.composer) refs.composer.focus();
    }

    function toggleSessionPanel() {
        if (sessionBusy) return;
        var panel = refs.sessionPanel;
        if (!panel) return;
        if (panel.hidden) {
            renamingSessionId = null;
            confirmingSessionId = null;
            renderSessionList();
            panel.hidden = false;
            if (refs.sessionButton) refs.sessionButton.setAttribute('aria-expanded', 'true');
            positionSessionPanel();
        } else {
            closeSessionPanel();
        }
    }

    function closeSessionPanel() {
        var panel = refs.sessionPanel;
        if (!panel) return;
        panel.hidden = true;
        renamingSessionId = null;
        confirmingSessionId = null;
        if (refs.sessionButton) refs.sessionButton.setAttribute('aria-expanded', 'false');
    }

    /* 下拉挂在根节点上：面板本身 overflow:hidden 会把长列表裁掉 */
    function positionSessionPanel() {
        var panel = refs.sessionPanel;
        var button = refs.sessionButton;
        if (!panel || !button) return;
        var box = button.getBoundingClientRect();
        var width = panel.offsetWidth || 240;
        var left = box.right - width;
        // 贴右边缘时别把面板推到屏幕外
        if (left < 8) left = 8;
        if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
        panel.style.left = left + 'px';
        panel.style.top = (box.bottom + 4) + 'px';
    }

    function buildSessionPanel(panel) {
        var wrap = el('div', 'ai-session-wrap');

        var button = el('button', 'ai-session-btn');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'true');
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', '会话');
        // 文字样式沿用 .ai-select-text 这一套（省略号、收窄），只是类名多带一个会话标记
        button.appendChild(el('span', 'ai-select-text ai-session-label', '新会话'));
        button.appendChild(icon(ICONS.chevron, 'ai-chevron'));
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            toggleSessionPanel();
        });
        wrap.appendChild(button);
        refs.sessionButton = button;
        refs.sessionLabel = button.querySelector('.ai-session-label');

        var dropdown = el('div', 'ai-session-panel');
        dropdown.hidden = true;
        dropdown.setAttribute('role', 'group');
        dropdown.setAttribute('aria-label', '历史会话');

        var newBtn = el('button', 'ai-session-new', '新建会话');
        newBtn.type = 'button';
        newBtn.dataset.op = 'new';
        dropdown.appendChild(newBtn);
        refs.sessionNew = newBtn;

        var list = el('ul', 'ai-session-list');
        dropdown.appendChild(list);
        refs.sessionList = list;

        dropdown.addEventListener('click', onSessionPanelClick);
        refs.sessionPanel = dropdown;
        // 下拉挂到根节点：面板有 overflow:hidden，长列表会被裁掉；
        // 根节点没有 transform，fixed 定位仍以视口为准
        if (refs.root) refs.root.appendChild(dropdown);
        return wrap;
    }

    AI.sessions = {
        list: sessionsList,
        currentId: sessionsCurrentId,
        create: sessionsCreate,
        select: sessionsSelect,
        remove: sessionsRemove,
        rename: sessionsRename,
        appendMessage: sessionsAppendMessage,
        setMessages: sessionsSetMessages,
        getMessages: sessionsGetMessages
    };

    /* ------------------------------------------------------------ 骨架组件 */

    function buildFab() {
        var fab = el('button', 'ai-fab');
        fab.type = 'button';
        fab.setAttribute('aria-label', '打开 12 助手');
        fab.setAttribute('aria-expanded', 'false');
        fab.setAttribute('aria-controls', 'ai-panel');
        // 悬浮球用用户给的图（source/ai-assistant/fab.jpg），不再用矢量图标
        var glyph = document.createElement('img');
        glyph.className = 'ai-fab-glyph';
        glyph.src = FAB_IMAGE;
        glyph.alt = '';
        // 原生图片默认可拖：一旦浏览器启动图片拖拽就不再发 pointermove，
        // 悬浮球的 pointer 拖拽会中途断掉，看起来就是「拖不动」。
        glyph.setAttribute('draggable', 'false');
        fab.appendChild(glyph);
        return fab;
    }

    function buildHead(panel) {
        var head = el('header', 'ai-panel-head');

        /*
         * 窄屏抽屉的抓手：宽屏不显示（浮窗是拖着球走的，不需要抓手），
         * 窄屏才出现这一条细横条。抓手只留视觉，不再挂提示文字。
         */
        var grip = el('div', 'ai-panel-grip');
        head.appendChild(grip);

        var row = el('div', 'ai-head-row');
        row.appendChild(el('h2', 'ai-panel-title', '12 助手'));

        // 会话入口：当前会话标题 + 历史会话下拉
        row.appendChild(buildSessionPanel(panel));

        var actions = el('div', 'ai-head-actions');
        // 视图切换用下划线标签，跟标题排在一行里，不做成又一块控件
        var views = el('div', 'ai-tabs');
        views.setAttribute('role', 'tablist');
        views.setAttribute('aria-label', '助手视图');
        [['chat', '对话'], ['settings', '设置']].forEach(function (item) {
            var seg = el('button', 'ai-seg', item[1]);
            seg.type = 'button';
            seg.setAttribute('role', 'tab');
            seg.dataset.state = item[0];
            seg.setAttribute('aria-selected', item[0] === 'chat' ? 'true' : 'false');
            views.appendChild(seg);
        });
        actions.appendChild(views);

        var close = el('button', 'ai-icon-btn');
        close.type = 'button';
        close.dataset.act = 'close';
        close.setAttribute('aria-label', '关闭助手');
        close.appendChild(icon(ICONS.close));
        actions.appendChild(close);
        row.appendChild(actions);
        head.appendChild(row);

        return head;
    }

    function lineField(labelText, name, type, placeholder) {
        var wrap = el('div', 'ai-field');
        var label = el('label', 'ai-label', labelText);
        label.setAttribute('for', 'ai-' + name);
        wrap.appendChild(label);
        var input = el('input', 'ai-input-line');
        input.type = type;
        input.id = 'ai-' + name;
        input.dataset.field = name;
        input.spellcheck = false;
        input.autocomplete = 'off';
        if (placeholder) input.placeholder = placeholder;
        wrap.appendChild(input);
        return wrap;
    }

    function keyField() {
        var wrap = el('div', 'ai-field');
        var label = el('label', 'ai-label', 'API Key');
        label.setAttribute('for', 'ai-apiKey');
        wrap.appendChild(label);

        var secret = el('div', 'ai-secret');
        var input = el('input', 'ai-input-line');
        input.type = 'password';
        input.id = 'ai-apiKey';
        input.dataset.field = 'apiKey';
        input.spellcheck = false;
        input.autocomplete = 'off';
        secret.appendChild(input);

        var toggle = el('button', 'ai-secret-toggle', '显示');
        toggle.type = 'button';
        toggle.dataset.act = 'toggle-key';
        toggle.setAttribute('aria-pressed', 'false');
        secret.appendChild(toggle);
        refs.keyInput = input;
        refs.keyToggle = toggle;

        wrap.appendChild(secret);
        return wrap;
    }

    /*
     * 系统提示词预设用自绘下拉，不用原生 select：
     * 原生控件在深浅两套主题里都是浏览器外观，和整块面板不搭。
     */
    function presetField() {
        var wrap = el('div', 'ai-field');
        var label = el('label', 'ai-label', '系统提示词预设');
        label.setAttribute('for', 'ai-preset-btn');
        wrap.appendChild(label);

        var select = el('div', 'ai-select');
        var button = el('button', 'ai-select-btn');
        button.type = 'button';
        button.id = 'ai-preset-btn';
        button.dataset.act = 'preset-toggle';
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-expanded', 'false');
        var text = el('span', 'ai-select-text', '文章问答助手');
        text.id = 'ai-preset-text';
        button.appendChild(text);
        button.appendChild(icon(ICONS.chevron, 'ai-chevron'));
        select.appendChild(button);

        var list = el('ul', 'ai-select-list');
        list.id = 'ai-preset-list';
        list.setAttribute('role', 'listbox');
        list.hidden = true;
        select.appendChild(list);

        refs.presetButton = button;
        refs.presetList = list;
        refs.presetText = text;
        wrap.appendChild(select);

        var textarea = el('textarea', 'ai-textarea');
        textarea.id = 'ai-systemPrompt';
        textarea.dataset.field = 'systemPrompt';
        textarea.rows = 4;
        wrap.appendChild(textarea);
        return wrap;
    }

    /* 一个分组：标题 + 一块灰底卡片，卡片之间靠灰阶分开，不靠发丝线 */
    function sectionCard(title) {
        var section = el('section', 'ai-section');
        section.appendChild(el('h3', 'ai-section-title', title));
        var card = el('div', 'ai-section-card');
        section.appendChild(card);
        return { section: section, card: card };
    }


    /* --------------------------------------------------------- 最近用过的模型 */
    var RECENT_MODELS_KEY = 'ai-assistant.recent-models';

    function readRecentModels() {
        try {
            var list = JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) || '[]');
            if (!Array.isArray(list)) return [];
            return list.filter(function (item) { return typeof item === 'string' && item; }).slice(0, 5);
        } catch (e) {
            return [];
        }
    }

    function writeRecentModels(list) {
        try {
            window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(list.slice(0, 5)));
        } catch (e) {
            /* 存不下就只影响下次的胶囊 */
        }
    }

    /* 保存配置时把当前模型推到最前面，去重后留 5 个 */
    function rememberModel(name) {
        var value = String(name || '').trim();
        if (!value) return;
        var list = readRecentModels().filter(function (item) { return item !== value; });
        list.unshift(value);
        writeRecentModels(list);
        renderModelChips();
    }

    function renderModelChips() {
        var host = refs.modelChips;
        if (!host) return;
        var list = readRecentModels();
        host.innerHTML = '';
        host.hidden = !list.length;
        list.slice(0, 3).forEach(function (name) {
            var chip = el('button', 'ai-model-chip', name);
            chip.type = 'button';
            chip.dataset.model = name;
            chip.addEventListener('click', function () {
                var input = document.querySelector('.ai-input-line[data-field="model"]');
                if (!input) return;
                input.value = name;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            host.appendChild(chip);
        });
    }

    function buildSettings() {
        var wrap = el('div', 'ai-settings');

        /* 连接：协议、地址、密钥、模型 */
        var conn = sectionCard('连接');

        var protocol = el('div', 'ai-field');
        var protocolLabel = el('span', 'ai-label', '协议');
        protocolLabel.id = 'ai-protocol-label';
        protocol.appendChild(protocolLabel);
        var segs = el('div', 'ai-segmented');
        segs.setAttribute('role', 'radiogroup');
        segs.setAttribute('aria-labelledby', 'ai-protocol-label');
        [['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic Messages']].forEach(function (item) {
            var seg = el('button', 'ai-seg', item[1]);
            seg.type = 'button';
            seg.setAttribute('role', 'radio');
            seg.dataset.protocol = item[0];
            seg.setAttribute('aria-checked', item[0] === 'openai' ? 'true' : 'false');
            segs.appendChild(seg);
        });
        protocol.appendChild(segs);
        conn.card.appendChild(protocol);

        /* 地址下面直接给出最终请求的地址，省掉一整块示例代码 */
        var base = lineField('Base URL', 'baseUrl', 'text', 'https://api.openai.com/v1');
        var endpoint = el('p', 'ai-endpoint', '—');
        refs.endpoint = endpoint;
        base.appendChild(endpoint);
        conn.card.appendChild(base);

        conn.card.appendChild(keyField());
        var modelField = lineField('模型', 'model', 'text', 'gpt-4o-mini');
        conn.card.appendChild(modelField);
        // 最近用过的模型：点了就填。存在独立键里——loadConfig 只回填字符串字段，
        // 数组塞进 ai-assistant.config 刷新后会被静默丢掉。
        var chips = el('div', 'ai-model-chips');
        chips.hidden = true;
        modelField.appendChild(chips);
        refs.modelChips = chips;
        renderModelChips();
        wrap.appendChild(conn.section);

        /* 提示词：预设 + 可以直接改写的正文 */
        var prompt = sectionCard('提示词');
        prompt.card.appendChild(presetField());
        wrap.appendChild(prompt.section);

        return wrap;
    }

    function buildComposer() {
        var composer = el('footer', 'ai-composer');

        var quote = el('div', 'ai-quote');
        quote.hidden = true;
        var quoteBody = el('div', 'ai-quote-body');
        var quotePath = el('p', 'ai-quote-path');
        var quoteText = el('p', 'ai-quote-text');
        quoteBody.appendChild(quotePath);
        quoteBody.appendChild(quoteText);
        quote.appendChild(quoteBody);
        var quoteClear = el('button', 'ai-quote-clear', '移除');
        quoteClear.type = 'button';
        quoteClear.dataset.act = 'clear-quote';
        quoteClear.setAttribute('aria-label', '移除引用');
        quote.appendChild(quoteClear);
        refs.quoteBox = quote;
        refs.quotePath = quotePath;
        refs.quoteText = quoteText;
        composer.appendChild(quote);

        /*
         * 灰底输入框只包住多行输入区，按钮都在框外：
         * 输入区随行数长高时只有它变，右边这一列按钮位置与大小不变。
         */
        var row = el('div', 'ai-composer-row');
        var box = el('div', 'ai-input-row');
        /*
         * 上下文开关放在灰框里、紧挨发送键：它决定这一问带不带博客内容
         * （关掉就是纯聊天，既不注入当前小节，也不提供站内工具）。
         * 不进框外的按钮列——那一列会比单行输入框高，顶上会多出一条空白。
         */
        var context = el('button', 'ai-context-toggle');
        context.type = 'button';
        context.dataset.act = 'toggle-context';
        context.setAttribute('role', 'switch');
        context.setAttribute('aria-checked', 'true');
        context.setAttribute('aria-label', '携带博客上下文');
        context.setAttribute('title', '携带博客上下文（关闭后纯聊天，不查博客）');
        context.appendChild(icon(ICONS.context));
        refs.contextToggle = context;

        var input = el('textarea', 'ai-input');
        input.rows = 1;
        input.setAttribute('aria-label', '输入问题');
        input.placeholder = '就本文提问，Enter 发送，Shift+Enter 换行';
        refs.composer = input;
        box.appendChild(input);
        box.appendChild(context);
        row.appendChild(box);

        var send = el('button', 'ai-send');
        send.type = 'button';
        send.dataset.act = 'send';
        send.setAttribute('aria-label', '发送');
        send.disabled = true;
        send.appendChild(icon(ICONS.send));
        refs.sendBtn = send;
        row.appendChild(send);

        composer.appendChild(row);
        // 切换开关的瞬时反馈：2 秒后自己消失，不占固定高度
        var toast = el('p', 'ai-toast');
        toast.hidden = true;
        refs.toast = toast;
        composer.appendChild(toast);
        // 设置视图下要整块收起输入区，只藏 textarea 会剩一个孤零零的发送按钮
        refs.composerBox = composer;
        return composer;
    }

    function buildSettingsFoot() {
        var foot = el('div', 'ai-settings-foot');
        foot.hidden = true;
        /* 左边放一句落地的说明，右边才是唯一的保存动作，别让整条底栏只剩一个按钮 */
        var left = el('div', 'ai-foot-left');
        left.appendChild(el('p', 'ai-foot-note', '密钥与配置只存在这台浏览器'));
        var saved = el('span', 'ai-saved', '已保存');
        refs.saved = saved;
        left.appendChild(saved);
        foot.appendChild(left);
        var save = el('button', 'ai-btn ai-btn-primary', '保存配置');
        save.type = 'button';
        save.dataset.act = 'save';
        foot.appendChild(save);
        refs.settingsFoot = foot;
        return foot;
    }

    function buildPanel() {
        var panel = el('section', 'ai-panel');
        panel.id = 'ai-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '12 助手');
        panel.setAttribute('tabindex', '-1');
        panel.hidden = true;

        panel.appendChild(buildHead(panel));

        var body = el('div', 'ai-panel-body');
        var main = el('div', 'ai-main');
        var views = el('div', 'ai-views');

        var chat = el('section', 'ai-view ai-view-chat');
        chat.dataset.view = 'chat';
        chat.setAttribute('aria-label', '对话');
        var stream = el('div', 'ai-stream');
        stream.setAttribute('role', 'log');
        stream.setAttribute('aria-live', 'polite');
        // 空状态只留一句话：面板刚打开时要说清能干什么，又不能画成插画
        var empty = el('p', 'ai-empty', '还没有对话。挑一节问，助手会带上这一节的正文。');
        refs.emptyState = empty;
        stream.appendChild(empty);
        refs.stream = stream;
        chat.appendChild(stream);

        /*
         * 滚动导航：底部一个「回到最新」，顶部一个「上一条回复」。
         * 顶部箭头每点一次往上跳一条助手回答，连点就能一路翻上去。
         */
        var scrollUp = el('button', 'ai-scroll-up');
        scrollUp.type = 'button';
        scrollUp.setAttribute('aria-label', '跳到上一条回复');
        scrollUp.appendChild(icon(ICONS.chevronUp, 'ai-scroll-mark'));
        scrollUp.hidden = true;
        refs.scrollUp = scrollUp;
        chat.appendChild(scrollUp);
        views.appendChild(chat);
        refs.chatView = chat;

        var settings = el('section', 'ai-view ai-view-settings');
        settings.dataset.view = 'settings';
        settings.setAttribute('aria-label', '设置');
        settings.hidden = true;
        var settingsForm = buildSettings();
        refs.settingsForm = settingsForm;
        settings.appendChild(settingsForm);
        views.appendChild(settings);
        refs.settingsView = settings;

        var scrollDown = el('button', 'ai-scroll-down');
        scrollDown.type = 'button';
        scrollDown.setAttribute('aria-label', '回到最新消息');
        scrollDown.appendChild(icon(ICONS.chevronDown, 'ai-scroll-mark'));
        scrollDown.hidden = true;
        refs.scrollDown = scrollDown;

        chat.appendChild(scrollDown);
        main.appendChild(views);
        main.appendChild(buildComposer());
        main.appendChild(buildSettingsFoot());
        body.appendChild(main);
        panel.appendChild(body);
        return panel;
    }

    /*
     * 滚动导航的两个箭头：不在底部就冒出「回到最新」，
     * 往上滑就冒出「上一条回复」。顶部箭头每点一次往上跳一条助手回答。
     */
    function atBottom() {
        if (!refs.stream) return true;
        return refs.stream.scrollHeight - refs.stream.scrollTop - refs.stream.clientHeight <= 4;
    }

    function previousReplyAbove(top) {
        if (!refs.stream) return null;
        var replies = refs.stream.querySelectorAll('.ai-msg-ai');
        var target = null;
        for (var i = 0; i < replies.length; i++) {
            if (replyTop(replies[i]) < top - 4) target = replies[i];
        }
        return target;
    }

    function replyTop(node) {
        // offsetTop 是相对 offsetParent（.ai-view-chat），而 scrollTop 是
        // .ai-stream 的内容坐标，两者差一个 padding——用 rect 换算才不会每次差 16px
        if (!refs.stream) return node.offsetTop;
        return node.getBoundingClientRect().top - refs.stream.getBoundingClientRect().top + refs.stream.scrollTop;
    }

    function updateScrollArrows() {
        if (!refs.stream) return;
        var bottom = atBottom();
        if (refs.scrollDown) refs.scrollDown.hidden = bottom;
        if (refs.scrollUp) {
            // 顶部箭头只在真的能往上跳时才出现
            refs.scrollUp.hidden = refs.stream.scrollTop <= 4 || !previousReplyAbove(refs.stream.scrollTop);
        }
    }

    function jumpToPreviousReply() {
        if (!refs.stream) return false;
        var target = previousReplyAbove(refs.stream.scrollTop);
        if (!target) return false;
        refs.stream.scrollTop = Math.max(0, replyTop(target) - 8);
        updateScrollArrows();
        return true;
    }

    function wireScrollArrows() {
        if (!refs.stream) return;
        refs.stream.addEventListener('scroll', function () {
            updateScrollArrows();
        }, { passive: true });
        if (refs.scrollDown) {
            refs.scrollDown.addEventListener('click', function () {
                scrollToBottom();
                updateScrollArrows();
            });
        }
        if (refs.scrollUp) {
            refs.scrollUp.addEventListener('click', function () {
                jumpToPreviousReply();
            });
        }
    }

    function mount() {
        var root = el('div', 'ai-root');
        refs.root = root;

        var fab = buildFab();
        refs.fab = fab;
        root.appendChild(fab);

        var panel = buildPanel();
        refs.panel = panel;
        root.appendChild(panel);

        var bubble = el('button', 'ai-selection-bubble', '问 AI');
        bubble.type = 'button';
        bubble.hidden = true;
        refs.bubble = bubble;
        root.appendChild(bubble);

        document.body.appendChild(root);
        wireScrollArrows();
        // 标题栏要显示当前会话名，进来就得先对一次
        updateSessionLabel();
        // 设置区滚动时，下拉要跟着按钮走，否则会脱离按钮悬在半空
        refs.settingsForm.addEventListener('scroll', function () {
            if (!refs.presetList.hidden) positionPresetList();
        });
        // 会话下拉点外面就收起来：主流程只管预设列表，这里自己收
        document.addEventListener('click', function (event) {
            if (!refs.sessionPanel || refs.sessionPanel.hidden) return;
            // 判定「点没点在下拉里」必须用事件路径，不能用 event.target.closest：
            // 点「重命名/删除」时列表会当场重绘，被点的按钮被摘出文档，
            // closest 就找不到下拉容器了，于是这里会把下拉误收起来——
            // 表现为重命名输入框一闪就没、删除确认框点不出来。
            var path = typeof event.composedPath === 'function' ? event.composedPath() : null;
            if (path) {
                for (var i = 0; i < path.length; i++) {
                    if (path[i] === refs.sessionPanel || path[i] === refs.sessionButton) return;
                }
            } else {
                var target = event.target;
                if (target && target.closest &&
                    (target.closest('.ai-session-panel') || target.closest('.ai-session-btn'))) {
                    return;
                }
            }
            closeSessionPanel();
        });
        // 面板高度带 140ms 过渡，过渡过程中要逐帧重新落位，否则浮窗会停在按旧高度
        // 算出来的位置（离球很远）。这件事由 placePanel 自己的「高度变了就再排一次」
        // 循环负责，这里不再另挂 transitionend 监听，两套机制只留一套。
        syncViewport();
        return refs;
    }

    /* ------------------------------------------------------------ 状态切换 */

    /*
     * 窄屏「压下去」：点浮窗外面的区域时，把抽屉往下推、只留头部一条，
     * 再点一下浮窗就回到原高度。它和关闭是两件事——不隐藏、不卸载，
     * 高度也不变，只是 transform 位移，所以恢复时不用重新测量。
     */
    var peeked = false;

    function setPeek(on) {
        var next = !!on && isNarrow();
        peeked = next;
        if (refs.panel) refs.panel.classList.toggle('is-peek', next);
    }

    function isPeek() {
        return peeked;
    }

    function setOpen(open) {
        if (!open) closeRewindConfirm();
        if (open) {
            if (closeTimer) {
                window.clearTimeout(closeTimer);
                closeTimer = null;
            }
            refs.panel.hidden = false;
            refs.root.classList.add('is-open');
            placePanel();
            // 先把面板显示出来再挂 is-open，入场过渡才有起止帧
            window.requestAnimationFrame(function () {
                if (!refs.panel.hidden) refs.panel.classList.add('is-open');
            });
            refs.fab.setAttribute('aria-expanded', 'true');
            // 重新打开就是完整展开，不带着上一次的压下去状态
            setPeek(false);
            // 重开落在最新一条：读者回来就是要看刚问的那轮，
            // 停在最早一条得一路往下滑才看得到
            if (!sessionBusy) scrollToBottom();
            return;
        }
        setPeek(false);
        refs.panel.classList.remove('is-open');
        refs.root.classList.remove('is-open');
        refs.fab.setAttribute('aria-expanded', 'false');
        if (closeTimer) window.clearTimeout(closeTimer);
        // 等关闭过渡走完再补 hidden，否则淡出会被直接抹掉
        closeTimer = window.setTimeout(function () {
            closeTimer = null;
            if (!refs.root.classList.contains('is-open')) refs.panel.hidden = true;
        }, 160);
    }

    function isOpen() {
        return refs.root.classList.contains('is-open');
    }

    function setState(state) {
        var view = state === 'settings' ? 'settings' : 'chat';
        refs.root.dataset.view = view;
        refs.chatView.hidden = view !== 'chat';
        refs.settingsView.hidden = view !== 'settings';
        refs.composerBox.hidden = view === 'settings';
        refs.settingsFoot.hidden = view !== 'settings';
        var segs = refs.panel.querySelectorAll('.ai-seg[data-state]');
        for (var i = 0; i < segs.length; i++) {
            segs[i].setAttribute('aria-selected', segs[i].dataset.state === view ? 'true' : 'false');
        }
        // 设置视图有自己的一套高度，窄屏下别让聊天抽屉拖出来的高度盖住它
        if (refs.panel) {
            if (view === 'settings') {
                refs.panel.style.height = '';
            } else if (isNarrow() && drawerHeight) {
                refs.panel.style.height = drawerHeight + 'px';
            }
        }
        // 设置视图的面板更高，切换后重新落位，把它夹回视口内
        window.requestAnimationFrame(placePanel);
    }

    /*
     * 真正看得见的那块高度：浏览器工具栏压在页面上时，visualViewport 比
     * innerHeight（布局视口）小；软键盘弹起时它也会变小。
     */
    function visibleHeight() {
        var vv = window.visualViewport;
        return vv && vv.height ? vv.height : window.innerHeight;
    }

    /*
     * 可见视口高度写进 --ai-vh，CSS 侧的面板高度按它算。
     * 不能用 100vh：iOS Safari 的 100vh 是工具栏收起时的大视口，比真正看得见的
     * 那块高出一截（iPad 横屏最明显），面板照大视口撑高，底部的「保存配置」
     * 会被顶到屏幕外，既看不见也点不到。
     */
    function syncVisibleHeight() {
        if (!refs.root) return;
        var h = visibleHeight();
        if (!h) return;
        refs.root.style.setProperty('--ai-vh', h + 'px');
    }

    function syncViewport() {
        syncVisibleHeight();
        var narrow = isNarrow();
        refs.root.classList.toggle('is-mobile', narrow);
        // 压下去只属于窄屏抽屉；跨到宽屏就恢复成普通浮窗
        if (!narrow) setPeek(false);
        /*
         * 抽屉高度只对窄屏生效：宽屏要把内联 height 摘掉，
         * 否则窄屏拖出来的那一档高度会跟着浮窗一路带到宽屏去。
         * 记下来的值不丢，回到窄屏再写回去。
         */
        if (refs.panel) {
            if (narrow) {
                if (drawerHeight) refs.panel.style.height = drawerHeight + 'px';
            } else if (refs.panel.style.height) {
                refs.panel.style.height = '';
            }
        }
    }

    /* --------------------------------------------------------- 位置与贴边 */

    // 上一次落位时用到的面板高度，用来判断高度是否还在变
    var placedHeight = 0;
    // 拖动过程中锁住浮窗的展开侧，松手后由调用方解除
    var sideLock = false;

    /*
     * 悬浮球可以自由拖到屏幕任意位置，浮窗跟着球展开，
     * 所以「球在哪」和「窗在哪」都要由 JS 算出来，不能写死在 CSS 里。
     * 桌面端把球的坐标写进 style.left/top，窄屏交给 CSS 的底部抽屉规则。
     */

    function isNarrow() {
        // 优先用 matchMedia，和 CSS 的媒体查询同一套判定；
        // 没有 matchMedia 的环境（jsdom）退回视口宽度
        if (window.matchMedia) {
            return window.matchMedia('(max-width: 767px)').matches;
        }
        return window.innerWidth <= 767;
    }

    /*
     * 紧凑视口（≤1023px）：主题自己的目录按钮出现在右下角
     * （themes/Chic/layout/_partial/toc-mobile.ejs:1，≤1023px 才显示，
     *  位置 bottom/right 1.5rem）。助手浮球落在右下会把它盖住，
     *  所以这一档一律靠左下，和窄屏一致。
     */
    function isCompact() {
        if (window.matchMedia) {
            return window.matchMedia('(max-width: 1023px)').matches;
        }
        return window.innerWidth <= 1023;
    }

    function fabBox() {
        return refs.fab.getBoundingClientRect();
    }

    function setFabPosition(x, y) {
        var box = fabBox();
        var size = box.width || 48;
        var margin = 12;
        var maxX = Math.max(margin, window.innerWidth - size - margin);
        var maxY = Math.max(margin, window.innerHeight - size - margin);
        var left = Math.min(Math.max(x, margin), maxX);
        var top = Math.min(Math.max(y, margin), maxY);

        refs.fab.style.left = Math.round(left) + 'px';
        refs.fab.style.top = Math.round(top) + 'px';
        refs.fab.style.right = 'auto';
        refs.fab.style.bottom = 'auto';
        return { x: Math.round(left), y: Math.round(top) };
    }

    function getFabPosition() {
        return {
            x: parseFloat(refs.fab.style.left) || 0,
            y: parseFloat(refs.fab.style.top) || 0
        };
    }

    /*
     * 浮窗也可以拖：拖动时窗与球一起挪，保持「窗贴着球」的关系不变。
     * 位置直接落在面板上，所以这里要自己夹在视口内。
     */
    function setPanelPosition(x, y) {
        var panel = refs.panel;
        if (!panel) return {x: 0, y: 0};
        var width = panel.offsetWidth || 400;
        var height = panel.offsetHeight || 400;
        var margin = 8;
        var maxX = Math.max(margin, window.innerWidth - width - margin);
        var maxY = Math.max(margin, window.innerHeight - height - margin);
        var left = Math.min(Math.max(x, margin), maxX);
        var top = Math.min(Math.max(y, margin), maxY);
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
        return {x: Math.round(left), y: Math.round(top)};
    }

    /* 默认落位：桌面右下，紧凑与窄屏左下（主题自己在右下有目录球） */
    function defaultFabPosition() {
        var box = fabBox();
        var size = box.width || 48;
        var margin = 24;
        var narrowMargin = 16;
        if (isCompact()) {
            return {
                x: narrowMargin,
                y: Math.max(narrowMargin, window.innerHeight - size - margin)
            };
        }
        return {
            x: Math.max(margin, window.innerWidth - size - margin),
            y: Math.max(margin, window.innerHeight - size - margin)
        };
    }

    /*
     * 浮窗贴球展开：球在左半屏则窗开在右侧，球在右半屏则窗开在左侧；
     * 两侧都放不下就贴视口对侧边缘。垂直方向跟着球那一侧展开（球在上半屏往下开，
     * 在下半屏往上开），再夹在视口内。
     */
    function placePanel() {
        var panel = refs.panel;
        if (!panel || panel.hidden) return;
        if (isNarrow()) {
            panel.style.left = '';
            panel.style.top = '';
            return;
        }
        var fab = fabBox();
        var width = panel.offsetWidth || 400;
        var height = panel.offsetHeight || Math.round(window.innerHeight * 0.66);
        var gap = 16;
        var margin = 8;
        var centerX = fab.left + fab.width / 2;
        // 拖球过程中锁住展开侧：球越过屏幕中线时窗不应翻到另一边，
        // 看着像「拖飞了」。锁只对这一次拖动生效，松手后按球的位置重排。
        var keepRight = sideLock && panel.style.left
            ? (parseFloat(panel.style.left) + width / 2) > centerX
            : centerX < window.innerWidth / 2;
        var left = keepRight
            ? fab.right + gap
            : fab.left - gap - width;
        if (left < margin || left + width > window.innerWidth - margin) {
            var alt = keepRight
                ? fab.left - gap - width
                : fab.right + gap;
            left = (alt >= margin && alt + width <= window.innerWidth - margin)
                ? alt
                : (keepRight ? margin : window.innerWidth - width - margin);
        }
        left = Math.min(Math.max(left, margin), Math.max(margin, window.innerWidth - width - margin));
        // 球在上半屏时窗往下开，在下半屏时窗往上开：浮窗从球这一侧展开，
        // 不用「和球心对齐」——面板比球高时对齐会把窗顶到视口上边，看着像两块不相干的浮层
        // 夹取用「看得见的那块」而不是布局视口：浏览器工具栏压住页面时，
        // 布局视口的下沿在屏幕外，按它落位会把底栏的「保存配置」推到看不见的地方
        var vh = visibleHeight();
        var top = fab.top + fab.height / 2 < vh / 2
            ? fab.bottom + gap
            : fab.top - gap - height;
        top = Math.min(Math.max(top, margin), Math.max(margin, vh - height - margin));
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
        // 面板挪动时，会话下拉要跟着按钮走
        if (refs.sessionPanel && !refs.sessionPanel.hidden) positionSessionPanel();
        // 面板高度是带过渡的（聊天 70vh、设置整屏表单），切换视图时高度还在动，
        // 高度每变一次就得重新落位，否则窗会停在按旧高度算出来的位置
        if (height !== placedHeight) {
            placedHeight = height;
            window.requestAnimationFrame(placePanel);
        }
    }

    /* -------------------------------------------------------------- 上下文 */

    function setContext(info) {
        var article = (info && info.article) || '';
        var section = (info && info.section) || '';
        var quote = (info && info.quote) || '';
        var enabled = info && info.enabled === false ? false : true;

        // 开关在输入区：这里只同步状态与说明，标题栏不再显示读数
        if (refs.contextToggle) {
            refs.contextToggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
            refs.contextToggle.setAttribute('title', enabled
                ? '携带博客上下文（关闭后纯聊天，不查博客）'
                : '纯聊天：不注入文章，也不查博客（点击恢复）');
        }

        refs.quotePath.textContent = section || article || '';
        refs.quoteText.textContent = quote;
        refs.quoteBox.hidden = !quote;
    }

    /*
     * 开关切换后的瞬时反馈：2 秒后自动收起。
     * 用一次性提示而不是固定一行状态字——固定行会把输入区整体顶高。
     */
    var toastTimer = null;
    function showToast(text) {
        if (!refs.toast) return;
        refs.toast.textContent = text || '';
        refs.toast.hidden = false;
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            toastTimer = null;
            if (refs.toast) refs.toast.hidden = true;
        }, 2000);
    }

    /* 统一写输入框：值、可点状态、高度（要回填时再抢焦点）一次处理 */
    function setComposerValue(text) {
        var input = refs.composer;
        if (!input) return;
        input.value = text == null ? '' : String(text);
        if (refs.sendBtn) refs.sendBtn.disabled = !input.value.trim();
        growComposer();
        if (input.value) input.focus();
    }

    /*
     * 输入框随内容长高：先把 height 归零再读 scrollHeight，
     * 否则内容变短（发出去之后）高度降不回去。上限三行由样式的 max-height 兜住。
     *
     * 空输入框固定回一行：占位文案在窄屏会折行，按 scrollHeight 定高会凭空多出
     * 一截高度，看起来像输入框上方多了一块留白。滚动条同理——内容没顶到上限就
     * 关掉 overflow，免得半行高度差把滚动条挤出来。
     */
    function growComposer() {
        var input = refs.composer;
        if (!input) return;
        if (!input.value) {
            input.style.height = '';
            input.style.overflowY = 'hidden';
            return;
        }
        input.style.height = 'auto';
        var max = parseFloat(window.getComputedStyle(input).maxHeight);
        if (!(max > 0)) max = 80;
        var next = input.scrollHeight;
        input.style.height = next + 'px';
        input.style.overflowY = next > max ? 'auto' : 'hidden';
    }

    /* -------------------------------------------------------------- 消息区 */

    function scrollToBottom() {
        refs.stream.scrollTop = refs.stream.scrollHeight;
        updateScrollArrows();
    }

    /*
     * 回退的二次确认：回退会物理删掉后面的内容，没有撤销入口，
     * 所以点一下只是弹确认框，不立刻动手。
     */
    function showRewindConfirm(anchor, index) {
        closeRewindConfirm();
        var box = el('div', 'ai-rewind-confirm');
        box.appendChild(el('span', 'ai-rewind-confirm-text', '回退到这一问之前？后面的内容会删掉。'));
        var actions = el('div', 'ai-rewind-confirm-actions');

        var ok = el('button', 'ai-btn ai-btn-primary', '确认回退');
        ok.type = 'button';
        ok.addEventListener('click', function (event) {
            event.stopPropagation();
            closeRewindConfirm();
            if (rewindHandler) rewindHandler(index);
        });
        actions.appendChild(ok);

        var cancel = el('button', 'ai-btn', '取消');
        cancel.type = 'button';
        cancel.addEventListener('click', function (event) {
            event.stopPropagation();
            closeRewindConfirm();
        });
        actions.appendChild(cancel);

        box.appendChild(actions);
        /*
         * 挂在 .ai-root 里，不挂 body：助手令牌（--ai-surface 等）只定义在
         * .ai-root 上，挂在 body 下会拿不到底色（框变成透明的），
         * 而且 .ai-root 的 z-index 是 10000，body 下的框会被整块助手压在下面。
         */
        (refs.root || document.body).appendChild(box);

        // 贴着按钮放：面板有 overflow，弹到面板里会被裁掉，所以挂到 body 上
        var rect = anchor.getBoundingClientRect();
        var width = box.offsetWidth || 240;
        var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        var top = rect.bottom + 6;
        if (top + (box.offsetHeight || 90) > window.innerHeight) {
            top = Math.max(8, rect.top - (box.offsetHeight || 90) - 6);
        }
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        refs.rewindConfirm = box;

        // 点外面或按 Esc 都算取消
        setTimeout(function () {
            document.addEventListener('click', onRewindConfirmOutside, true);
            document.addEventListener('keydown', onRewindConfirmKey);
        }, 0);
        return box;
    }

    function onRewindConfirmOutside(event) {
        if (refs.rewindConfirm && refs.rewindConfirm.contains(event.target)) return;
        closeRewindConfirm();
    }

    function onRewindConfirmKey(event) {
        if (event.key === 'Escape') closeRewindConfirm();
    }

    function closeRewindConfirm() {
        if (refs.rewindConfirm && refs.rewindConfirm.parentNode) {
            refs.rewindConfirm.parentNode.removeChild(refs.rewindConfirm);
        }
        refs.rewindConfirm = null;
        document.removeEventListener('click', onRewindConfirmOutside, true);
        document.removeEventListener('keydown', onRewindConfirmKey);
    }

    /*
     * 每条用户消息左侧的回退键：点了先把这一问及其之后的全部内容撤掉。
     * 不做分支——直接删，存储与上下文都干净，省掉一套分支管理。
     */
    function attachRewind(msg, bubble, index) {
        var btn = el('button', 'ai-rewind-msg');
        btn.type = 'button';
        btn.dataset.act = 'rewind-msg';
        btn.dataset.rewindIndex = String(index);
        btn.setAttribute('aria-label', '回退到这一轮之前');
        btn.appendChild(icon(ICONS.rewind, 'ai-rewind-mark'));
        btn.addEventListener('click', function (event) {
            event.stopPropagation();
            // 二次确认：回退没有撤销，先问一句
            showRewindConfirm(btn, index);
        });
        return btn;
    }

    function appendMessage(role, text, opts) {
        var isUser = role === 'user';
        var msg = el('article', 'ai-msg ai-msg-' + (isUser ? 'user' : 'ai'));
        var body = el('div', 'ai-bubble');
        if (isUser) {
            // 用户消息：回退键在气泡左边
            var row = el('div', 'ai-msg-row');
            row.appendChild(attachRewind(msg, body, opts && typeof opts.rewindIndex === 'number' ? opts.rewindIndex : -1));
            row.appendChild(body);
            msg.appendChild(row);
        } else {
            msg.appendChild(body);
            // 助手消息竖排：气泡在上，来源行在下
            var sourceList = el('div', 'ai-source-list');
            sourceList.hidden = true;
            msg.appendChild(sourceList);
            refs.answerMsg = msg;
        }
        refs.stream.appendChild(msg);
        if (text) body.innerHTML = renderMarkdown(text);
        if (refs.emptyState) refs.emptyState.hidden = true;
        scrollToBottom();
        updateScrollArrows();
        return { root: msg, body: body };
    }

    /*
     * 思考内容：挂进「过程」分组，做成独立一块、默认收起。
     * 没有过程分组时（直接调 appendThinking 的旧路径）退回挂在消息上方。
     */
    function appendThinking(text) {
        if (!text) return null;
        var host = processBody;
        // 没有时间线就丢弃：思考绝不能塞进正文气泡里，那正是旧版的老毛病
        if (!host) return null;
        var box = host.querySelector('.ai-thinking');
        if (!box) {
            box = el('div', 'ai-thinking');
            box.appendChild(el('div', 'ai-thinking__body'));
            host.appendChild(box);
        }
        var holder = box.querySelector('.ai-thinking__body');
        holder.textContent += text;
        scrollToBottom();
        return box;
    }

    /* 流式等待：模型还没吐字时给一条占位气泡，避免面板看着是空的 */
    function setPending(pending) {
        if (!pending) {
            if (pendingNode) {
                pendingNode.remove();
                pendingNode = null;
            }
            return;
        }
        if (pendingNode) return;
        var msg = el('article', 'ai-msg ai-msg-ai ai-msg-pending');
        var bubble = el('div', 'ai-bubble');
        bubble.appendChild(el('span', 'ai-pending-label', '正在生成回答'));
        bubble.appendChild(el('span', 'ai-pending-bar'));
        msg.appendChild(bubble);
        pendingNode = msg;
        refs.stream.appendChild(msg);
        if (refs.emptyState) refs.emptyState.hidden = true;
        scrollToBottom();
    }

    function toolLabel(name) {
        if (name === 'read_section') return '查阅正文';
        if (name === 'search_articles') return '检索文章';
        if (name === 'list_articles') return '文章目录';
        return name || '工具';
    }

    /* 状态角标：命中数量或失败原因，都压成一句话 */
    function toolStatus(result) {
        if (!result) return { kind: 'done', text: '已完成' };
        if (result.error) return { kind: 'error', text: '调用失败' };
        if (result.items && result.items.length) return { kind: 'done', text: '命中 ' + result.items.length + ' 篇' };
        // 渐进式查阅的第一步：只拿到标题目录，还没取正文
        if (result.outline && result.outline.length) {
            return { kind: 'done', text: '列出 ' + result.outline.length + ' 个标题' };
        }
        if (result.section) return { kind: 'done', text: '命中 1 段' };
        if (result.note) return { kind: 'done', text: '没有结果' };
        return { kind: 'done', text: '已完成' };
    }

    /* 展开区里逐条列命中：标题 + 所属位置 */
    function toolHits(result) {
        if (!result) return [];
        if (result.error) return [{ title: '失败：' + result.error, path: '' }];
        if (result.items && result.items.length) {
            return result.items.map(function (item) {
                return {
                    title: item.title || '',
                    path: (item.categories || []).join(' / ')
                };
            });
        }
        // 标题目录步：把目录列出来，读者才知道模型下一步能选哪个标题
        if (result.outline && result.outline.length) {
            return result.outline.slice(0, 20).map(function (item) {
                return {
                    title: item.title || '',
                    path: '第 ' + (item.level || 1) + ' 级'
                };
            });
        }
        if (result.section) {
            return [{ title: result.section, path: result.articleTitle || '' }];
        }
        return [];
    }

    function appendToolCard(call, result) {
        var card = el('div', 'ai-tool');
        var status = toolStatus(result);
        card.dataset.status = status.kind;

        var head = el('button', 'ai-tool-head');
        head.type = 'button';
        head.setAttribute('aria-expanded', 'false');
        head.appendChild(el('span', 'ai-tool-name', toolLabel(call.name)));
        var meta = el('span', 'ai-tool-status', status.text);
        meta.dataset.status = status.kind;
        head.appendChild(meta);

        var body = el('div', 'ai-tool-body');
        // 默认收起：过程整块已经折过一次，命中了什么要按需展开才看得见
        body.hidden = true;
        if (result && result.note) {
            body.appendChild(el('p', 'ai-tool-note', result.note));
        }
        toolHits(result).forEach(function (hit) {
            var row = el('div', 'ai-hit');
            row.appendChild(el('span', 'ai-hit-title', hit.title));
            row.appendChild(el('span', 'ai-hit-path', hit.path));
            body.appendChild(row);
        });
        // 没匹配到小节时把可用标题摆出来，模型换标题重试、读者也能看懂为什么空
        if (result && !result.section && result.headings && result.headings.length) {
            var list = el('ul', 'ai-tool-candidates');
            result.headings.slice(0, 8).forEach(function (title) {
                list.appendChild(el('li', 'ai-tool-candidate', title));
            });
            body.appendChild(list);
        }
        // 渐进式查阅：这一步只取到直属正文，下面这些子标题的正文没注入，还能继续往下查
        if (result && result.children && result.children.length) {
            body.appendChild(el('p', 'ai-tool-note', '下面这些小节还没取正文，可以继续往下查：'));
            var sub = el('ul', 'ai-tool-candidates');
            result.children.slice(0, 8).forEach(function (child) {
                sub.appendChild(el('li', 'ai-tool-candidate', (child && child.title) || String(child)));
            });
            body.appendChild(sub);
        }

        head.addEventListener('click', function () {
            var open = body.hidden;
            body.hidden = !open;
            head.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        card.appendChild(head);
        card.appendChild(body);
        // 有过程分组就挂进分组，没有才退回消息流末尾
        var host = processBody || refs.stream;
        host.appendChild(card);
        scrollToBottom();
        return card;
    }

    /* ------------------------------------------------------------ 过程分组 */

    /*
     * 时间线：思考步骤与工具调用按真实顺序挂在答案上方，一轮一条。
     * 流式期间展开、逐行落地；回答结束后整条折成一行摘要，点开还原。
     */
    function beginProcess() {
        var wrap = el('div', 'ai-timeline');
        wrap.classList.add('is-open');
        var head = el('button', 'ai-timeline__head');
        head.type = 'button';
        head.setAttribute('aria-expanded', 'true');
        head.appendChild(el('span', 'ai-timeline__summary', '正在思考'));
        head.appendChild(el('span', 'ai-timeline__toggle', '收起'));
        head.addEventListener('click', function () {
            var open = !wrap.classList.contains('is-open');
            wrap.classList.toggle('is-open', open);
            head.setAttribute('aria-expanded', open ? 'true' : 'false');
            var label = head.querySelector('.ai-timeline__toggle');
            if (label) label.textContent = open ? '收起' : '展开';
        });
        var body = el('div', 'ai-timeline__body');
        wrap.appendChild(head);
        wrap.appendChild(body);
        refs.stream.appendChild(wrap);
        processNode = wrap;
        processBody = body;
        scrollToBottom();
        return wrap;
    }

    /*
     * 收尾：只折叠，不搬位置——时间线本来就在答案上方。
     * 摘要写成「思考 X.X 秒 · N 次工具调用」，没有的数字不编。
     */
    function endProcess(meta) {
        var node = processNode;
        if (!node) return null;
        var stats = meta || {};
        var toolCalls = (typeof stats.toolCalls === 'number' && isFinite(stats.toolCalls)) ? stats.toolCalls : 0;
        var thinkMs = (typeof stats.thinkMs === 'number' && isFinite(stats.thinkMs)) ? stats.thinkMs : 0;

        var parts = [];
        if (thinkMs > 0) parts.push('思考 ' + (thinkMs / 1000).toFixed(1) + ' 秒');
        if (toolCalls > 0) parts.push(toolCalls + ' 次工具调用');

        // 没有思考也没有工具：整条时间线不落地，正文上面不留一行噪音
        if (!parts.length) {
            node.remove();
            processNode = null;
            processBody = null;
            return null;
        }
        var text = parts.join(' · ');

        var summary = node.querySelector('.ai-timeline__summary');
        if (summary) summary.textContent = text;
        var head = node.querySelector('.ai-timeline__head');
        if (head) head.setAttribute('aria-expanded', 'false');
        var label = node.querySelector('.ai-timeline__toggle');
        if (label) label.textContent = '展开';
        node.classList.remove('is-open');

        processNode = null;
        // 折叠后内容高度变了，滚动箭头的显隐要跟着更新
        updateScrollArrows();
        processBody = null;
        scrollToBottom();
        return node;
    }

    /* ---------------------------------------------------------- 用量统计行 */

    /* 千分位：token 数上万，不分组读不出量级 */
    function formatCount(value) {
        return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function formatSeconds(ms) {
        return (Math.round(ms) / 1000).toFixed(1) + 's';
    }

    /*
     * 用量与耗时：贴在助手气泡末尾的一行小字。
     * 拿不到的项不写，全都没有就不渲染这一行。
     */
    function setUsage(stats) {
        var data = stats || {};
        var host = refs.answerMsg;
        if (!host || !host.parentNode) {
            host = appendMessage('assistant', '').root;
        }
        var bubble = host.querySelector('.ai-bubble');
        if (!bubble && refs.stream) {
            // 气泡可能被摘掉（空泡清理），这时写到流里最后一条还活着的气泡上，
            // 否则 token 与耗时无处可写，整行直接消失
            var alive = refs.stream.querySelectorAll('.ai-msg-ai .ai-bubble');
            if (alive.length) bubble = alive[alive.length - 1];
        }
        if (!bubble) return null;

        var old = bubble.querySelector('.ai-usage');
        if (old) old.remove();

        var parts = [];
        // 用时为 0 说明这一轮根本没跑起来，这种「用时 0.0s」写出来只是噪音
        if (typeof data.totalMs === 'number' && isFinite(data.totalMs) && data.totalMs > 0) {
            parts.push('用时 ' + formatSeconds(data.totalMs));
        }
        if (typeof data.thinkMs === 'number' && data.thinkMs > 0) {
            parts.push('思考 ' + formatSeconds(data.thinkMs));
        }
        if (typeof data.input === 'number' && isFinite(data.input)) {
            parts.push('输入 ' + formatCount(data.input));
        }
        if (typeof data.output === 'number' && isFinite(data.output)) {
            parts.push('输出 ' + formatCount(data.output) + ' tokens');
        }
        if (typeof data.cache === 'number' && isFinite(data.cache)) {
            parts.push('缓存 ' + formatCount(data.cache) + ' tokens');
        }
        if (!parts.length) return null;

        var row = el('div', 'ai-usage');
        row.textContent = parts.join(' · ');
        bubble.appendChild(row);
        return row;
    }

    /* -------------------------------------------------------- 窄屏抽屉高度 */

    /*
     * 窄屏抽屉高度写在面板的内联 height 上，样式表窄屏那一档直接用这个值。
     * 宽屏不看这个值（非窄屏直接忽略），否则浮窗会被钉死在窄屏那一档高度。
     */
    function setDrawerHeight(px) {
        var value = Number(px);
        if (!isFinite(value) || value <= 0) return null;
        if (!isNarrow()) return null;
        drawerHeight = Math.round(value);
        if (refs.panel) refs.panel.style.height = drawerHeight + 'px';
        return drawerHeight;
    }

    function getDrawerHeight() {
        return drawerHeight;
    }

    /*
     * 来源行按原型挂在助手消息气泡下面，所以先清掉上一轮的来源，
     * 再把这一轮的挂到本轮最后一条助手消息上。
     */
    function renderSource(item) {
        var link = el('a', 'ai-source');
        if (item.url && safeUrl(item.url)) {
            link.href = item.url;
            // 站内来源同页跳转；只有外链才开新标签
            if (!isInternalHref(item.url)) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
        }
        link.appendChild(icon(ICONS.source, 'ai-source-mark'));
        // 标题单独包一层：裸文本节点在 flex 容器里是匿名项，
        // 省略号不会生效，只能硬切
        link.appendChild(el('span', 'ai-source-title', '来源《' + (item.title || '') + '》'));
        return link;
    }

    /*
     * 历史消息的过程区：和流式时的时间线同一套结构，只是数据来自会话存储。
     * 落地就是收起状态（点开才看），摘要写明「思考 · N 次工具调用」。
     */
    function renderStoredProcess(proc) {
        var wrap = el('div', 'ai-timeline');
        var head = el('button', 'ai-timeline__head');
        head.type = 'button';
        head.setAttribute('aria-expanded', 'false');
        var parts = [];
        if (proc.think) parts.push('思考 ' + proc.think.length + ' 字');
        if (proc.tools && proc.tools.length) {
            var total = proc.toolTotal || proc.tools.length;
            parts.push(total + ' 次工具调用');
        }
        head.appendChild(el('span', 'ai-timeline__summary', parts.join(' · ')));
        head.appendChild(el('span', 'ai-timeline__toggle', '展开'));
        var body = el('div', 'ai-timeline__body');
        if (proc.think) {
            var box = el('div', 'ai-thinking');
            var thinkBody = el('div', 'ai-thinking__body');
            thinkBody.textContent = proc.think;
            box.appendChild(thinkBody);
            body.appendChild(box);
        }
        (proc.tools || []).forEach(function (one) {
            var card = el('div', 'ai-tool');
            var row = el('div', 'ai-tool-head');
            row.appendChild(el('span', 'ai-tool-name', toolLabel(one.name)));
            var status = el('span', 'ai-tool-status', one.status || '');
            row.appendChild(status);
            card.appendChild(row);
            if (one.detail) card.appendChild(el('p', 'ai-tool-note', one.detail));
            body.appendChild(card);
        });
        head.addEventListener('click', function () {
            var open = !wrap.classList.contains('is-open');
            wrap.classList.toggle('is-open', open);
            head.setAttribute('aria-expanded', open ? 'true' : 'false');
            var label = head.querySelector('.ai-timeline__toggle');
            if (label) label.textContent = open ? '收起' : '展开';
        });
        wrap.appendChild(head);
        wrap.appendChild(body);
        return wrap;
    }

    /* 工具执行结果的展示口径：状态文字与一行摘要，主流程存会话时直接取用 */
    function toolSummary(result) {
        var status = toolStatus(result);
        var detail = '';
        var hits = toolHits(result);
        if (result && result.note) detail = result.note;
        else if (hits.length) detail = '命中 ' + hits.length + ' 条';
        else if (result && result.complete) detail = '已读';
        return { status: status.text, detail: detail };
    }

    /*
     * 来源列表：一次只铺 5 条，剩下的收进「还有 N 篇候选」按钮里，点一次再放 5 条。
     * 流式时和历史回看共用这一套——几十条来源全铺出来会把整屏占满。
     */
    function renderSourceList(items) {
        var list = el('div', 'ai-source-list');
        var ordered = (items || []).slice().sort(function (a, b) {
            return (a.kind === 'quoted' ? 0 : 1) - (b.kind === 'quoted' ? 0 : 1);
        });
        // 来源只展示前几条：一次检索能命中十几篇，全列出来是噪音，
        // 真正该被引用的是模型正文里提到的那几篇。
        var MAX_SHOWN_SOURCES = 5;
        var shown = ordered.slice(0, MAX_SHOWN_SOURCES);
        shown.forEach(function (item) {
            list.appendChild(renderSource(item));
        });

        // 多出来的候选要能真的展开：每次再放 5 条，放完就把按钮摘掉
        var rest = ordered.slice(MAX_SHOWN_SOURCES);
        if (rest.length) {
            var index = 0;
            var more = el('button', 'ai-source-more', '还有 ' + rest.length + ' 篇候选');
            more.type = 'button';
            more.addEventListener('click', function () {
                var batch = rest.slice(index, index + 5);
                batch.forEach(function (item) {
                    list.insertBefore(renderSource(item), more);
                });
                index += batch.length;
                if (index >= rest.length) more.remove();
                else more.textContent = '还有 ' + (rest.length - index) + ' 篇候选';
                scrollToBottom();
            });
            list.appendChild(more);
        }
        return list;
    }

    /*
     * 正文里的文章标题要能点：模型只会写《Python 基础入门 — 从零开始的语法之旅》，
     * 不会自己贴地址。标题与来源里的文件名常有一字之差（「—」对「--」），
     * 所以按「去掉书名号后取前缀」去正文里找，找到就把那一段包成站内链接。
     */
    function titleCandidates(title) {
        var out = [];
        var base = String(title || '').replace(/[《》]/g, '').trim();
        if (!base) return out;
        out.push(base);
        var parts = base.split(/\s+[—–]{1,2}\s+|\s+--\s+|\s*[：:]\s*/);
        for (var i = 0; i < parts.length; i++) {
            var one = parts[i].trim();
            // 短片段（「简介」「概述」）在正文里太常见，够长才拿来匹配
            if (one.length >= 6) out.push(one);
        }
        // 长标题优先：先包住完整标题，匹配不上再退到前缀
        out.sort(function (a, b) { return b.length - a.length; });
        var seen = {};
        var unique = [];
        for (var k = 0; k < out.length; k++) {
            if (seen[out[k]]) continue;
            seen[out[k]] = true;
            unique.push(out[k]);
        }
        return unique;
    }

    function blockedAncestor(node) {
        // 往上找：已有链接、代码、按钮里的文字不动
        // 只看直接父元素不够——<a><strong>标题</strong></a> 里的文本父级是 STRONG，
        // 在那儿插 <a> 会产出嵌套链接（非法 HTML）
        var cur = node.parentNode;
        while (cur && cur !== node.ownerDocument) {
            var tag = cur.tagName ? cur.tagName.toUpperCase() : '';
            if (tag === 'A' || tag === 'CODE' || tag === 'PRE' || tag === 'BUTTON') return true;
            if (cur.classList && cur.classList.contains('ai-article-link')) return true;
            cur = cur.parentNode;
        }
        return false;
    }

    function linkFirstOccurrence(container, text, url) {
        if (!container || !text || !url) return false;
        if (!safeUrl(url)) return false;
        var walker = document.createTreeWalker(container, 4, null, false);
        var node = walker.nextNode();
        while (node) {
            if (!blockedAncestor(node)) {
                var at = node.nodeValue.indexOf(text);
                if (at !== -1) {
                    var after = node.splitText(at);
                    after.splitText(text.length);
                    var link = document.createElement('a');
                    link.className = 'ai-article-link';
                    link.href = url;
                    if (!isInternalHref(url)) {
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                    }
                    link.textContent = text;
                    after.parentNode.replaceChild(link, after);
                    return true;
                }
            }
            node = walker.nextNode();
        }
        return false;
    }

    /*
     * 把正文里的文章标题按来源包成链接。
     * 返回实际包上的链接清单（文本 + 地址）：实时与回看要用同一份清单，
     * 否则刷新后按来源重新匹配可能对不上（标题被截断、来源没进留档），
     * 读者会看到「刷新前是链接、刷新后变回普通文字」。
     */
    function linkifySources(container, items) {
        var applied = [];
        if (!container || !items || !items.length) return applied;
        var ordered = items.slice().sort(function (a, b) {
            return (a.kind === 'quoted' ? 0 : 1) - (b.kind === 'quoted' ? 0 : 1);
        });
        var MAX_LINKS = 8;
        for (var i = 0; i < ordered.length && applied.length < MAX_LINKS; i++) {
            var item = ordered[i];
            if (!item || !item.url) continue;
            var names = titleCandidates(item.title);
            for (var j = 0; j < names.length; j++) {
                if (linkFirstOccurrence(container, names[j], item.url)) {
                    applied.push({ text: names[j], url: item.url });
                    break;
                }
            }
        }
        return applied;
    }

    /* 回看时按留档的链接清单原样恢复：实时包过什么，刷新后还是什么 */
    function applyStoredLinks(container, links) {
        var applied = [];
        if (!container || !links || !links.length) return applied;
        for (var i = 0; i < links.length; i++) {
            var one = links[i];
            if (!one || !one.text || !one.url) continue;
            if (linkFirstOccurrence(container, one.text, one.url)) {
                applied.push({ text: one.text, url: one.url });
            }
        }
        return applied;
    }

    function setSources(items) {
        // 只清当前那条回答的来源行：历史消息的来源也存在同样的 class，
        // 全清会把回看时画出来的来源一起抹掉
        var old = refs.answerMsg ? refs.answerMsg.querySelectorAll('.ai-source-list') : [];
        for (var i = 0; i < old.length; i++) {
            old[i].innerHTML = '';
            old[i].hidden = true;
        }
        if (!items || !items.length) return;

        var host = refs.answerMsg;
        if (!host || !host.parentNode) {
            host = appendMessage('assistant', '').root;
        }
        // 整块换掉：按钮的展开逻辑要绑在活的列表上，
        // 把子节点搬过来会让「还有 N 篇候选」把内容插到已经脱离文档的旧列表里
        var old = host.querySelector('.ai-source-list');
        var list = renderSourceList(items);
        if (old && old.parentNode) {
            old.parentNode.replaceChild(list, old);
        } else {
            host.appendChild(list);
        }
        list.hidden = false;
        // 来源行是最后一段内容，补完滚到底，否则它会被输入区压住看不见
        scrollToBottom();
    }

    /* 错误没有独立组件，用助手气泡承载，靠 ai-msg--error 区分 */
    function setError(err) {
        if (errorNode) {
            errorNode.remove();
            errorNode = null;
        }
        if (!err) return;
        var msg = el('article', 'ai-msg ai-msg-ai ai-msg--error');
        var bubble = el('div', 'ai-bubble');
        bubble.textContent = err.title
            ? (err.hint ? err.title + '：' + err.hint : err.title)
            : String(err);
        msg.appendChild(bubble);
        // 中断时历史里留着半截回答：给「继续」和「回退」两个明确动作，
        // 比让人手打「继续」或在脑子里还原上一问靠谱
        if (err.resumable) {
            var actions = el('div', 'ai-error-actions');
            var resume = el('button', 'ai-btn ai-btn-primary ai-resume', '继续生成');
            resume.type = 'button';
            resume.dataset.act = 'resume';
            actions.appendChild(resume);
            var rewind = el('button', 'ai-btn ai-rewind', '回退本轮');
            rewind.type = 'button';
            rewind.dataset.act = 'rewind';
            actions.appendChild(rewind);
            msg.appendChild(actions);
        }
        errorNode = msg;
        refs.stream.appendChild(msg);
        scrollToBottom();
    }

    /*
     * 回退本轮：从最后一条用户消息起，把它之后的节点全部撤掉
     * （半截回答、错误气泡、过程分组都在它后面）。
     * 消息区撤完是空的就把空状态接回来。
     */
    function rewindStream() {
        if (!refs.stream) return;
        var nodes = Array.prototype.slice.call(refs.stream.children);
        var anchor = -1;
        for (var i = nodes.length - 1; i >= 0; i--) {
            if (nodes[i].classList && nodes[i].classList.contains('ai-msg-user')) {
                anchor = i;
                break;
            }
        }
        if (anchor < 0) return;
        for (var j = nodes.length - 1; j >= anchor; j--) {
            nodes[j].remove();
        }
        errorNode = null;
        pendingNode = null;
        // 前面还有别的问答时不能说「还没有对话」
        if (refs.emptyState) {
            refs.emptyState.hidden = !!refs.stream.querySelector('.ai-msg');
        }
    }

    /* 保存配置的反馈：成功给「已保存」，失败把原因写在这条上 */
    function setSaved(ok, message) {
        refs.saved.textContent = message || (ok ? '已保存' : '保存失败');
        refs.saved.classList.add('is-on');
        refs.saved.classList.toggle('is-error', !ok);
    }

    function setBusy(busy) {
        // 回答进行中把会话入口锁住：半路换会话会把正在输出的回答搅乱
        sessionBusy = !!busy;
        refs.composer.disabled = busy;
        /*
         * 发送键在回答期间变成停止键：同一个位置、同一个按钮，
         * 用户想提前中断不用先找 Esc。停用（disabled）在这里是反的——
         * 忙碌时必须可点，空闲时才由「有没有输入」决定。
         */
        var send = refs.sendBtn;
        send.dataset.act = busy ? 'stop' : 'send';
        send.classList.toggle('is-stop', !!busy);
        send.setAttribute('aria-label', busy ? '停止生成' : '发送');
        send.disabled = busy ? false : !refs.composer.value.trim();
        send.innerHTML = '';
        send.appendChild(icon(busy ? ICONS.stop : ICONS.send));
        // 停止态要真的能按下去：只切图标不换 action 等于按了没反应
        refs.stream.setAttribute('aria-busy', busy ? 'true' : 'false');
        applySessionBusyState();
    }

    /* ------------------------------------------------------------ 划词气泡 */

    function showBubble(rect, onPick) {
        var bubble = refs.bubble;
        bubble.hidden = false;
        var half = 44;
        var left = rect.left + (rect.width ? rect.width / 2 : 0);
        bubble.style.left = Math.min(Math.max(left, half), Math.max(half, window.innerWidth - half)) + 'px';
        bubble.style.top = Math.max(half, rect.top) + 'px';
        bubble.onclick = function () {
            hideBubble();
            onPick();
        };
    }

    function hideBubble() {
        refs.bubble.hidden = true;
        refs.bubble.onclick = null;
    }

    /* -------------------------------------------------------- 预设下拉 */

    /*
     * 下拉列表用 fixed 定位：设置区是可滚动容器，绝对定位会被裁掉。
     * 下方放不下就翻到按钮上方。
     */
    function positionPresetList() {
        var box = refs.presetButton.getBoundingClientRect();
        var height = refs.presetList.offsetHeight;
        var below = window.innerHeight - box.bottom - 12;
        refs.presetList.style.left = box.left + 'px';
        refs.presetList.style.width = box.width + 'px';
        refs.presetList.style.top = (below >= height + 8
            ? box.bottom + 4
            : Math.max(8, box.top - height - 4)) + 'px';
    }

    function openPresetList() {
        // 设置区是可滚动容器：按钮可能在可视区外，先把它滚进来，
        // 否则下拉会挂在看不见的位置上
        if (typeof refs.presetButton.scrollIntoView === 'function') {
            refs.presetButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        refs.presetList.hidden = false;
        refs.presetButton.setAttribute('aria-expanded', 'true');
        positionPresetList();
    }

    function closePresetList() {
        refs.presetList.hidden = true;
        refs.presetButton.setAttribute('aria-expanded', 'false');
    }

    /* ------------------------------------------------------ 极简 Markdown */

    /*
     * 极简 Markdown：标题、列表、表格、引用、分割线、代码块与行内样式，
     * 够渲染模型回答，又不用引第三方库（博客不打包任何依赖）。
     */
    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /*
     * 链接与图片的地址白名单：只放行 http(s) 与站内路径，
     * javascript:、data: 这类原样吐回去，不进 href/src。
     */
    function safeUrl(url) {


        if (!url) return false;
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return /^https?:\/\//i.test(url);
        return true;
    }

    /*
     * 站内链接同页跳转、外链才开新标签：站内路径（/ 开头）与同源链接都不带 target，
     * 免得点一下来源就弹一个重复的标签页。
     */
    function isInternalHref(href) {
        var value = String(href || '');
        if (!value) return false;
        // 协议相对地址 //example.com/x 也是外站，别被首字符 '/' 骗了
        if (value.slice(0, 2) === '//') return false;
        if (value.charAt(0) === '/') return true;
        return value.indexOf(window.location.origin + '/') === 0;
    }

    /*
     * 行内解析：先 escapeHtml 再做替换，插值文本一律转义，防注入。
     * 行内代码先抠成占位符，等其它语法都替完再放回去——
     * 否则代码里的 ** 会先被粗体吃掉。
     */
    /*
     * 清理地址：模型爱把地址包在尖括号里（<https://...>），
     * 转义后尖括号变成 &lt; &gt;，不清掉就会把 &gt; 带进 href——
     * 点过去就是一个不存在的页面（路径尾巴多一段 %3E）。
     */
    function cleanHref(href) {
        var value = String(href || '');
        value = value.replace(/&(?:gt|lt);/gi, '');
        value = value.replace(/[<>]/g, '');
        return value;
    }

    function inline(text) {
        var codes = [];
        var out = escapeHtml(text);
        out = out.replace(/`([^`]+)`/g, function (m, code) {
            codes.push(code);
            return '\u0000' + (codes.length - 1) + '\u0000';
        });
        out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (m, alt, src) {
            if (!safeUrl(src)) return m;
            return '<img class="ai-img" src="' + src + '" alt="' + alt + '" loading="lazy">';
        });
        // markdown 的尖括号自动链接：<https://...> 整段成链，尖括号不留在正文里
        out = out.replace(/&lt;(https?:\/\/[^\s"'<>]+)&gt;/g, function (m, href) {
            var target = cleanHref(href);
            if (!target || !safeUrl(target)) return m;
            var attrs = isInternalHref(target) ? '' : ' target="_blank" rel="noopener noreferrer"';
            return '<a href="' + target + '"' + attrs + '>' + target + '</a>';
        });
        out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
            var target = cleanHref(href);
            if (!target || !safeUrl(target)) return m;
            var attrs = isInternalHref(target) ? '' : ' target="_blank" rel="noopener noreferrer"';
            return '<a href="' + target + '"' + attrs + '>' + label + '</a>';
        });
        /*
         * 模型常常直接甩一个裸地址（不带 [文字](地址)），不认它就等于链接不显示。
         * 已经在 markdown 链接里的地址前面紧挨着 `](`，生成的 href 前面是引号，两种都要跳过。
         */
        out = out.replace(/https?:\/\/[^\s<>"'\u3002\uFF0C\uFF09]+/g, function (m, offset, whole) {
            var before = whole.slice(0, offset);
            if (/\]\($/.test(before) || /[="'><]$/.test(before)) return m;
            var href = cleanHref(m).replace(/[.,;:!?]+$/, '');
            var tail = m.slice(m.indexOf(href) + href.length);
            if (!href || !safeUrl(href)) return m;
            var attrs = isInternalHref(href) ? '' : ' target="_blank" rel="noopener noreferrer"';
            return '<a href="' + href + '"' + attrs + '>' + href + '</a>' + tail;
        });
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
        // 斜体两侧必须挨着空白或标点（中英文标点都算），免得把 snake_case 拆成斜体
        out = out.replace(/(^|[\s(\uFF08\u3001\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u300D\u300F\u300B\u3011])[*_]([^*\n]+?)[*_](?=$|[\s.,;:!?)\]\uFF09\u3001\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u300D\u300F\u300B\u3011])/g, '$1<em>$2</em>');
        out = out.replace(/\u0000(\d+)\u0000/g, function (m, index) {
            return '<code>' + codes[Number(index)] + '</code>';
        });
        return out;
    }

    /* 代码块自带一个复制按钮：设置里不再放示例调用，复制代码的活儿交给真正的代码块 */
    function codeBlock(code) {
        return '<div class="ai-code-wrap"><pre class="ai-code"><code>' +
            escapeHtml(code) +
            '</code></pre><button type="button" class="ai-code-copy" data-act="copy-code">复制代码</button></div>';
    }

    function listItem(line) {
        return /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.test(line);
    }

    /*
     * 表格分隔行：标准写法是 | --- | --- |（带竖线）。
     * 模型有时只写一条裸 ---，这种只有在上一行是带竖线的表头时才当分隔行，
     * 否则裸 --- 仍然是分割线，不能一律吞成表格。
     */
    function isTableSeparator(line) {
        var s = line.trim();
        if (s.indexOf('|') === -1) return false;
        if (!/^[\s|:-]+$/.test(s)) return false;
        return /-/.test(s);
    }

    function isBareDashSeparator(line) {
        var s = line.trim();
        if (!s) return false;
        return /^-{3,}$/.test(s) || /^(-\s*){3,}$/.test(s);
    }

    function splitRow(line) {
        var s = line.trim();
        if (s.charAt(0) === '|') s = s.slice(1);
        if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
        if (!s.trim()) return [];
        var cells = s.split('|');
        for (var i = 0; i < cells.length; i++) cells[i] = cells[i].trim();
        return cells;
    }

    /*
     * 表格：表头行后面必须跟一条分隔行，且两行列数一致，才算表格。
     * 分隔行落单（前面没有表头）就当普通文本，不硬凑成表格。
     */
    function parseTable(lines, start) {
        var header = lines[start];
        var sep = lines[start + 1];
        if (!sep || header.indexOf('|') === -1) return null;
        var headCells = splitRow(header);
        if (headCells.length < 2) return null;
        if (isTableSeparator(sep)) {
            // 分隔行的列数常与表头不一致（模型少写一列），列数一律以表头为准
        } else if (isBareDashSeparator(sep)) {
            // 裸 --- 只在表头带竖线时才算分隔行
        } else {
            return null;
        }

        var rows = [];
        var i = start + 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
            rows.push(splitRow(lines[i]));
            i++;
        }

        var html = '<div class="ai-table-wrap"><table class="ai-table"><thead><tr>';
        for (var h = 0; h < headCells.length; h++) {
            html += '<th>' + inline(headCells[h]) + '</th>';
        }
        html += '</tr></thead><tbody>';
        for (var r = 0; r < rows.length; r++) {
            html += '<tr>';
            for (var c = 0; c < headCells.length; c++) {
                html += '<td>' + inline(rows[r][c] || '') + '</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        return { html: html, next: i };
    }

    /*
     * 列表：先把连续的列表项收成扁平序列，再按缩进还原层级。
     * 缩进步长（2 空格还是 4 空格）从实际用到的缩进里量出来，两种写法都能正确分级。
     */
    function parseList(lines, start) {
        var flat = [];
        var i = start;
        while (i < lines.length) {
            var m = lines[i].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
            if (m) {
                flat.push({ indent: m[1].length, marker: m[2], text: m[3] });
                i++;
                continue;
            }
            // 续行：缩进比列表标记深、又不是新的列表项，就并进上一项
            if (flat.length && lines[i].trim() && /^\s+/.test(lines[i])) {
                flat[flat.length - 1].text += ' ' + lines[i].trim();
                i++;
                continue;
            }
            break;
        }
        if (!flat.length) return { html: '', next: start };

        var base = flat[0].indent;
        var indents = [];
        for (var k = 0; k < flat.length; k++) {
            if (flat[k].indent > base && indents.indexOf(flat[k].indent) === -1) {
                indents.push(flat[k].indent);
            }
        }
        indents.sort(function (a, b) { return a - b; });
        var step = 2;
        for (var q = 0; q < indents.length; q++) {
            var diff = indents[q] - (q === 0 ? base : indents[q - 1]);
            if (diff > 0) {
                step = diff;
                break;
            }
        }

        var root = [];
        var stack = [{ level: -1, children: root }];
        for (var n = 0; n < flat.length; n++) {
            var item = flat[n];
            var level = Math.round((item.indent - base) / step);
            if (level < 0) level = 0;
            var node = {
                marker: item.marker,
                text: item.text,
                start: parseInt(item.marker, 10) || 1,
                children: []
            };
            while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
            stack[stack.length - 1].children.push(node);
            stack.push({ level: level, children: node.children });
        }

        function renderItems(items) {
            var tag = /\d/.test(items[0].marker) ? 'ol' : 'ul';
            var out = '<' + tag;
            // 有序列表不从 1 开始时把起始号带上，序号才对得上原文
            if (tag === 'ol' && items[0].start !== 1) out += ' start="' + items[0].start + '"';
            out += '>';
            for (var n2 = 0; n2 < items.length; n2++) {
                out += '<li>' + inline(items[n2].text);
                if (items[n2].children.length) out += renderItems(items[n2].children);
                out += '</li>';
            }
            return out + '</' + tag + '>';
        }

        return { html: renderItems(root), next: i };
    }

    /* 这一行是不是块级结构的开头：段落拼接要在它面前停 */
    function isBlockStart(lines, index) {
        var line = lines[index];
        if (/^#{1,4}\s/.test(line)) return true;
        if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
        if (/^\s*>/.test(line)) return true;
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
        if (listItem(line)) return true;
        if (parseTable(lines, index)) return true;
        return false;
    }

    /*
     * 块级解析：代码块、标题、表格、分割线、引用、列表、段落，逐块识别。
     * 识别不出来的当段落原样输出，不吞内容。
     */
    function renderBlocks(lines) {
        var html = [];
        var i = 0;

        while (i < lines.length) {
            var line = lines[i];

            if (!line.trim()) {
                i++;
                continue;
            }

            // 围栏代码块：块内不做任何行内解析
            var fence = line.match(/^\s*(`{3,}|~{3,})/);
            if (fence) {
                var marker = fence[1];
                var closeRe = new RegExp('^\\s*' + marker.charAt(0) + '{' + marker.length + ',}\\s*$');
                var buf = [];
                i++;
                while (i < lines.length && !closeRe.test(lines[i])) {
                    buf.push(lines[i]);
                    i++;
                }
                if (i < lines.length) i++;
                html.push(codeBlock(buf.join('\n')));
                continue;
            }

            var heading = line.match(/^(#{1,4})\s+(.*)$/);
            if (heading) {
                var level = Math.min(6, heading[1].length + 2);
                html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
                i++;
                continue;
            }

            var table = parseTable(lines, i);
            if (table) {
                html.push(table.html);
                i = table.next;
                continue;
            }

            if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
                html.push('<hr>');
                i++;
                continue;
            }

            if (/^\s*>/.test(line)) {
                var quote = [];
                while (i < lines.length && /^\s*>/.test(lines[i])) {
                    quote.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                html.push('<blockquote>' + renderBlocks(quote) + '</blockquote>');
                continue;
            }

            if (listItem(line)) {
                var list = parseList(lines, i);
                html.push(list.html);
                i = list.next;
                continue;
            }

            // 段落：连续的行合成一段，行内软换行不另起段
            var para = [];
            while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
                para.push(lines[i].trim());
                i++;
            }
            if (para.length) {
                html.push('<p>' + inline(para.join(' ')) + '</p>');
            } else {
                i++;
            }
        }

        return html.join('');
    }

    function renderMarkdown(text) {
        var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
        return renderBlocks(lines);
    }

    AI.ui = {
        mount: mount,
        setOpen: setOpen,
        isOpen: isOpen,
        setState: setState,
        syncViewport: syncViewport,
        isNarrow: isNarrow,
        setPeek: setPeek,
        isPeek: isPeek,
        isCompact: isCompact,
        setFabPosition: setFabPosition,
        getFabPosition: getFabPosition,
        setPanelPosition: setPanelPosition,
        defaultFabPosition: defaultFabPosition,
        placePanel: placePanel,
        setSideLock: function (locked) { sideLock = !!locked; },
        setContext: setContext,
        growComposer: growComposer,
        setComposerValue: setComposerValue,
        showToast: showToast,
        rewindStream: rewindStream,
        appendMessage: appendMessage,
        appendThinking: appendThinking,
        setPending: setPending,
        appendToolCard: appendToolCard,
        rememberModel: rememberModel,
        renderModelChips: renderModelChips,
        beginProcess: beginProcess,
        endProcess: endProcess,
        setUsage: setUsage,
        setDrawerHeight: setDrawerHeight,
        getDrawerHeight: getDrawerHeight,
        setSources: setSources,
        toolSummary: toolSummary,
        linkifySources: linkifySources,
        applyStoredLinks: applyStoredLinks,
        setRewindHandler: function (fn) {
            rewindHandler = typeof fn === 'function' ? fn : null;
        },
        setError: setError,
        setSaved: setSaved,
        setBusy: setBusy,
        showBubble: showBubble,
        hideBubble: hideBubble,
        openPresetList: openPresetList,
        closePresetList: closePresetList,
        positionPresetList: positionPresetList,
        renderMarkdown: renderMarkdown,
        /* 会话变化订阅：回调收到 {id, title, messages, reason} */
        onSessionChange: function (cb) {
            if (typeof cb !== 'function') return;
            sessionCallbacks.push(cb);
        },
        /* 把一段纯文字历史重画进消息区：先清空，再逐条画 */
        renderSessionMessages: function (messages) {
            paintSessionMessages(messages, sessionsCurrentId());
        },
        refs: refs
    };
})();
