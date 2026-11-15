/*
 * 计时器：状态机 + 本机存储。
 *
 * 真相是「时间戳对」，不是每秒累加：
 *     { mode, taskId, startedAt, accumulatedMs, targetMs }
 *     elapsed = accumulatedMs + (startedAt ? now - startedAt : 0)
 * 定时器只负责刷新显示；标签页被节流时显示会晚一拍，但重算的值照样对。
 *
 * 暂停：已跑时长折进 accumulatedMs、清空 startedAt。
 * 重置：连累计一起清零。
 * 存储键 ai-assistant.timer（全局单例，不做合并算法：各标签页读同一份时间戳即一致）。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var STORAGE_KEY = 'ai-assistant.timer';

    var state = fresh();
    var subscribers = [];

    function fresh() {
        return {
            mode: 'up',
            taskId: null,
            startedAt: null,
            accumulatedMs: 0,
            targetMs: null
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
            done: remaining !== null && remaining <= 0
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
        // 已在跑就继续跑：重复点「开始」不该把已跑时长清零
        if (state.startedAt === null) state.startedAt = Date.now();
        writeStorage();
        emit();
        return view();
    }
    function pause() {
        if (state.startedAt !== null) {
            state.accumulatedMs = elapsedOf(state, Date.now());
            state.startedAt = null;
        }
        writeStorage();
        emit();
        return view();
    }

    function reset() {
        state.startedAt = null;
        state.accumulatedMs = 0;
        writeStorage();
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
            emit();
        });
    }

    state = readStorage();

    AI.timer = {
        STORAGE_KEY: STORAGE_KEY,
        getState: getState,
        elapsedMs: elapsedMs,
        elapsedOf: elapsedOf,
        format: format,
        view: view,
        start: start,
        pause: pause,
        reset: reset,
        subscribe: subscribe,
        startTicking: startTicking,
        stopTicking: stopTicking
    };
})();
