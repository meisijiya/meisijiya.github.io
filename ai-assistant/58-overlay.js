/*
 * 到点强制遮罩：盖住文章与助手面板的全屏模态，只有「去休息」一个出口。
 *
 * 口径（票 #73）：
 *   - Esc 不关、点空白不关、Tab 不跑出去：强制档的遮罩没有逃生口；
 *   - 焦点进遮罩并困在里面，关闭后还给打开前的那个元素；
 *   - 语义是模态对话框（role=dialog + aria-modal + aria-labelledby 指向标题），
 *     到点文案用 aria-live 念出来；
 *   - 大字烤在 SVG 里（内联字符串，不新增图片资产），DOM 不新增字号档。
 *
 * 挂载位置：document.body，不是 .ai-root。
 * 原因：.ai-root 自己就是 z-index 10000 的层叠上下文，主题的站内搜索浮层
 * （.scrim 11000 / .panel 11001）会整块盖住它，遮罩压不住主题浮层；
 * 挂到 body 下才能真的盖过一切。代价是拿不到 .ai-root 的令牌，
 * 29-remind.css 里按助手同一套尺度复刻，不新增字号档。
 *
 * 到点时谁调 open() 不归本文件管（分派在 61-remind.js）。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var OVERLAY_CLASS = 'ai-overlay';
    var TITLE_ID = 'ai-overlay-title';
    var MSG_ID = 'ai-overlay-msg';
    var EXIT_LABEL = '去休息';

    var overlay = null;
    var exitBtn = null;
    var msgEl = null;
    var lastFocus = null;
    var keyHandler = null;

    /* SVG 文本要转义：文案来自调用方，拼进标记前先转义 */
    function escapeText(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /*
     * 大字封面：内联 SVG 字符串，不新增图片资产。
     * 字画在 SVG 里（不是 DOM 字号档），aria-hidden 让屏幕阅读器只读下面的正文。
     */
    function coverSvg(title) {
        return '<svg class="ai-overlay-cover" viewBox="0 0 640 200" ' +
            'preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">' +
            '<text x="320" y="96" text-anchor="middle" font-size="76" font-weight="700" ' +
            'fill="currentColor">' + escapeText(title) + '</text>' +
            '<text x="320" y="152" text-anchor="middle" font-size="26" ' +
            'fill="currentColor" opacity="0.72">该休息了</text>' +
            '</svg>';
    }

    /* 遮罩里可聚焦的东西（目前只有「去休息」一个出口） */
    function focusables() {
        if (!overlay) return [];
        var nodes = overlay.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), ' +
            'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        return Array.prototype.slice.call(nodes);
    }

    /*
     * 键盘：Esc 被吃掉但不关遮罩；Tab 自己接管，把焦点留在遮罩里。
     *
     * 这里刻意只留这一道机制（不另加「焦点跑出去就拉回来」的兜底）：
     * 兜底会把「Tab 没被拦住」这个缺陷盖住——缺陷一旦被盖住，门禁就测不出
     * 灵敏度了。Tab 的默认行为是从出口按钮跳到文档里下一个可聚焦元素，
     * 也就是跳到遮罩背后的文章链接上，正是这条要防的事。
     */
    function handleKey(event) {
        if (!overlay) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (event.key !== 'Tab') return;
        var items = focusables();
        if (!items.length) return;
        event.preventDefault();
        var idx = items.indexOf(document.activeElement);
        var next;
        if (event.shiftKey) next = idx <= 0 ? items.length - 1 : idx - 1;
        else next = idx < 0 ? 0 : (idx + 1) % items.length;
        items[next].focus();
    }

    /* 已有遮罩时只改文案，不重建（重建会把焦点甩掉） */
    function paint(title, message) {
        if (!overlay) return;
        var cover = overlay.querySelector('.ai-overlay-cover-box');
        if (cover) cover.innerHTML = coverSvg(title);
        var titleEl = document.getElementById(TITLE_ID);
        if (titleEl) titleEl.textContent = title;
        if (msgEl) msgEl.textContent = message;
    }

    function open(opts) {
        var o = opts || {};
        var title = String(o.title || '时间到了');
        var message = String(o.message || o.text || '这一轮读完了，起来走两步。');
        if (overlay) {
            paint(title, message);
            return overlay;
        }

        lastFocus = document.activeElement;

        var box = document.createElement('div');
        box.className = OVERLAY_CLASS;
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', TITLE_ID);
        box.setAttribute('aria-describedby', MSG_ID);
        box.tabIndex = -1;

        var cover = document.createElement('div');
        cover.className = 'ai-overlay-cover-box';
        cover.setAttribute('aria-hidden', 'true');
        cover.innerHTML = coverSvg(title);
        box.appendChild(cover);

        /*
         * 标题只做无障碍名（对话框的可访问名）：大字已经在 SVG 里，
         * 这里再显示一遍会重复，视觉上藏起来（29-remind.css 的 .ai-overlay-title）。
         */
        var titleEl = document.createElement('p');
        titleEl.className = 'ai-overlay-title';
        titleEl.id = TITLE_ID;
        titleEl.textContent = title;
        box.appendChild(titleEl);

        /*
         * 到点正文：既是可见文本，也是 aria-live 区域。
         * 文案在挂载之后再写进去——live 区域带着内容一起插入时，
         * 读屏软件往往不播报这一句。
         */
        msgEl = document.createElement('p');
        msgEl.className = 'ai-overlay-msg';
        msgEl.id = MSG_ID;
        msgEl.setAttribute('aria-live', 'assertive');
        msgEl.setAttribute('aria-atomic', 'true');
        box.appendChild(msgEl);

        exitBtn = document.createElement('button');
        exitBtn.type = 'button';
        exitBtn.className = 'ai-overlay-exit';
        exitBtn.textContent = EXIT_LABEL;
        exitBtn.addEventListener('click', function () {
            close();
        });
        box.appendChild(exitBtn);

        overlay = box;
        document.body.appendChild(box);

        keyHandler = handleKey;
        document.addEventListener('keydown', keyHandler, true);

        /* 焦点进遮罩：落在唯一出口上，读屏软件先念到它 */
        exitBtn.focus();

        /* 挂载后再填文案：live 区域先存在、内容后到，读屏软件才会播这一句 */
        if (msgEl) msgEl.textContent = message;

        return box;
    }

    function close() {
        if (!overlay) return false;
        var box = overlay;
        overlay = null;
        if (keyHandler) {
            document.removeEventListener('keydown', keyHandler, true);
            keyHandler = null;
        }
        if (box.parentNode) box.parentNode.removeChild(box);
        exitBtn = null;
        msgEl = null;
        var back = lastFocus;
        lastFocus = null;
        /* 焦点还给打开前的那个元素；它已经不在文档里就退给 body */
        if (back && back.focus && document.contains(back)) {
            try {
                back.focus();
            } catch (e) {
                /* 元素不可聚焦时忽略，焦点停在 body */
            }
        }
        return true;
    }

    function isOpen() {
        return !!overlay;
    }

    AI.overlay = {
        open: open,
        close: close,
        isOpen: isOpen
    };
})();
