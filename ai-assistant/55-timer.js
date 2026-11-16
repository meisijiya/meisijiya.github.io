/*
 * 计时器：状态机 + 本机存储。
 *
 * 真相是「时间戳对」，不是每秒累加：
 *     { mode, taskId, startedAt, accumulatedMs, targetMs }
 *     elapsed = accumulatedMs + (startedAt ? now - startedAt : 0)
 * 定时器只负责刷新显示；标签页被节流时显示会晚一拍，但重算的值照样对。
 *
 * 暂停：已跑时长折进 accumulatedMs、清空 startedAt。
 * 到点：倒计时跑满目标时长时一次性停表（口径同暂停），目标时长留着给「再来一轮」。
 * 看门狗：面板关着、切到别的视图也一样到点停表——不然到点只在这一页开着计时视图时才发生。
 * 重置：连累计一起清零。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var STORAGE_KEY = 'ai-assistant.timer';

    var state = fresh();
    var subscribers = [];
    /* 看门狗心跳：只在倒计时在跑时存在。250ms 一跳，够快也不至于白烧 CPU */
    var watchdog = null;

    function fresh() {
        return {
            mode: 'up',
            taskId: null,
            startedAt: null,
            accumulatedMs: 0,
            targetMs: null,
            // 用户按下暂停（可恢复），与「结束本轮」（本轮收工）是两回事
            paused: false
        };
    }

    function normalize(raw) {
        var next = fresh();
        if (!raw || typeof raw !== 'object') return next;
        next.mode = raw.mode === 'down' ? 'down' : 'up';
        next.taskId = typeof raw.taskId === 'string' && raw.taskId ? raw.taskId : null;
        next.startedAt = typeof raw.startedAt === 'number' && isFinite(raw.startedAt)
            ? raw.startedAt
            : null;
        next.accumulatedMs = typeof raw.accumulatedMs === 'number' && isFinite(raw.accumulatedMs) && raw.accumulatedMs > 0
            ? Math.floor(raw.accumulatedMs)
            : 0;
        next.targetMs = typeof raw.targetMs === 'number' && isFinite(raw.targetMs) && raw.targetMs > 0
            ? Math.floor(raw.targetMs)
            : null;
        // 倒计时必须有目标时长，否则退化成正计时
        if (next.mode === 'down' && next.targetMs === null) next.mode = 'up';
        next.paused = raw.paused === true;
        return next;
    }

    function readStorage() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            return raw ? normalize(JSON.parse(raw)) : fresh();
        } catch (e) {
            // 存储不可用或 JSON 坏掉：按没在计时处理，不抛给页面
            return fresh();
        }
    }

    function writeStorage() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            /* 配额满或隐私模式：计时继续走内存，只是不跨刷新 */
        }
    }

    /* 已跑时长：纯函数，断言可以直接打 */
    function elapsedOf(snapshot, now) {
        var base = snapshot.accumulatedMs;
        if (snapshot.startedAt === null) return base;
        var delta = now - snapshot.startedAt;
        return base + (delta > 0 ? delta : 0);
    }

    function elapsedMs(now) {
        return elapsedOf(state, now === undefined ? Date.now() : now);
    }

    /* 显示口径：不到 1 小时 mm:ss，满 1 小时 h:mm:ss */
    function format(ms) {
        var total = Math.max(0, Math.floor(ms / 1000));
        var seconds = total % 60;
        var minutes = Math.floor(total / 60) % 60;
        var hours = Math.floor(total / 3600);
        var mm = minutes < 10 ? '0' + minutes : String(minutes);
        var ss = seconds < 10 ? '0' + seconds : String(seconds);
        if (hours > 0) return hours + ':' + mm + ':' + ss;
        return mm + ':' + ss;
    }

    /* 订阅者一次拿全：状态、已跑时长、倒计时剩余、到点与否 */
    function view(now) {
        var at = now === undefined ? Date.now() : now;
        var elapsed = elapsedOf(state, at);
        var remaining = state.mode === 'down' && state.targetMs !== null
            ? Math.max(0, state.targetMs - elapsed)
            : null;
        return {
            state: normalize(state),
            elapsedMs: elapsed,
            remainingMs: remaining,
            running: state.startedAt !== null,
            // 暂停态：用户按下暂停、还没恢复。界面据此给暂停专属视觉
            paused: state.paused === true,
            done: remaining !== null && remaining <= 0,
            // 到点是发生过的一次性事件：倒计时归零且已停表才算数。
            // 归零但看门狗还没轮到停表时不算数：提示不该比停表先到。
            finished: remaining !== null && remaining <= 0 && state.startedAt === null
        };
    }

    function emit() {
        for (var i = 0; i < subscribers.length; i++) {
            try {
                subscribers[i](view());
            } catch (e) {
                /* 单个订阅者画错不该拖垮计时 */
            }
        }
    }

    function start(opts) {
        var options = opts || {};
        if (options.taskId !== undefined) state.taskId = options.taskId || null;
        if (options.targetMs !== undefined) {
            state.targetMs = typeof options.targetMs === 'number' && options.targetMs > 0
                ? Math.floor(options.targetMs)
                : null;
        }
        if (options.mode !== undefined) {
            state.mode = options.mode === 'down' && state.targetMs !== null ? 'down' : 'up';
        } else if (state.targetMs !== null) {
            // 没显式给模式但给了目标时长：按带预估时长的任务倒计时
            state.mode = 'down';
        }
        // 没有目标时长就只能是正计时：模式与目标时长必须一致
        if (state.targetMs === null) state.mode = 'up';
        /*
         * 到点之后按「开始」是开新一轮，不是接着上一轮的尾巴跑：
         * 已跑时长已经跑满目标，不清零的话这一轮开出来瞬间又到点。
         */
        if (state.mode === 'down' && state.targetMs !== null &&
            state.startedAt === null && state.accumulatedMs >= state.targetMs) {
            state.accumulatedMs = 0;
        }
        // 已在跑就继续跑：重复点「开始」不该把已跑时长清零
        if (state.startedAt === null) state.startedAt = Date.now();
        // 恢复即离开暂停态：视觉回到计时中口径
        state.paused = false;
        writeStorage();
        ensureWatchdog();
        emit();
        return view();
    }
    function pause() {
        // 只有真的在跑才落暂停态：停过的表再按一次暂停不该假装「刚暂停」
        if (state.startedAt !== null) {
            state.accumulatedMs = elapsedOf(state, Date.now());
            state.startedAt = null;
            state.paused = true;
        }
        writeStorage();
        ensureWatchdog();
        emit();
        return view();
    }

    function reset() {
        state.startedAt = null;
        state.accumulatedMs = 0;
        state.paused = false;
        writeStorage();
        ensureWatchdog();
        emit();
        return view();
    }

    function getState() {
        return normalize(state);
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        subscribers.push(fn);
        fn(view());
        return function () {
            var at = subscribers.indexOf(fn);
            if (at !== -1) subscribers.splice(at, 1);
        };
    }

    /*
     * 看门狗：倒计时在跑就有一根心跳，到点由第一个发现的人执行。
     * 与界面那根刷新用的心跳分开：这根只管到点，不管显示。
     */
    function ensureWatchdog() {
        var need = state.mode === 'down' && state.targetMs !== null && state.startedAt !== null;
        if (need && watchdog === null) {
            watchdog = window.setInterval(finish, 250);
            return;
        }
        if (!need && watchdog !== null) {
            window.clearInterval(watchdog);
            watchdog = null;
        }
    }

    /*
     * 到点：一次性事件。只有「倒计时在跑且已跑满目标时长」才触发：
     * 已跑时长折进累计、清空起始时刻（与手动暂停同口径），目标时长保留。
     * 正计时不触发；startedAt 清空后再调用（含同步过来的标签页）一律空操作。
     */
    function finish() {
        if (state.mode !== 'down' || state.targetMs === null) return { fired: false, taskId: state.taskId };
        if (state.startedAt === null) return { fired: false, taskId: state.taskId };
        var at = Date.now();
        var elapsed = elapsedOf(state, at);
        /*
         * 共享真相：别的标签页可能先到点了。它已经停表，本页只同步结果，
         * 不重复流转（到点动作只做一次）。这一段必须排在「跑满没有」之前：
         * 别的标签页已经停表时，本页本地算出的已跑时长可能还没跑满。
         */
        var shared = readStorage();
        if (shared.mode === 'down' && shared.targetMs !== null &&
            shared.startedAt === null && shared.accumulatedMs >= shared.targetMs) {
            state = shared;
            emit();
            ensureWatchdog();
            return { fired: false, taskId: state.taskId };
        }
        if (elapsed < state.targetMs) return { fired: false, taskId: state.taskId };
        state.accumulatedMs = elapsed;
        state.startedAt = null;
        writeStorage();
        // 到点提醒分派（#74）：只有真正触发到点的那一次才分派，
        // 看门狗与跨标签同步都不会重复触发，这里也最不容易重复。
        if (AI.remind && typeof AI.remind.dispatch === 'function') {
            AI.remind.dispatch('arrival', {
                taskId: state.taskId,
                minutes: state.targetMs ? state.targetMs / 60000 : null,
                accumulatedMs: elapsed
            });
        }
        // 条目流转可重入：条目已是「已完成」就不再写
        if (state.taskId && AI.tasks && typeof AI.tasks.finishTiming === 'function') {
            AI.tasks.finishTiming(state.taskId, elapsed);
        }
        emit();
        ensureWatchdog();
        return { fired: true, taskId: state.taskId };
    }

    /* 再来一轮：按原目标时长重开，已跑时长归零、恢复运行态；条目退回「计时中」由调用方衔接 */
    function restart() {
        if (state.mode !== 'down' || state.targetMs === null) return view();
        state.accumulatedMs = 0;
        state.startedAt = Date.now();
        // 与 start() 同口径：重开一轮就是离开暂停态
        state.paused = false;
        writeStorage();
        ensureWatchdog();
        emit();
        return view();
    }

    /*
     * 结束本轮：这一轮到此为止（与「暂停」不同：暂停可恢复，结束是收尾）。
     * 停表口径与到点一致：已跑时长折进累计、清空起始时刻，目标时长留着，
     * 不自动开新一轮。条目流转复用 AI.tasks.finishTiming —— 与到点自动流转
     * 同一条规则，不另写一套状态迁移。
     */
    function endRound() {
        var elapsed = elapsedOf(state, Date.now());
        state.accumulatedMs = elapsed;
        state.startedAt = null;
        state.paused = false;
        writeStorage();
        ensureWatchdog();
        if (state.taskId && AI.tasks && typeof AI.tasks.finishTiming === 'function') {
            AI.tasks.finishTiming(state.taskId, elapsed);
        }
        emit();
        return view();
    }

    /*
     * 显示刷新：只刷新显示，不落盘、不累加。
     * 节流后停跳的秒数在重算时一并补上。
     */
    function startTicking(intervalMs) {
        if (ticking !== null) return;
        ticking = window.setInterval(emit, intervalMs > 0 ? intervalMs : 1000);
    }

    function stopTicking() {
        if (ticking === null) return;
        window.clearInterval(ticking);
        ticking = null;
    }

    var ticking = null;

    // 跨标签页：真相是时间戳对，读同一份即可，不需要合并算法
    if (window.addEventListener) {
        window.addEventListener('storage', function (event) {
            if (event.key !== STORAGE_KEY && event.key !== null) return;
            state = readStorage();
            ensureWatchdog();
            emit();
        });
    }

    state = readStorage();
    /*
     * 页面刚打开时倒计时可能已经跑满：这时到点立刻发生，不用等看门狗第一跳——
     * 否则访客打开页面看到的是一个永远为 0 的假读数。
     */
    if (state.mode === 'down' && state.targetMs !== null && state.startedAt !== null &&
        elapsedOf(state, Date.now()) >= state.targetMs) {
        finish();
    } else {
        // 页面刚打开时倒计时可能已经在跑：看门狗得接上，不然这一页永远等不到到点
        ensureWatchdog();
    }

    AI.timer = {
        STORAGE_KEY: STORAGE_KEY,
        getState: getState,
        elapsedMs: elapsedMs,
        format: format,
        view: view,
        start: start,
        pause: pause,
        reset: reset,
        subscribe: subscribe,
        startTicking: startTicking,
        finish: finish,
        restart: restart,
        endRound: endRound,
        stopTicking: stopTicking
    };
})();
