/*
 * 到点音效（Issue #72）：浏览器里现场合成，不塞音频文件、不引外部地址、不引依赖。
 *
 * 解锁在「开始」的手势里做：浏览器要求音频在用户手势里创建/恢复 AudioContext，
 * 否则创建出来的上下文永远停在 suspended，到点无声。刷新恢复的倒计时拿不到手势，
 * 到点时只能走静音降级——只丢声音，不抛错，其余到点提醒照常。
 *
 * 10 / 25 / 45 三个预设用不同的波形、音高与音序，访客不用看就知道这一轮是哪种节奏：
 *   10 分钟 —— 方波上行三音，短促；
 *   25 分钟 —— 正弦三音钟声，居中；
 *   45 分钟 —— 三角波下行两音，最长。
 *
 * 静音开关：与实现一起在本模块里，状态存独立键、跨刷新保留，设置页只放一行。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    /* 独立键：静音状态与计时/清单/画像都不混在一起，刷新后读回来还是访客上次的选择 */
    var STORAGE_KEY = 'ai-assistant.audio-muted';

    /*
     * 三个预设的音色。同一份音列只换波形与起始音高，听感差别来自波形的泛音
     * 与音列走向，不靠任何音频文件。
     */
    var PRESETS = [
        { minutes: 10, osc: 'square', base: 523.25, seq: [1, 1.25, 1.5] },
        { minutes: 25, osc: 'sine', base: 659.25, seq: [1, 1.5, 2] },
        { minutes: 45, osc: 'triangle', base: 440, seq: [2, 1.5] }
    ];

    /* 每个音的时长与间隔：10 分钟最短，45 分钟最长 */
    var STEP = 0.14;
    var GAP = 0.10;

    /*
     * 自定义分钟数与清单条目自带的预估时长（5/8/12 分钟…）都不在三个预设里。
     * 这些到点照样得有声音：落到一支默认音色，静默丢声比换个音更糟。
     */
    var FALLBACK = { osc: 'sine', base: 587.33, seq: [1, 1.5] };

    function presetOf(minutes) {
        var target = Math.floor(Number(minutes));
        for (var i = 0; i < PRESETS.length; i++) {
            if (PRESETS[i].minutes === target) return PRESETS[i];
        }
        return FALLBACK;
    }

    /*
     * 取（或恢复）音频上下文。返回 null 表示浏览器不给音频能力
     * （jsdom、不支持 Web Audio 的环境）：调用方按降级处理。
     * 挂 webkit 前缀：老浏览器只在 webkitAudioContext 上提供这套能力。
     */
    function context() {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        if (!ctx) {
            try {
                ctx = new Ctor();
            } catch (e) {
                return null;
            }
        }
        return ctx;
    }

    var ctx = null;

    /* 上下文处于 suspended（没解锁或被系统暂停）时尝试恢复：手势里调用才可能成功 */
    function resume() {
        var ac = context();
        if (!ac) return null;
        if (ac.state === 'suspended' && typeof ac.resume === 'function') {
            try {
                ac.resume();
            } catch (e) {
                /* 恢复失败不抛：到点时按降级处理 */
            }
        }
        return ac;
    }

    function unlock() {
        var ac = resume();
        if (ac && ac.state === 'running') return true;
        return false;
    }

    /* 一个音：波形振荡器 + 包络（淡入淡出，避免爆音），结束自动摘掉节点 */
    function tone(ac, oscType, freq, at) {
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        osc.type = oscType;
        osc.frequency.setValueAtTime(freq, at);
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + STEP);
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start(at);
        osc.stop(at + STEP);
        osc.onended = function () {
            try {
                osc.disconnect();
                gain.disconnect();
            } catch (e) {
                /* 节点已摘就没什么可做的，声音已经播完 */
            }
        };
    }

    /*
     * 到点播一次。返回是否真的播了：
     * 没解锁、静音、上下文不可用或已暂停——都只降级掉声音，不抛错。
     * 返回 false 是正常降级，不是失败。
     */
    function play(minutes) {
        if (muted) return false;
        var preset = presetOf(minutes);
        if (!preset) return false;
        /*
         * 到点不创建上下文：只有访客手势（unlock）里建出来的那份才可能出声。
         * 在这里新建一个，等于在没有手势的情况下开一个永远 suspended 的上下文，
         * 还会盖掉页面里已有的音频包装（断言与后续 unlock 都受影响）。
         */
        var ac = ctx;
        if (!ac) return false;
        if (ac.state === 'suspended' && typeof ac.resume === 'function') {
            try {
                ac.resume();
            } catch (e) {
                /* 恢复失败只丢声音 */
            }
        }
        if (ac.state !== 'running') return false;
        var at = ac.currentTime;
        for (var i = 0; i < preset.seq.length; i++) {
            tone(ac, preset.osc, preset.base * preset.seq[i], at + i * (STEP + GAP));
        }
        return true;
    }

    /* 静音开关：状态在本模块里，设置页只是它的一个读出与写入口 */
    var muted = false;

    function readMuted() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            return raw === '1';
        } catch (e) {
            /* 存储不可用：按不静音处理，访客没关过就该有声音 */
            return false;
        }
    }

    function writeMuted() {
        try {
            window.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
        } catch (e) {
            /* 配额满或隐私模式：开关只在内存里生效，不跨刷新 */
        }
    }

    function setMuted(value) {
        muted = !!value;
        writeMuted();
        emit();
        return muted;
    }

    function isMuted() {
        return muted;
    }

    /* 开关被改动时通知设置页对齐（订阅者画错不该拖垮音效） */
    var subscribers = [];
    function emit() {
        for (var i = 0; i < subscribers.length; i++) {
            try {
                subscribers[i](muted);
            } catch (e) {
                /* 单个订阅者画错不该拖垮音效 */
            }
        }
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        subscribers.push(fn);
        fn(muted);
        return function () {
            var at = subscribers.indexOf(fn);
            if (at !== -1) subscribers.splice(at, 1);
        };
    }

    muted = readMuted();

    AI.audio = {
        STORAGE_KEY: STORAGE_KEY,
        unlock: unlock,
        play: play,
        setMuted: setMuted,
        isMuted: isMuted,
        subscribe: subscribe
    };
})();
