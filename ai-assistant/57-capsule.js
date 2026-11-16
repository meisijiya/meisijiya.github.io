/*
 * 计时胶囊：悬浮球上方那颗常驻小胶囊，写当前这一轮的时长。
 *
 * 显示口径（与计时视图同一条，跟随模式）：
 *   - 倒计时模式显示剩余时间，正计时模式显示已跑时长，都用 AI.timer.format；
 *   - 到点（倒计时跑满且已停表）→ 强调色 + 文案「到点」；
 *   - 暂停/停止（没在跑但有累计）→ 次级色 + 文案「已停」；
 *   - 计时没开始、且没有任何累计 → 整颗隐藏，不在屏幕上占位。
 *
 * 避障：候选顺序固定「正上方 → 左上 → 右上 → 视口左上角 → 视口右上角」，
 * 每个候选过两道检查（矩形完整在视口内、与面板/目录球/其它浮层不相交），
 * 选第一个可用者；全不可用时贴视口边缘并缩窄胶囊，仍要留在视口内。
 * 面板打开期间候选集合不变，遮挡判定每次落位都重新取当前矩形。
 *
 * 位置计算抽成纯函数 place()：输入矩形，不碰 DOM，jsdom 冒烟直接打它。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    /* 避障要躲的东西：面板 + 主题目录球 + 其它助手浮层 */
    var OBSTACLE_SELECTORS = [
        '.ai-panel',
        '.ai-rewind-confirm',
        '.ai-selection-bubble',
        '.ai-session-panel',
        '.toc-mobile-fab',
        '.toc-mobile-drawer.active'
    ];

    /* 视口边缘留白：太贴边会被浏览器裁掉一两个像素 */
    var EDGE = 8;
    /* 胶囊与悬浮球的间距 */
    var GAP = 10;
    /* 缩窄后的最小宽度，低于这个数文字就挤成一团了 */
    var MIN_NARROW = 48;

    function rectOf(box) {
        return {
            left: box.left,
            top: box.top,
            right: box.left + box.width,
            bottom: box.top + box.height,
            width: box.width,
            height: box.height
        };
    }

    function intersects(a, b) {
        return !(a.right <= b.left || b.right <= a.left ||
            a.bottom <= b.top || b.bottom <= a.top);
    }

    /* 矩形是否完整落在视口内 */
    function insideViewport(r, viewport) {
        return r.left >= 0 && r.top >= 0 &&
            r.right <= viewport.width && r.bottom <= viewport.height;
    }

    function hitAny(r, obstacles) {
        for (var i = 0; i < obstacles.length; i++) {
            if (intersects(r, obstacles[i])) return true;
        }
        return false;
    }

    function clampX(left, width, viewport) {
        var max = viewport.width - EDGE - width;
        if (max < EDGE) return EDGE;
        if (left < EDGE) return EDGE;
        if (left > max) return max;
        return left;
    }

    /*
     * 纯函数：算胶囊该贴哪。
     *   opts = { fabRect, viewport, obstacles, capsuleSize, gap? }
     *   返回 { left, top, width, fallback }
     * fallback=true 表示没找到可用候选，走的贴边缩窄降级。
     */
    function place(opts) {
        /* 调用方可能只给 {left,top,width,height}：右上候选要用的右边界自己算 */
        var fab = rectOf(opts.fabRect);
        var viewport = opts.viewport;
        var size = opts.capsuleSize;
        var obstacles = opts.obstacles || [];
        var gap = typeof opts.gap === 'number' ? opts.gap : GAP;
        var w = size.width;
        var h = size.height;

        function candidates(width) {
            var center = fab.left + fab.width / 2 - width / 2;
            return [
                { left: center, top: fab.top - gap - h },                                  // 正上方
                { left: fab.left - gap - width, top: fab.top - gap - h },                  // 左上
                { left: fab.right + gap, top: fab.top - gap - h },                         // 右上
                { left: EDGE, top: EDGE },                                                 // 视口左上角
                { left: viewport.width - EDGE - width, top: EDGE }                         // 视口右上角
            ];
        }

        function firstFree(width) {
            var list = candidates(width);
            for (var i = 0; i < list.length; i++) {
                var r = rectOf({ left: list[i].left, top: list[i].top, width: width, height: h });
                if (!insideViewport(r, viewport)) continue;
                if (hitAny(r, obstacles)) continue;
                return { left: Math.round(list[i].left), top: Math.round(list[i].top), width: width };
            }
            return null;
        }

        var found = firstFree(w);
        if (found) {
            found.fallback = false;
            return found;
        }

        /* 降级一档：缩窄胶囊，再按同一套候选顺序找一次 */
        var narrowed = Math.max(MIN_NARROW, Math.min(w, viewport.width - EDGE * 2));
        if (narrowed < w) {
            var narrowHit = firstFree(narrowed);
            if (narrowHit) {
                narrowHit.fallback = true;
                return narrowHit;
            }
        }

        /* 降级二档：贴视口上边，只保证在视口内（遮挡已无处可躲） */
        var edgeLeft = clampX(fab.left + fab.width / 2 - narrowed / 2, narrowed, viewport);
        return {
            left: Math.round(edgeLeft),
            top: EDGE,
            width: narrowed,
            fallback: true
        };
    }

    /* ------------------------------------------------------------- DOM */

    var capsule = null;
    var tickTimer = null;

    function collectObstacles() {
        var out = [];
        for (var i = 0; i < OBSTACLE_SELECTORS.length; i++) {
            var nodes = document.querySelectorAll(OBSTACLE_SELECTORS[i]);
            for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j];
                if (node.hidden) continue;
                if (node.getBoundingClientRect().width === 0) continue;
                out.push(rectOf(node.getBoundingClientRect()));
            }
        }
        return out;
    }

    function render() {
        if (!capsule) return;
        var snap = AI.timer.view();
        // 显示口径跟计时视图同一条：倒计时显示剩余，正计时显示已跑
        var ms = snap.remainingMs !== null ? snap.remainingMs : snap.elapsedMs;
        var time = AI.timer.format(ms);
        if (capsule.getAttribute('data-time') !== time) {
            capsule.setAttribute('data-time', time);
            capsule.querySelector('.ai-capsule-time').textContent = time;
        }
        /* 到点是第三种显示态：数字停在 00:00，但要让人看出「这一轮到点了」 */
        var arrived = !!snap.finished;
        var state = arrived ? '到点' : (snap.running ? '' : '已停');
        if (capsule.getAttribute('data-state') !== state) {
            capsule.setAttribute('data-state', state);
            capsule.querySelector('.ai-capsule-state').textContent = state;
        }
        capsule.classList.toggle('is-stopped', !snap.running && !arrived);
        capsule.classList.toggle('is-arrived', arrived);
        /* 没开始且没有任何累计时不占位，直接整颗藏起来 */
        capsule.hidden = !(snap.running || snap.elapsedMs > 0);
    }

    function layout() {
        if (!capsule || capsule.hidden || !AI.ui || !AI.ui.refs || !AI.ui.refs.fab) return;
        var fabBox = AI.ui.refs.fab.getBoundingClientRect();
        if (!fabBox.width) return;
        /* 先清掉上一次降级写死的宽度，量到的才是内容的自然宽度 */
        capsule.style.width = '';
        var natural = capsule.getBoundingClientRect();
        var size = { width: natural.width || 96, height: natural.height || 26 };
        var placed = place({
            fabRect: rectOf(fabBox),
            viewport: { width: window.innerWidth, height: window.innerHeight },
            obstacles: collectObstacles(),
            capsuleSize: size
        });
        capsule.style.width = placed.width < size.width ? placed.width + 'px' : '';
        capsule.style.left = placed.left + 'px';
        capsule.style.top = placed.top + 'px';
    }

    function sync() {
        render();
        /*
         * 胶囊可见就保证轮询在跑、隐藏就停：
         * 挂载时计时往往还没开始（胶囊隐藏），那时起的轮询会被下面藏掉；
         * 计时开始后要靠这一句把轮询重新拉起来，否则胶囊文字冻结在开始那一刻。
         * 常驻的 setInterval 会把 jsdom 里的事件循环钉住，门禁脚本跑完不退出；
         * 真浏览器里隐藏时停掉也是省掉每 250ms 一次的读矩形。
         */
        if (!capsule || capsule.hidden) {
            stopTicking();
            return;
        }
        if (tickTimer === null) startTicking();
        layout();
    }

    /*
     * 落位靠定时重算而不是事件：拖球、面板开合、切视图都会改遮挡物的矩形，
     * 一个个挂监听既漏又碎。250ms 一次的读矩形开销可以忽略。
     */
    function startTicking() {
        if (tickTimer !== null) return;
        if (!capsule || capsule.hidden) return;
        tickTimer = window.setInterval(sync, 250);
    }

    function stopTicking() {
        if (tickTimer === null) return;
        window.clearInterval(tickTimer);
        tickTimer = null;
    }

    function openTimerView() {
        if (!AI.ui) return;
        AI.ui.setOpen(true);
        AI.ui.setState('timer');
    }

    /*
     * 挂进 .ai-root：层级高于面板（面板 10000 的子层里排最后且带 z-index）。
     * 由 60-main.js 在 AI.ui.mount() 之后调用，不碰 50-ui.js 的既有结构。
     */
    function mount() {
        if (capsule || !AI.ui || !AI.ui.refs || !AI.ui.refs.root) return;
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'ai-capsule';
        el.setAttribute('aria-label', '计时胶囊');
        el.hidden = true;

        var time = document.createElement('span');
        time.className = 'ai-capsule-time';
        el.appendChild(time);
        var state = document.createElement('span');
        state.className = 'ai-capsule-state';
        el.appendChild(state);

        el.addEventListener('click', openTimerView);
        AI.ui.refs.root.appendChild(el);
        capsule = el;

        if (AI.timer && AI.timer.subscribe) AI.timer.subscribe(sync);
        sync();
        startTicking();
    }

    AI.capsule = {
        place: place,
        intersects: intersects,
        insideViewport: insideViewport,
        mount: mount,
        openTimerView: openTimerView
    };
})();
