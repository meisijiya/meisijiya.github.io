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
        chevron: ['M6.5 9.5l5.5 5.5 5.5-5.5'],
        source: ['M6.5 3.5h8l4 4v13h-12z', 'M14.5 3.5v4h4']
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
     * 落盘的数据一律重新洗一遍结构：只认 role/content，
     * 消息只留文字（工具过程不进历史），条数超上限的丢最旧的。
     */
    function normalizeSession(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var messages = [];
        var list = Array.isArray(raw.messages) ? raw.messages : [];
        for (var i = 0; i < list.length; i++) {
            var one = list[i];
            if (!one || (one.role !== 'user' && one.role !== 'assistant')) continue;
            messages.push({
                role: one.role,
                content: typeof one.content === 'string' ? one.content : ''
            });
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

    function saveNow() {
        try {
            window.localStorage.setItem(SESSION_KEY, JSON.stringify(store()));
            return true;
        } catch (e) {
            // 配额满或存储被禁：留在内存里继续用
            return false;
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
            return { role: m.role, content: m.content };
        });
    }

    /*
     * 界面自己先动：会话变了就把消息区切成对应的内容。
     * 只认 create/select/remove 三种「当前会话换了」的情况，
     * 追加消息不重画——正文正在流式输出，重画会把流打断。
     */
    function handleStoreChange(reason, session, extra) {
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
        session.messages.push({ role: msg.role, content: content });
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
            clean.push({
                role: one.role,
                content: typeof one.content === 'string' ? one.content : ''
            });
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
            var body = el('div', 'ai-bubble');
            msg.appendChild(body);
            body.innerHTML = renderMarkdown(one.content || '');
            refs.stream.appendChild(msg);
        }
        if (list.length) {
            refs.stream.appendChild(el('p', 'ai-session-note', '历史会话只保留文字，工具过程未保留'));
        }
        // 旧节点都被清掉了，指向它们的引用要跟着清
        errorNode = null;
        pendingNode = null;
        processNode = null;
        processBody = null;
        refs.answerMsg = null;
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
        fab.setAttribute('aria-label', '打开 AI 阅读助手');
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
        row.appendChild(el('h2', 'ai-panel-title', 'AI 阅读助手'));

        /*
         * 上下文提示跟标题排同一行、紧跟标题右边：它说的是「当前读到哪」，
         * 占一整行反而把标题和标签栏挤散了。
         */
        var context = el('p', 'ai-panel-context', '（不在文章页）');
        context.dataset.act = 'toggle-context';
        context.setAttribute('role', 'button');
        context.setAttribute('tabindex', '0');
        context.title = '点击切换是否携带上下文';
        refs.contextLine = context;
        row.appendChild(context);

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
        conn.card.appendChild(lineField('模型', 'model', 'text', 'gpt-4o-mini'));
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

        var row = el('div', 'ai-input-row');
        var input = el('textarea', 'ai-input');
        input.rows = 1;
        input.setAttribute('aria-label', '输入问题');
        input.placeholder = '就本文提问，Enter 发送，Shift+Enter 换行';
        refs.composer = input;
        row.appendChild(input);

        var send = el('button', 'ai-send');
        send.type = 'button';
        send.dataset.act = 'send';
        send.setAttribute('aria-label', '发送');
        send.disabled = true;
        send.appendChild(icon(ICONS.send));
        refs.sendBtn = send;
        row.appendChild(send);

        composer.appendChild(row);
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
        panel.setAttribute('aria-label', 'AI 阅读助手');
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

        main.appendChild(views);
        main.appendChild(buildComposer());
        main.appendChild(buildSettingsFoot());
        body.appendChild(main);
        panel.appendChild(body);
        return panel;
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

    function setOpen(open) {
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
            return;
        }
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

    function syncViewport() {
        var narrow = isNarrow();
        refs.root.classList.toggle('is-mobile', narrow);
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
        var top = fab.top + fab.height / 2 < window.innerHeight / 2
            ? fab.bottom + gap
            : fab.top - gap - height;
        top = Math.min(Math.max(top, margin), Math.max(margin, window.innerHeight - height - margin));
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

        if (!enabled) {
            refs.contextLine.textContent = '（未携带上下文）';
        } else {
            var parts = [];
            if (article) parts.push('《' + article + '》');
            if (section) parts.push(section);
            refs.contextLine.textContent = parts.length ? parts.join(' ') : '（不在文章页）';
        }

        refs.quotePath.textContent = section || article || '';
        refs.quoteText.textContent = quote;
        refs.quoteBox.hidden = !quote;
    }

    /* -------------------------------------------------------------- 消息区 */

    function scrollToBottom() {
        refs.stream.scrollTop = refs.stream.scrollHeight;
    }

    function appendMessage(role, text) {
        var isUser = role === 'user';
        var msg = el('article', 'ai-msg ai-msg-' + (isUser ? 'user' : 'ai'));
        var body = el('div', 'ai-bubble');
        msg.appendChild(body);
        // 助手消息竖排：气泡在上，来源行在下
        if (!isUser) {
            var sourceList = el('div', 'ai-source-list');
            sourceList.hidden = true;
            msg.appendChild(sourceList);
            refs.answerMsg = msg;
        }
        refs.stream.appendChild(msg);
        if (text) body.innerHTML = renderMarkdown(text);
        if (refs.emptyState) refs.emptyState.hidden = true;
        scrollToBottom();
        return { root: msg, body: body };
    }

    /*
     * 思考内容：挂进「过程」分组，做成独立一块、默认收起。
     * 没有过程分组时（直接调 appendThinking 的旧路径）退回挂在消息上方。
     */
    function appendThinking(text) {
        if (!text) return null;
        var host = processBody;
        var box = host ? host.querySelector('.ai-thinking') : null;
        if (!box) {
            box = el('details', 'ai-thinking');
            box.appendChild(el('summary', 'ai-thinking__summary', '思考过程'));
            box.appendChild(el('div', 'ai-thinking__body'));
            if (host) {
                host.appendChild(box);
            } else {
                var msg = refs.answerMsg;
                if (!msg || !msg.parentNode) {
                    msg = appendMessage('assistant', '').root;
                }
                msg.insertBefore(box, msg.firstChild);
            }
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
     * 过程分组：工具调用与思考都收在这里，结束时整体挪到消息流末尾并折叠。
     * 分组默认展开——用户要先看见「调了哪些工具」，再决定要不要看细节。
     */
    function beginProcess() {
        var details = el('details', 'ai-process');
        details.open = true;
        details.appendChild(el('summary', 'ai-process__summary', '过程'));
        var body = el('div', 'ai-process__body');
        details.appendChild(body);
        refs.stream.appendChild(details);
        processNode = details;
        processBody = body;
        scrollToBottom();
        return details;
    }

    /*
     * 收尾：把过程条挪到消息流最后（答案气泡才是本轮正身），
     * 折起来并把摘要写成「查看过程 · N 次工具调用 · 思考 X.Xs」。
     */
    function endProcess(meta) {
        var node = processNode;
        if (!node) return null;
        var stats = meta || {};
        var toolCalls = (typeof stats.toolCalls === 'number' && isFinite(stats.toolCalls)) ? stats.toolCalls : 0;
        var thinkMs = (typeof stats.thinkMs === 'number' && isFinite(stats.thinkMs)) ? stats.thinkMs : 0;

        var text = '查看过程';
        if (toolCalls > 0) {
            text += ' · ' + toolCalls + ' 次工具调用';
            if (thinkMs > 0) text += ' · 思考 ' + (thinkMs / 1000).toFixed(1) + 's';
        }
        var summary = node.querySelector('.ai-process__summary');
        if (summary) summary.textContent = text;

        // 折叠：摘掉 open 属性，浏览器与辅助技术都读作「已收起」
        node.open = false;
        node.removeAttribute('open');

        refs.stream.appendChild(node);
        processNode = null;
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
    function setSources(items) {
        var old = refs.stream.querySelectorAll('.ai-source-list');
        for (var i = 0; i < old.length; i++) {
            old[i].innerHTML = '';
            old[i].hidden = true;
        }
        if (!items || !items.length) return;

        var host = refs.answerMsg;
        if (!host || !host.parentNode) {
            host = appendMessage('assistant', '').root;
        }
        var list = host.querySelector('.ai-source-list');
        if (!list) {
            list = el('div', 'ai-source-list');
            host.appendChild(list);
        }
        // 来源只展示前几条：一次检索能命中十几篇，全列出来是噪音，
        // 真正该被引用的是模型正文里提到的那几篇。
        // 引用过的（kind='quoted'）排在前面，否则上限一截，
        // 用户看到的全是没读过的候选。
        var MAX_SHOWN_SOURCES = 5;
        var ordered = items.slice().sort(function (a, b) {
            return (a.kind === 'quoted' ? 0 : 1) - (b.kind === 'quoted' ? 0 : 1);
        });
        var shown = ordered.slice(0, MAX_SHOWN_SOURCES);
        shown.forEach(function (item) {
            var link = el('a', 'ai-source');
            if (item.url) {
                link.href = item.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            link.appendChild(icon(ICONS.source, 'ai-source-mark'));
            // 标题单独包一层：裸文本节点在 flex 容器里是匿名项，
            // 省略号不会生效，只能硬切
            link.appendChild(el('span', 'ai-source-title', '来源《' + (item.title || '') + '》'));
            list.appendChild(link);
        });
        if (items.length > shown.length) {
            list.appendChild(el('span', 'ai-source-more', '还有 ' + (items.length - shown.length) + ' 篇候选'));
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
        errorNode = msg;
        refs.stream.appendChild(msg);
        scrollToBottom();
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
        refs.sendBtn.disabled = busy || !refs.composer.value.trim();
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
     * 行内解析：先 escapeHtml 再做替换，插值文本一律转义，防注入。
     * 行内代码先抠成占位符，等其它语法都替完再放回去——
     * 否则代码里的 ** 会先被粗体吃掉。
     */
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
        out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
            if (!safeUrl(href)) return m;
            return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
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
        isCompact: isCompact,
        setFabPosition: setFabPosition,
        getFabPosition: getFabPosition,
        setPanelPosition: setPanelPosition,
        defaultFabPosition: defaultFabPosition,
        placePanel: placePanel,
        setSideLock: function (locked) { sideLock = !!locked; },
        setContext: setContext,
        appendMessage: appendMessage,
        appendThinking: appendThinking,
        setPending: setPending,
        appendToolCard: appendToolCard,
        beginProcess: beginProcess,
        endProcess: endProcess,
        setUsage: setUsage,
        setDrawerHeight: setDrawerHeight,
        getDrawerHeight: getDrawerHeight,
        setSources: setSources,
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
