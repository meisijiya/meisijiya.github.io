/*
 * 到点提醒强度与分派（Issue #74）：三档 温和 / 强制 / 关，默认温和。
 *
 * 分派是纯逻辑，不散在渲染里：AI.remind.dispatch(kind, opts) 收一个 kind
 * （'arrival'）与目标分钟，按当前强度做该档该做的事；设置页与计时到点都调它。
 *
 *   温和：音效 + 面板提示 + 标题/图标标记；
 *   强制：温和全部 + 全视口遮罩（AI.overlay）；
 *   关：  面板提示 + 标题/图标标记，无声无遮罩。
 *
 * 强度存本机独立键、跨标签页同步（storage 事件）。到点是一次性事件：
 * dispatch 对同一次到点只做一遍（按 taskId + 已跑时长判重），
 * AI.remind.clear() 复原标记后下一轮到点照样能再分派。
 *
 * 标题标记与 favicon 都是内联字符串，不新增图片资产；复原可重复调用、不叠加。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var STORAGE_KEY = 'ai-assistant.remind';
    /* 已提醒过的到点落盘：刷新/换文章后不再重放同一次提醒 */
    var ACK_KEY = 'ai-assistant.remind.ack';
    var DEFAULT_KIND = 'gentle';

    var KINDS = ['gentle', 'force', 'off'];

    /* 标题与 favicon 的到点标记。favicon 是内联 SVG data URI，不引图片文件 */
    var TITLE_MARK = '⏰ 时间到了';
    var FAVICON_MARK =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23d9534f'/%3E%3Cpath d='M16 7v10l7 4' stroke='white' stroke-width='3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E";

    var originalTitle = null;
    var originalFavicon = null;
    var marked = false;

    var current = DEFAULT_KIND;
    var dispatched = {};

    /* ------------------------------ 强度 ------------------------------ */

    function isKind(value) {
        return KINDS.indexOf(value) !== -1;
    }

    function readKind() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (raw && isKind(raw)) return raw;
        } catch (e) {
            /* 存储不可用：按默认档走，不抛给页面 */
        }
        return DEFAULT_KIND;
    }

    function writeKind(value) {
        try {
            window.localStorage.setItem(STORAGE_KEY, value);
        } catch (e) {
            /* 配额满或隐私模式：强度留在内存，只是不跨刷新 */
        }
    }

    function intensity() {
        return current;
    }

    function setIntensity(value) {
        if (!isKind(value)) return current;
        current = value;
        writeKind(value);
        emit();
        return current;
    }

    var subscribers = [];
    function emit() {
        for (var i = 0; i < subscribers.length; i++) {
            try {
                subscribers[i](current);
            } catch (e) {
                /* 单个订阅者画错不该拖垮提醒 */
            }
        }
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        subscribers.push(fn);
        fn(current);
        return function () {
            var at = subscribers.indexOf(fn);
            if (at !== -1) subscribers.splice(at, 1);
        };
    }

    /* 跨标签页：别的标签页改了强度，本页跟着对齐 */
    if (window.addEventListener) {
        window.addEventListener('storage', function (event) {
            if (event.key !== STORAGE_KEY && event.key !== null) return;
            current = readKind();
            emit();
        });
    }

    /* 强度先读回本机存的档，再订阅：订阅首帧要画的是真实档，不是默认温和 */
    current = readKind();

    /*
     * 面板在 61-remind 之前挂载，选中态要在这里对齐：自己订阅（含载入这一份），
     * 并把画的职责交给 50-ui 的 paintRemindIntensity（那里只画不改）。
     */
    if (AI.ui && typeof AI.ui.paintRemindIntensity === 'function') {
        subscribe(function () {
            try {
                AI.ui.paintRemindIntensity();
            } catch (e) {
                /* 画错不该拖垮提醒 */
            }
        });
    }

    /* ------------------------------ 标题 / 图标标记 ------------------------------ */

    var ownsFaviconLink = false;

    function applyMark() {
        if (marked) return;
        if (originalTitle === null) originalTitle = document.title;
        /* 标记是追加，不覆盖原标题：访客看到的还是「原标题 + 到点」 */
        document.title = originalTitle + ' ' + TITLE_MARK;

        if (originalFavicon === null) originalFavicon = readFavicon();
        var link = document.querySelector('link[rel~="icon"]');
        if (!link) {
            /* 页面没有 favicon 链接：补一个带标记的，复原时摘掉 */
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
            ownsFaviconLink = true;
        }
        link.setAttribute('href', FAVICON_MARK);
        marked = true;
    }

    function readFavicon() {
        var link = document.querySelector('link[rel~="icon"]');
        return link ? link.getAttribute('href') : null;
    }

    /* 复原标记：可重复调用，不叠加、不误删访客自己的 favicon */
    function clearMark() {
        if (!marked) return;
        if (originalTitle !== null) document.title = originalTitle;
        var link = document.querySelector('link[rel~="icon"]');
        if (ownsFaviconLink) {
            /* 标记时补的链接：复原时整个摘掉，不留给访客一个空 favicon */
            if (link && link.parentNode) link.parentNode.removeChild(link);
        } else if (link && originalFavicon !== null) {
            link.setAttribute('href', originalFavicon);
        }
        marked = false;
        ownsFaviconLink = false;
        originalTitle = null;
        originalFavicon = null;
    }

    function isMarked() {
        return marked;
    }

    /* ------------------------------ 面板提示 ------------------------------ */

    var HINT_TEXT = '时间到了，起来休息一下。';

    function paintPanel() {
        /* 面板提示挂在面板根上：任何视图都看得见，面板关着则无效果（标题标记兜底） */
        if (!AI.ui || !AI.ui.refs || !AI.ui.refs.panel) return;
        var panel = AI.ui.refs.panel;
        var hint = panel.querySelector('.ai-remind-hint');
        if (!hint) {
            hint = document.createElement('p');
            hint.className = 'ai-remind-hint';
            hint.setAttribute('role', 'status');
            panel.appendChild(hint);
        }
        hint.textContent = HINT_TEXT;
    }

    /* 提示不是常驻广告：确认到点或开新一轮时摘掉，别让面板一直挂着「时间到了」 */
    function clearPanelHint() {
        if (!AI.ui || !AI.ui.refs || !AI.ui.refs.panel) return;
        var hint = AI.ui.refs.panel.querySelector('.ai-remind-hint');
        if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    }

    /* 已提醒过的到点：落盘一份，刷新/换文章后不再重放同一次提醒 */
    function readAck() {
        try {
            var raw = window.localStorage.getItem(ACK_KEY);
            var list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (e) {
            /* 存储坏了按没有提醒过处理：宁可多提醒一次，也别让到点彻底失联 */
            return [];
        }
    }

    function writeAck(list) {
        try {
            window.localStorage.setItem(ACK_KEY, JSON.stringify(list.slice(-20)));
        } catch (e) {
            /* 存不下就只在本次会话内去重 */
        }
    }

    /* ------------------------------ 分派 ------------------------------ */

    function dispatch(kind, opts) {
        var o = opts || {};
        var minutes = o.minutes;
        var key = o.taskId ? String(o.taskId) + '@' + o.accumulatedMs : null;

        /*
         * 幂等：同一次到点只分派一次。内存账挡同一次加载内的重复调用；
         * 落盘账只给「打开页面补分派」用（见文件末尾），这样访客确认过的那次到点
         * 换文章、刷新都不会重放，而显式分派仍按调用方语义执行。
         * 没有 taskId 的到点（不挂条目的倒计时）由调用方保证不重复调。
         */
        if (key && dispatched[key]) {
            return { dispatched: false, kind: current, reason: 'already' };
        }
        if (key) {
            dispatched[key] = true;
            var ack = readAck();
            if (ack.indexOf(key) === -1) {
                ack.push(key);
                writeAck(ack);
            }
        }

        var did = current;
        /* 温和与强制都出声：关档无音 */
        if (did !== 'off' && AI.audio && typeof AI.audio.play === 'function') {
            AI.audio.play(minutes);
        }
        paintPanel();
        applyMark();
        if (did === 'force' && AI.overlay && typeof AI.overlay.open === 'function') {
            AI.overlay.open({ title: '时间到了', message: '这一轮读完了，起来走两步。' });
        }
        return { dispatched: true, kind: current, sound: did !== 'off', overlay: did === 'force' };
    }

    /* 到点确认：复原标记与面板提示，清内存账，下一轮到点能再分派 */
    function clear() {
        clearMark();
        clearPanelHint();
        dispatched = {};
        return true;
    }

    /* ------------------------------ 到点接线 ------------------------------ */
    /*
     * 到点分派挂在 55-timer.js 的 finish() 里：看门狗只调它一次，且自带
     * 「已停表就不再触发」的一次性口径，在这里分派最不容易重复触发。
     * 面板关着、切了视图也一样到点，所以不挂在渲染订阅里。
     *
     * 本模块只补一种漏掉的情形：页面打开时倒计时早已跑满，finish() 在
     * 55-timer.js 加载那一刻触发，那时本模块还没载入（AI.remind 为空），
     * 分派被跳过。这里读一次终态补分派，访客打开页面不会看到「归零却没人提醒」。
     */
    if (AI.timer && typeof AI.timer.view === 'function' && AI.timer.view().finished) {
        var arrival = AI.timer.view();
        var arrivalTask = AI.timer.getState().taskId;
        var arrivalKey = arrivalTask ? String(arrivalTask) + '@' + arrival.elapsedMs : null;
        /* 这轮到点已经提醒过了（刷新/换文章前就分派过）：补分派会把遮罩与标记重放一遍 */
        if (!arrivalKey || readAck().indexOf(arrivalKey) === -1) {
            dispatch('arrival', {
                taskId: arrivalTask,
                minutes: AI.timer.getState().targetMs ? AI.timer.getState().targetMs / 60000 : null,
                accumulatedMs: arrival.elapsedMs
            });
        }
    }

    /*
     * 访客确认到点后复原标记：遮罩的唯一出口「去休息」是确认动作，
     * 用捕获阶段接住这次点击（不碰遮罩自己的关闭逻辑），复原可重复触发。
     */
    if (document.addEventListener) {
        document.addEventListener('click', function (event) {
            var hit = event.target && event.target.closest ? event.target.closest('.ai-overlay-exit') : null;
            if (hit) clearMark();
        }, true);
    }

    current = readKind();

    AI.remind = {
        STORAGE_KEY: STORAGE_KEY,
        intensity: intensity,
        setIntensity: setIntensity,
        subscribe: subscribe,
        dispatch: dispatch,
        clear: clear,
        applyMark: applyMark,
        clearMark: clearMark,
        isMarked: isMarked
    };
})();
