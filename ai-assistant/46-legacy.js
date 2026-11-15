/*
 * 旧独立计时页一次性迁移（Issue #66）
 *
 * 首次加载助手时，把旧页裸键 `tasks` / `todos` 搬进 `ai-assistant.tasks`，
 * 搬完删旧键。只迁一次（标记键 `ai-assistant.legacy-imported`）。
 * JSON 损坏时保留旧键不动，不静默丢数据；不读旧计时状态 `currentTaskId`。
 */
(function () {
    'use strict';

    function parseDate(value) {
        if (typeof value === 'number' && isFinite(value)) return value;
        var t = Date.parse(value);
        return isFinite(t) ? t : Date.now();
    }

    /* 标识生成借用清单模块的导出：slugify 与日期戳各只有一份实现 */
    function slugify(title) {
        var AI = window.AIAssistant;
        if (AI && AI.tasks && AI.tasks.slugify) return AI.tasks.slugify(title);
        return 'item';
    }

    function stamp(ts) {
        var AI = window.AIAssistant;
        if (AI && AI.tasks && AI.tasks.yyyymmdd) return AI.tasks.yyyymmdd(ts);
        return String(ts);
    }

    function migrate() {
        var AI = window.AIAssistant;
        if (!AI || !AI.tasks) return;
        var ls = null;
        try { ls = window.localStorage; } catch (e) { return; }
        if (!ls) return;

        var MARKER = 'ai-assistant.legacy-imported';
        try {
            if (ls.getItem(MARKER)) return;
        } catch (e) { return; }

        var tasksRaw = null;
        var todosRaw = null;
        try { tasksRaw = ls.getItem('tasks'); } catch (e) {}
        try { todosRaw = ls.getItem('todos'); } catch (e) {}

        if (!tasksRaw && !todosRaw) {
            try { ls.setItem(MARKER, '1'); } catch (e) {}
            return;
        }

        var importItems = [];
        var tasksParsed = false;
        var todosParsed = false;

        if (tasksRaw) {
            try {
                var tasksArr = JSON.parse(tasksRaw);
                if (Array.isArray(tasksArr)) {
                    for (var i = 0; i < tasksArr.length; i++) {
                        var t = tasksArr[i] || {};
                        var createdAt = parseDate(t.createdAt);
                        var totalSeconds = Number(t.totalSeconds) || 0;
                        var remainingTime = Number(t.remainingTime) || 0;
                        importItems.push({
                            id: 'task_' + slugify(t.name) + '_' + stamp(createdAt),
                            kind: 'task',
                            title: String(t.name || '').trim() || '未命名任务',
                            durationMs: totalSeconds * 1000,
                            accumulatedMs: Math.max(0, totalSeconds - remainingTime) * 1000,
                            status: t.completed ? 'done' : 'todo',
                            source: 'me',
                            createdAt: createdAt
                        });
                    }
                    tasksParsed = true;
                }
            } catch (e) {
                /* 坏 JSON：保留旧键不动 */
            }
        }

        if (todosRaw) {
            try {
                var todosArr = JSON.parse(todosRaw);
                if (Array.isArray(todosArr)) {
                    for (var j = 0; j < todosArr.length; j++) {
                        var td = todosArr[j] || {};
                        var cAt = parseDate(td.createdAt);
                        importItems.push({
                            id: 'todo_' + stamp(cAt) + '_' + (j + 1),
                            kind: 'todo',
                            title: String(td.content || '').trim() || '未命名待办',
                            status: td.completed ? 'done' : 'todo',
                            source: 'me',
                            createdAt: cAt
                        });
                    }
                    todosParsed = true;
                }
            } catch (e) {
                /* 坏 JSON：保留旧键不动 */
            }
        }

        /*
         * 先写新表、成功后再删旧键：写失败就保留旧键、不置标记，
         * 下次加载还能再迁一次，不会把读者的数据弄丢。
         */
        var imported = true;
        if (importItems.length) {
            try {
                AI.tasks.importMany(importItems);
            } catch (e) {
                imported = false;
            }
        }

        if (!(tasksParsed && todosParsed && imported)) return;
        if (tasksRaw) {
            try { ls.removeItem('tasks'); } catch (e) { imported = false; }
        }
        if (todosRaw) {
            try { ls.removeItem('todos'); } catch (e) { imported = false; }
        }
        if (imported) {
            try { ls.setItem(MARKER, '1'); } catch (e) {}
        }
    }

    /* 47-tasks.js 在 46 之后加载，延后到所有脚本就绪 */
    setTimeout(migrate, 0);
})();
