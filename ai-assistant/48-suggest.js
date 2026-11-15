/*
 * AI 建议卡：先建议后落盘。
 *
 * 内容取自构建期产物 public/ai-assistant/reading-list.json，0 次模型往返。
 * 卡片以「待确认」态呈现，带「全部加入」与「跳过」；落盘调 AI.tasks.addMany。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var READING_LIST_URL = '/ai-assistant/reading-list.json';
    var cache = null;
    var loading = null;

    function load() {
        if (cache) return Promise.resolve(cache);
        if (loading) return loading;
        loading = fetch(READING_LIST_URL, { credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('阅读清单加载失败：HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                cache = data;
                loading = null;
                return data;
            })
            .catch(function (err) {
                loading = null;
                throw err;
            });
        return loading;
    }

    /*
     * 预估时长：按分类给保守估计（毫秒）。没有可靠数据就给 5 分钟，
     * 不编造精确数字。
     */
    function estimate(item) {
        var cats = (item && item.categories) || [];
        var text = cats.join(' ').toLowerCase();
        var ms = 5 * 60 * 1000;
        if (/软件测试|测试/.test(text)) ms = 8 * 60 * 1000;
        if (/面试八股|Java|并发|Redis|MySQL|网络/.test(text)) ms = 10 * 60 * 1000;
        if (/速通|教程/.test(text)) ms = 12 * 60 * 1000;
        return ms;
    }

    function showCard(items) {
        if (!AI.ui || !AI.ui.refs || !AI.ui.refs.stream) return null;
        var card = document.createElement('div');
        card.className = 'ai-suggest';
        card.dataset.status = 'pending';

        var head = document.createElement('p');
        head.className = 'ai-suggest-title';
        head.textContent = '阅读建议（待确认）';
        card.appendChild(head);

        var list = document.createElement('ul');
        list.className = 'ai-suggest-list';
        (items || []).forEach(function (it) {
            var li = document.createElement('li');
            li.className = 'ai-suggest-item';
            var a = document.createElement('a');
            a.className = 'ai-suggest-link';
            a.href = it.url;
            a.textContent = it.title;
            li.appendChild(a);
            var meta = document.createElement('span');
            meta.className = 'ai-suggest-meta';
            var cats = (it.categories || []).join(' / ');
            var mins = Math.round((it.durationMs || 0) / 60000);
            meta.textContent = (cats ? cats + ' · ' : '') + (mins > 0 ? mins + ' 分钟' : '');
            li.appendChild(meta);
            list.appendChild(li);
        });
        card.appendChild(list);

        var acts = document.createElement('div');
        acts.className = 'ai-suggest-acts';
        var joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'ai-btn ai-btn-primary';
        joinBtn.dataset.act = 'suggest-join';
        joinBtn.textContent = '全部加入';
        var skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'ai-btn';
        skipBtn.dataset.act = 'suggest-skip';
        skipBtn.textContent = '跳过';
        acts.appendChild(joinBtn);
        acts.appendChild(skipBtn);
        card.appendChild(acts);

        joinBtn.addEventListener('click', function () {
            if (card.dataset.status !== 'pending') return;
            var payload = (items || []).map(function (it) {
                return {
                    title: it.title,
                    url: it.url,
                    categories: it.categories || [],
                    durationMs: it.durationMs,
                    kind: 'task',
                    source: 'ai',
                    // 访客点头加入：直接落成待办，不走默认的待确认
                    status: 'todo'
                };
            });
            if (AI.tasks && typeof AI.tasks.addMany === 'function') {
                AI.tasks.addMany(payload, 'ai');
            }
            card.dataset.status = 'done';
            card.classList.add('is-joined');
            joinBtn.disabled = true;
            skipBtn.disabled = true;
        });

        skipBtn.addEventListener('click', function () {
            if (card.dataset.status !== 'pending') return;
            card.dataset.status = 'skipped';
            card.classList.add('is-skipped');
            joinBtn.disabled = true;
            skipBtn.disabled = true;
        });

        AI.ui.refs.stream.appendChild(card);
        if (typeof AI.ui.scrollToBottom === 'function') AI.ui.scrollToBottom();
        return card;
    }

    AI.suggest = {
        load: load,
        estimate: estimate,
        showCard: showCard
    };
})();
