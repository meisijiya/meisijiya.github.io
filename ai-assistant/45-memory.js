/*
 * 读者画像（Issue #61）
 *
 * 她记得读者明说过的偏好。画像全局一份、跨会话共享，结构是键值对，上限 200 字。
 *
 * 三条硬约束：
 *   1. 画像只能拼在读者原话**之前**注入，且只在画像有变更（或历史里已经没有画像段）时注入；
 *      它不进稳定前缀——它会变，进前缀就把缓存废了。
 *   2. provider 历史存**改写后**的文本（含画像段），会话存储存**读者原话**；
 *      回退按内容匹配时必须先剥掉画像段，否则读者找不到自己那条消息。
 *   3. 敏感信息一概不记：密码、密钥、身份证、住址、电话、邮箱、第三方私密、健康医疗。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var STORAGE_KEY = 'ai-assistant.memory';
    /*
     * 画像总字数上限：键 + 值。200 字只够五六条，一条「偏好」就吃掉二三十字，
     * 实际用起来立刻顶格；400 字能装十来条，仍远小于一次注入的正文预算。
     */
    var MAX_CHARS = 400;
    /* 画像段标识：整段用 <memory> 包起来，标签下第一行写权威说明 */
    var SEGMENT_HEAD = '<memory>';
    var SEGMENT_NOTE = '读者画像，可能过时；读者说错了以读者为准';
    var SEGMENT_END = '</memory>';

    /* 撤销上一次改动只需要回退一版：每次写入前把当前画像存到这一格 */
    var PREV_KEY = 'ai-assistant.memory-prev';

    /*
     * 敏感信息分类：宿主侧过滤，与提示词里的约束双保险。
     * 关键词为主、号码格式为辅：画像条目很短，关键词足够覆盖，
     * 号码格式只用来兜住「没写「手机号」三个字但把号写出来了」的情况。
     */
    var SENSITIVE_RULES = [
        { category: '密码', re: /(密码|口令|passcode|passwo?rd|passwd)/i },
        { category: '密钥', re: /(密钥|秘钥|私钥|api[\s_-]?key|apikey|access[\s_-]?key|secret|token)/i },
        { category: '身份证', re: /(身份证|证件号码)|\d{17}[\dXx]/ },
        { category: '住址', re: /(住址|现居|户籍|住在|搬到|门牌号)/ },
        { category: '电话', re: /(电话|手机|联系方式|联系电话)|1[3-9]\d{9}/ },
        { category: '邮箱', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}|邮箱|电子邮件|e-?mail/i },
        { category: '第三方私密', re: /(别人|他人|第三方|同事|朋友|家人)[\s\S]{0,10}(隐私|私密|秘密|工资|薪资|存款|聊天记录)/ },
        { category: '健康医疗', re: /(病史|病历|诊断|症状|用药|过敏|手术|住院|血糖|血压|抑郁|焦虑|就诊)/ }
    ];

    /* 每个会话一份注入状态：上次注入的哈希、画像段还在不在历史里 */
    var sessions = {};

    /* ------------------------------------------------------------ 基础工具 */

    function normalizeText(value) {
        return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    }

    /* 内容哈希：只看规范化后的键值，来源标记不算内容变化 */
    function hashOf(entries) {
        var parts = [];
        for (var i = 0; i < entries.length; i++) {
            parts.push(normalizeText(entries[i].key) + '=' + normalizeText(entries[i].value));
        }
        parts.sort();
        var text = parts.join('\n');
        var h = 5381;
        for (var j = 0; j < text.length; j++) {
            h = ((h << 5) + h + text.charCodeAt(j)) >>> 0;
        }
        return h.toString(16);
    }

    function charCount(entries) {
        var total = 0;
        for (var i = 0; i < entries.length; i++) {
            total += String(entries[i].key || '').length + String(entries[i].value || '').length;
        }
        return total;
    }

    function readMemory() {
        var raw = null;
        try {
            raw = window.localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            return { entries: [], updatedAt: 0 };
        }
        if (!raw) return { entries: [], updatedAt: 0 };
        try {
            var parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.entries)) return { entries: [], updatedAt: 0 };
            var entries = [];
            for (var i = 0; i < parsed.entries.length; i++) {
                var one = parsed.entries[i] || {};
                if (!one.key) continue;
                entries.push({
                    key: String(one.key),
                    value: String(one.value == null ? '' : one.value),
                    source: one.source === 'me' ? 'me' : 'ai',
                    updatedAt: Number(one.updatedAt) || 0
                });
            }
            return { entries: entries, updatedAt: Number(parsed.updatedAt) || 0 };
        } catch (e) {
            // 存储坏了就当空的，不静默改写读者的东西
            return { entries: [], updatedAt: 0 };
        }
    }

    function writeMemory(memory) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
            return true;
        } catch (e) {
            return false;
        }
    }

    /* 写入前留底：撤销上一次改动就靠这一格，只留一版 */
    function snapshot() {
        var current = readMemory();
        try {
            window.localStorage.setItem(PREV_KEY, JSON.stringify(current));
        } catch (e) {
            /* 存不下就没有可撤销的一版，不影响本次写入 */
        }
    }

    /* 撤销上一次改动：把留底写回去，留底清掉（只有一版可退） */
    function undo() {
        var raw = null;
        try {
            raw = window.localStorage.getItem(PREV_KEY);
        } catch (e) {
            return { ok: false, reason: 'unavailable' };
        }
        if (!raw) return { ok: false, reason: 'no-previous' };
        var prev = null;
        try {
            prev = JSON.parse(raw);
        } catch (e) {
            prev = null;
        }
        if (!prev || !Array.isArray(prev.entries)) return { ok: false, reason: 'no-previous' };
        var memory = {
            entries: prev.entries.map(function (one) {
                return {
                    key: String(one.key || ''),
                    value: String(one.value == null ? '' : one.value),
                    source: one.source === 'me' ? 'me' : 'ai',
                    updatedAt: Number(one.updatedAt) || 0
                };
            }).filter(function (one) { return one.key; }),
            updatedAt: Number(prev.updatedAt) || 0
        };
        var ok = writeMemory(memory);
        try {
            window.localStorage.removeItem(PREV_KEY);
        } catch (e) {
            /* 清不掉留底就下次再说 */
        }
        return { ok: ok, changed: true, chars: charCount(memory.entries), memory: memory };
    }

    /* 全部忘掉 */
    function clearAll() {
        snapshot();
        var memory = { entries: [], updatedAt: Date.now() };
        writeMemory(memory);
        return { ok: true, changed: true, chars: 0, memory: memory };
    }

    function sensitiveHits(text) {
        var value = String(text == null ? '' : text);
        var hits = [];
        for (var i = 0; i < SENSITIVE_RULES.length; i++) {
            if (SENSITIVE_RULES[i].re.test(value)) hits.push(SENSITIVE_RULES[i].category);
        }
        return hits;
    }

    /* ------------------------------------------------------------ 写入 */

    /*
     * 写入画像。
     *
     * 拒绝而非截断：超限时整体不写，让模型自己压缩后重写；
     * 敏感命中整体不写；访客手改过的条目（source = 'me'）跳过并在结果里说明。
     */
    function apply(entries, options) {
        var opts = options || {};
        var source = opts.source === 'me' ? 'me' : 'ai';
        var list = Array.isArray(entries) ? entries : [];
        var current = readMemory();
        var currentChars = charCount(current.entries);

        if (!list.length) {
            return { ok: false, reason: 'empty', chars: currentChars, memory: current };
        }

        var hits = [];
        for (var i = 0; i < list.length; i++) {
            var one = list[i] || {};
            var key = normalizeText(one.key);
            if (!key) continue;
            var cats = sensitiveHits(key + ' ' + String(one.value == null ? '' : one.value));
            if (cats.length) hits.push({ key: key, categories: cats });
        }
        if (hits.length) {
            return {
                ok: false,
                reason: 'sensitive',
                hits: hits,
                chars: currentChars,
                memory: current
            };
        }

        var next = current.entries.slice();
        var written = [];
        var skipped = [];
        for (var j = 0; j < list.length; j++) {
            var item = list[j] || {};
            var k = normalizeText(item.key);
            if (!k) continue;
            var v = String(item.value == null ? '' : item.value).trim();
            var at = -1;
            for (var m = 0; m < next.length; m++) {
                if (next[m].key === k) { at = m; break; }
            }
            // 访客手改过的条目受保护：AI 写入跳过，并说明跳过了哪几条
            if (at >= 0 && next[at].source === 'me' && source !== 'me') {
                skipped.push(k);
                continue;
            }
            var entry = { key: k, value: v, source: source, updatedAt: Date.now() };
            if (at >= 0) next[at] = entry;
            else next.push(entry);
            written.push(k);
        }

        var projected = charCount(next);
        if (projected > MAX_CHARS) {
            return {
                ok: false,
                reason: 'over-limit',
                chars: currentChars,
                projected: projected,
                limit: MAX_CHARS,
                memory: current,
                // 超限要把现有条目一并回给模型：它得知道压缩哪几条，不能盲写
                entries: current.entries
            };
        }

        var changed = hashOf(next) !== hashOf(current.entries);
        var memory = { entries: next, updatedAt: Date.now() };
        if (changed) {
            snapshot();
            writeMemory(memory);
        }
        return {
            ok: true,
            changed: changed,
            chars: projected,
            written: written,
            skipped: skipped,
            memory: memory
        };
    }

    /* 删一条（访客手动删；模型没有删除工具） */
    function remove(key) {
        var current = readMemory();
        var target = normalizeText(key);
        var next = current.entries.filter(function (one) { return one.key !== target; });
        if (next.length === current.entries.length) {
            return { ok: false, reason: 'not-found', chars: charCount(current.entries), memory: current };
        }
        var memory = { entries: next, updatedAt: Date.now() };
        snapshot();
        writeMemory(memory);
        return { ok: true, changed: true, chars: charCount(next), memory: memory };
    }

    /*
     * 事务式保存整份画像草稿（设置页整体替换）：
     * 改动任何东西之前先拍一次快照，之后写入不再覆盖它，撤销才能回到改动前那版；
     * 逐条对比：只有键或值真的变了的条目才标成访客手改，没动过的保留原来源。
     */
    function applyDraft(entries) {
        snapshot();
        var list = Array.isArray(entries) ? entries : [];
        var current = readMemory().entries;
        var byKey = {};
        for (var i = 0; i < current.length; i++) byKey[current[i].key] = current[i];
        var next = [];
        var changed = [];
        var removed = [];
        var seen = {};
        for (var j = 0; j < list.length; j++) {
            var one = list[j] || {};
            var key = normalizeText(one.key);
            if (!key) continue;
            seen[key] = true;
            var before = byKey[key];
            var value = String(one.value == null ? '' : one.value).trim();
            // 只有键或值真的变了的才算访客手改；没动过的保留原来源，
            // 新加的行算访客写的
            var touched = !before || normalizeText(before.value) !== value;
            next.push({
                key: key,
                value: value,
                source: touched ? 'me' : before.source,
                updatedAt: Date.now()
            });
            if (touched) changed.push(key);
        }
        for (var k = 0; k < current.length; k++) {
            if (!seen[current[k].key]) removed.push(current[k].key);
        }
        var memory = { entries: next, updatedAt: Date.now() };
        writeMemory(memory);
        return {
            ok: true,
            changed: changed.length > 0 || removed.length > 0,
            changedKeys: changed,
            removed: removed,
            chars: charCount(next),
            memory: memory
        };
    }

    /* ------------------------------------------------------------ 注入 */

    function buildSegment(entries) {
        if (!entries.length) return '';
        var lines = [SEGMENT_HEAD, SEGMENT_NOTE];
        for (var i = 0; i < entries.length; i++) {
            lines.push('- ' + entries[i].key + ': ' + entries[i].value);
        }
        lines.push(SEGMENT_END);
        return lines.join('\n') + '\n\n';
    }

    function sessionState(sessionId) {
        var key = String(sessionId || '');
        if (!sessions[key]) sessions[key] = { hash: '', present: false };
        return sessions[key];
    }

    function textOf(message) {
        var content = message && message.content;
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        for (var i = 0; i < content.length; i++) {
            var part = content[i] || {};
            if (part.type === 'text') return String(part.text || '');
        }
        return '';
    }

    /* 历史里还有没有画像段（压缩、回退、刷新重建都会把它弄掉） */
    function historyHasSegment(messages) {
        if (!Array.isArray(messages)) return false;
        for (var i = 0; i < messages.length; i++) {
            if (textOf(messages[i]).indexOf(SEGMENT_HEAD) === 0) return true;
        }
        return false;
    }

    /*
     * 这一轮要不要带画像段：画像为空不带；内容变了、或历史里已经没有那一段（刷新重建、
     * 压缩丢掉那一轮、回退撤掉那一轮）时带；其余不带——重复注入只是浪费上下文。
     */
    function decision(sessionId, messages) {
        var memory = readMemory();
        if (!memory.entries.length) return { inject: false, segment: '', hash: '' };
        var hash = hashOf(memory.entries);
        if (historyHasSegment(messages) && stHash(sessionId) === hash) {
            return { inject: false, segment: '', hash: hash };
        }
        return { inject: true, segment: buildSegment(memory.entries), hash: hash };
    }

    function stHash(sessionId) {
        return sessionState(sessionId).hash;
    }

    function markInjected(sessionId, hash) {
        var st = sessionState(sessionId);
        st.present = true;
        st.hash = String(hash || hashOf(readMemory().entries));
    }

    /* 剥掉画像段：回退按内容匹配时必须先剥，否则匹配不上读者自己的那句话 */
    function strip(text) {
        var value = String(text == null ? '' : text);
        if (value.indexOf(SEGMENT_HEAD) !== 0) return value;
        var blank = value.indexOf('\n\n');
        if (blank === -1) return '';
        return value.slice(blank + 2);
    }
    /*
     * 跨标签页：别的页改了画像，本页重读并通知 UI 重画（不重触发注入判定，
     * 注入只看本轮发送时的历史与哈希）。
     */
    var changeListeners = [];
    if (window.addEventListener) {
        window.addEventListener('storage', function (event) {
            if (event.key !== STORAGE_KEY && event.key !== null) return;
            sessions = {};
            for (var i = 0; i < changeListeners.length; i++) {
                try {
                    changeListeners[i](readMemory());
                } catch (e) {
                    /* 单个监听者画错不该拖垮画像 */
                }
            }
        });
    }

     AI.memory = {
         limit: MAX_CHARS,
         segmentHead: SEGMENT_HEAD,
         segmentNote: SEGMENT_NOTE,
         get: readMemory,
         entries: function () { return readMemory().entries; },
         chars: function () { return charCount(readMemory().entries); },
         /* 草稿用完再落盘：设置页与主流程都按同一个口径算字数 */
         countOf: charCount,
         hash: function () { return hashOf(readMemory().entries); },
         sensitiveHits: sensitiveHits,
         apply: apply,
         applyDraft: applyDraft,
         remove: remove,
         undo: undo,
         clear: clearAll,
         segment: function () { return buildSegment(readMemory().entries); },
         decision: decision,
         markInjected: markInjected,
         historyHasSegment: historyHasSegment,
         strip: strip,
         subscribe: function (fn) {
             if (typeof fn !== 'function') return function () {};
             changeListeners.push(fn);
             return function () {
                 var at = changeListeners.indexOf(fn);
                 if (at !== -1) changeListeners.splice(at, 1);
             };
         }
    };
})();
