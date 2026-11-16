/*
 * 清单：任务与待办是同一张表，用 kind 区分。
 *
 * 形状：
 *   { id, kind: 'task'|'todo', title, url?, categories?, durationMs?,
 *     accumulatedMs, status: 'todo'|'running'|'done'|'pending',
 *     source: 'ai'|'me', createdAt }
 * 待办（kind='todo'）不带链接与分类。
 *
 * 状态流转：待确认 → 待办 → 计时中 → 已完成，可回退。
 *   pending → todo → running → done，每一步都能退回上一档。
 *
 * 没有删除能力给模型：工具面只给「列出 / 批量添加 / 标记完成」。
 * 面板里访客可以删自己写的条目（不可撤销），AI 排的条目不提供删除。
 *
 * 存储键 ai-assistant.tasks。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var STORAGE_KEY = 'ai-assistant.tasks';
    /* 层级上限：4 层。再深在窄面板里缩进吃掉正文宽度 */
    var MAX_DEPTH = 4;

    var items = [];
    var subscribers = [];

    /* 允许的状态迁移：向后一档可进，向前可回 */
    var ALLOWED = {
        pending: ['todo', 'done'],
        todo: ['pending', 'running', 'done'],
        running: ['todo', 'done'],
        done: ['running', 'todo']
    };

    /* ------------------------------------------------------------ 基础 */

    function yyyymmdd(ts) {
        var d = new Date(ts === undefined ? Date.now() : ts);
        var m = String(d.getMonth() + 1);
        var day = String(d.getDate());
        if (m.length < 2) m = '0' + m;
        if (day.length < 2) day = '0' + day;
        return String(d.getFullYear()) + m + day;
    }

    /* 标题转标识片段：中文与字母数字留下，其余换成短横 */
    function slugify(title) {
        var raw = String(title || '').trim().toLowerCase();
        var slug = raw.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) slug = 'item';
        if (slug.length > 12) slug = slug.slice(0, 12);
        return slug;
    }

    function now() {
        return Date.now();
    }

    /* ------------------------------------------------------------ 存储 */

    function normalize(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var title = String(raw.title || '').trim();
        if (!title) return null;
        var kind = raw.kind === 'todo' ? 'todo' : 'task';
        var status = ['pending', 'todo', 'running', 'done'].indexOf(raw.status) >= 0 ? raw.status : 'todo';
        var item = {
            id: typeof raw.id === 'string' && raw.id ? raw.id : '',
            kind: kind,
            title: title,
            accumulatedMs: typeof raw.accumulatedMs === 'number' && isFinite(raw.accumulatedMs) && raw.accumulatedMs > 0
                ? Math.floor(raw.accumulatedMs)
                : 0,
            status: status,
            source: raw.source === 'ai' ? 'ai' : 'me',
            createdAt: typeof raw.createdAt === 'number' && isFinite(raw.createdAt) ? raw.createdAt : now()
        };
        /* 待办不带链接与分类 */
        if (kind === 'task') {
            if (typeof raw.url === 'string' && raw.url) item.url = raw.url;
            if (Array.isArray(raw.categories)) item.categories = raw.categories.slice();
            if (typeof raw.durationMs === 'number' && isFinite(raw.durationMs) && raw.durationMs > 0) {
                item.durationMs = Math.floor(raw.durationMs);
            }
        }
        /* 层级：parentId 指向同表的另一条；指向不存在的条目按根处理，深度上限 3 层 */
        if (typeof raw.parentId === 'string' && raw.parentId) item.parentId = raw.parentId;
        /* 层级：parentId 指向同表另一条；断链与超深的条目按根处理 */
        if (typeof raw.parentId === 'string' && raw.parentId) item.parentId = raw.parentId;
        if (!item.id) item.id = makeId(item);
        return item;
    }

    function readStorage() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            var parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            var list = [];
            for (var i = 0; i < parsed.length; i++) {
                var item = normalize(parsed[i]);
                if (item) list.push(item);
            }
            return list;
        } catch (e) {
            /* 存储不可用或 JSON 坏掉：按空清单处理，不抛给页面 */
            return [];
        }
    }

    /*
     * 落盘。配额满时先砍已完成的条目再试一次——清单参与退让时先砍做完了的，
     * 未完成的不能丢；还装不下就留在内存里继续用（画像不参与任何退让）。
     */
    function writeStorage() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
            return true;
        } catch (e) {
            var kept = items.filter(function (one) { return one.status !== 'done'; });
            if (kept.length === items.length) return false;
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
                return true;
            } catch (e2) {
                /* 隐私模式或还是装不下：清单继续留在内存里 */
                return false;
            }
        }
    }

    /* ------------------------------------------------------------ 标识 */

    function idTaken(id) {
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) return true;
        }
        return false;
    }

    function makeId(item) {
        var stamp = yyyymmdd(item.createdAt);
        var base;
        if (item.kind === 'todo') {
            /* 待办按当天序号排：todo_<yyyymmdd>_<序号> */
            var seq = 1;
            base = 'todo_' + stamp + '_' + seq;
            while (idTaken(base)) {
                seq += 1;
                base = 'todo_' + stamp + '_' + seq;
            }
            return base;
        }
        /* 任务按标题片段：task_<slug>_<yyyymmdd> */
        base = 'task_' + slugify(item.title) + '_' + stamp;
        var suffix = 2;
        while (idTaken(base)) {
            base = 'task_' + slugify(item.title) + '_' + stamp + '-' + suffix;
            suffix += 1;
        }
        return base;
    }

    /* ------------------------------------------------------------ 读写 */

    function sortList(list) {
        var rank = { pending: 0, running: 1, todo: 2, done: 3 };
        return list.slice().sort(function (a, b) {
            var ra = rank[a.status] === undefined ? 9 : rank[a.status];
            var rb = rank[b.status] === undefined ? 9 : rank[b.status];
            if (ra !== rb) return ra - rb;
            return b.createdAt - a.createdAt;
        });
    }

    function list(filter) {
        var f = filter || {};
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (f.kind && item.kind !== f.kind) continue;
            if (f.status && item.status !== f.status) continue;
            if (f.source && item.source !== f.source) continue;
            out.push(item);
        }
        return sortList(out);
    }

    function get(id) {
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) return items[i];
        }
        return null;
    }

    function emit() {
        for (var i = 0; i < subscribers.length; i++) {
            try {
                subscribers[i](list());
            } catch (e) {
                /* 单个订阅者画错不该拖垮清单 */
            }
        }
    }

    function commit() {
        writeStorage();
        emit();
    }

    /*
     * 批量导入：迁移专用，不做状态限制、不重生成 id（id 已由调用方给定）。
     * 仅导入合法条目，失败静默。
     */
    function importMany(rawItems) {
        var input = Array.isArray(rawItems) ? rawItems : [];
        for (var i = 0; i < input.length; i++) {
            var row = input[i] || {};
            var item = normalize({
                id: row.id,
                kind: row.kind === 'todo' ? 'todo' : 'task',
                title: row.title,
                url: row.url,
                categories: row.categories,
                durationMs: row.durationMs,
                accumulatedMs: row.accumulatedMs,
                status: row.status,
                source: row.source,
                createdAt: row.createdAt === undefined ? now() : row.createdAt
            });
            if (!item) continue;
            if (!item.id) item.id = makeId(item);
            items.push(item);
        }
        commit();
        return items.length;
    }

    /*
     * 添加一条。kind 缺省按「待办」处理，source 缺省按「我写的」处理；
     * AI 加的条目默认落「待确认」，访客点头才转成待办。
     */
    function add(raw) {
        var input = raw || {};
        /*
         * AI 加的条目默认落「待确认」：模型只给建议，访客点头（点建议卡的
         * 「全部加入」、或工具调用时显式给状态）才转成待办；访客自己写的默认待办。
         */
        var source = input.source === 'ai' ? 'ai' : 'me';
        var status = ['pending', 'todo', 'running', 'done'].indexOf(input.status) >= 0
            ? input.status
            : (source === 'ai' ? 'pending' : 'todo');
        var item = normalize({
            kind: input.kind === 'task' ? 'task' : 'todo',
            title: input.title,
            url: input.url,
            categories: input.categories,
            durationMs: input.durationMs,
            accumulatedMs: input.accumulatedMs,
            status: status,
            source: source,
            parentId: typeof input.parentId === 'string' ? input.parentId : '',
            createdAt: input.createdAt === undefined ? now() : input.createdAt
        });
        if (!item) return null;
        /* 层级上限 3 层：父条目不存在、或父已在第 3 层，就把这条放到根上 */
        if (item.parentId) {
            var hasParent = false;
            for (var q = 0; q < items.length; q++) {
                if (items[q].id === item.parentId) { hasParent = true; break; }
            }
            /* 第 4 层以下挂不上去：再深在窄面板里读不动，应拆成并列的父条目 */
            if (!hasParent || depthOf(item.parentId) >= MAX_DEPTH) delete item.parentId;
        }
        item.id = makeId(item);
        items.push(item);
        commit();
        return item;
    }

    /* 一条在哪一层：根为 1。断链按 1 算，避免坏数据把渲染拖进死循环 */
    function depthOf(id) {
        var depth = 1;
        var cursor = id;
        var guard = 0;
        while (cursor && guard < 10) {
            var parent = null;
            for (var i = 0; i < items.length; i++) {
                if (items[i].id === cursor) { parent = items[i]; break; }
            }
            if (!parent || !parent.parentId) break;
            cursor = parent.parentId;
            depth += 1;
            guard += 1;
        }
        return depth;
    }

    /* 子条目（按创建时间正序）：树形渲染与「加一步」都用它 */
    function childrenOf(id) {
        var out = [];
        for (var i = 0; i < items.length; i++) {
            if ((items[i].parentId || '') !== (id || '')) continue;
            out.push(items[i]);
        }
        out.sort(function (a, b) {
            if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
            return a.id < b.id ? -1 : 1;
        });
        return out;
    }

    /* 批量添加：逐条独立成功，一条不合格不影响别的 */
    function addMany(rawItems, source) {
        var out = [];
        var ids = [];
        var input = Array.isArray(rawItems) ? rawItems : [];
        for (var i = 0; i < input.length; i++) {
            var row = input[i] || {};
            var item = add({
                /* 工具加的默认是阅读任务（kind 默认 task），显式给 todo 才是待办 */
                kind: row.kind === 'todo' ? 'todo' : 'task',
                title: row.title,
                url: row.url,
                categories: row.categories,
                durationMs: row.durationMs,
                parentId: row.parentId,
                status: row.status,
                source: source || row.source
            });
            if (item) {
                out.push(item);
                ids.push(item.id);
            }
        }
        return { added: out.length, ids: ids };
    }

    function setStatus(id, status) {
        var item = get(id);
        if (!item) return null;
        if (item.status === status) return item;
        var allowed = ALLOWED[item.status] || [];
        if (allowed.indexOf(status) < 0) return null;
        item.status = status;
        commit();
        return item;
    }

    /* 标记完成 / 撤销完成：done 可回到 todo；标完成时若正在计时先把时长折进条目 */
    function complete(id, done) {
        var item = get(id);
        if (!item) return null;
        if (done && runningId === id) endTiming(id);
        /* 撤销只对已完成有意义：没完成的条目传 false 是空操作，不推进状态 */
        if (!done && item.status !== 'done') return item;
        if (item.status === 'done' && !done) {
            item.status = 'todo';
            commit();
            return item;
        }
        return setStatus(id, 'done');
    }

    /* ------------------------------------------------------------ 计时 */

    /* 计时真相在 55-timer.js；这里只记「哪一条在计时」与已跑时长 */
    var runningSince = {};
    var runningId = null;

    function beginTiming(id) {
        var item = get(id);
        if (!item) return null;
        if (item.status === 'done') return null;
        if (runningId && runningId !== id) endTiming(runningId);
        runningId = id;
        runningSince[id] = now();
        if (item.status !== 'running') return setStatus(id, 'running');
        return item;
    }

    /*
     * 再来一轮：条目从「已完成」退回「计时中」。
     * 与 beginTiming 分开：beginTiming 不碰已完成的条目（那是「开始一个新计时」的语义），
     * 到点后的重开需要把已完成的条目拉回进行中。
     */
    function resumeTiming(id) {
        var item = get(id);
        if (!item) return null;
        if (item.status !== 'done') return beginTiming(id);
        if (runningId && runningId !== id) endTiming(runningId);
        runningId = id;
        runningSince[id] = now();
        return setStatus(id, 'running');
    }

    /*
     * 到点：一次落盘把「已跑时长折进条目 + 状态转已完成」做完。
     * 可重入：条目已是「已完成」就什么都不写——两个标签页同时到点时只流转一次。
     */
    function finishTiming(id, roundMs) {
        var item = get(id);
        if (!item) return null;
        /*
         * 别的标签页可能已经流转过了：按落盘的那份为准，别重复写。
         * 这是跨标签幂等的落点——两个标签页同时到点时只有一个真正写入。
         */
        var stored = readStorage();
        for (var s = 0; s < stored.length; s++) {
            if (stored[s].id !== id) continue;
            if (stored[s].status === 'done') {
                item.status = 'done';
                item.accumulatedMs = stored[s].accumulatedMs;
                delete runningSince[id];
                if (runningId === id) runningId = null;
                return item;
            }
        }
        if (item.status === 'done') {
            /* 已经流转过了：只收掉计时起点，不重复写 */
            delete runningSince[id];
            if (runningId === id) runningId = null;
            return item;
        }
        /*
         * 折进条目只做增量，不覆盖：同一条目会跑很多轮，覆盖会把之前几轮的时长抹掉。
         * 有计时起点就按起点折算（与 endTiming 同一条规则）；起点丢了（换标签页、
         * 刷新）才退回计时器手里的这一轮时长。
         */
        var since = runningSince[id];
        if (since) {
            var delta = now() - since;
            if (delta > 0) item.accumulatedMs = (item.accumulatedMs || 0) + delta;
        } else if (typeof roundMs === 'number' && isFinite(roundMs) && roundMs > 0) {
            item.accumulatedMs = (item.accumulatedMs || 0) + Math.floor(roundMs);
        }
        delete runningSince[id];
        if (runningId === id) runningId = null;
        /* 状态流转走 setStatus：迁移合法性由它把关，落盘也只一次 */
        return setStatus(id, 'done');
    }

    function endTiming(id) {
        var item = get(id);
        if (!item) return null;
        var since = runningSince[id];
        if (since) {
            var delta = now() - since;
            if (delta > 0) item.accumulatedMs += delta;
            delete runningSince[id];
        }
        if (runningId === id) runningId = null;
        if (item.status === 'running') return setStatus(id, 'todo');
        return item;
    }

    function elapsedOf(item, at) {
        if (!item) return 0;
        var base = item.accumulatedMs || 0;
        var since = runningSince[item.id];
        if (!since) return base;
        var current = at === undefined ? now() : at;
        var delta = current - since;
        return base + (delta > 0 ? delta : 0);
    }

    /*
     * 刷新或跨标签页后内存里的计时起点就丢了：按全局计时器的 taskId + startedAt
     * 重建「哪条在计时、何时开始的」，不新增存储字段。
     */
    function reconcileRunning() {
        runningSince = {};
        runningId = null;
        if (!AI.timer || typeof AI.timer.getState !== 'function') return;
        var snap = AI.timer.getState();
        if (!snap || !snap.startedAt || !snap.taskId) return;
        var item = get(snap.taskId);
        if (!item || item.status === 'done') return;
        runningId = snap.taskId;
        runningSince[snap.taskId] = snap.startedAt;
        if (item.status !== 'running') item.status = 'running';
    }

    /* ------------------------------------------------------------ 删除 */

    /*
     * 删除只在面板里用；模型没有对应工具。
     * 访客对任何状态都能删（提案另有「不要」），不区分 AI 排的还是自己写的——
     * 同一条清单里操作不一致，访客得先记住每条是谁写的。子条目跟着一起走。
     */
    function remove(id) {
        var target = null;
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) { target = items[i]; break; }
        }
        if (!target) return null;

        // 连带子条目一起删：从目标开始按 parentId 逐层收集
        var doomed = [id];
        var grew = true;
        while (grew) {
            grew = false;
            for (var j = 0; j < items.length; j++) {
                if (doomed.indexOf(items[j].id) >= 0) continue;
                if (doomed.indexOf(items[j].parentId) < 0) continue;
                doomed.push(items[j].id);
                grew = true;
            }
        }
        items = items.filter(function (one) { return doomed.indexOf(one.id) < 0; });
        for (var d = 0; d < doomed.length; d++) delete runningSince[doomed[d]];
        if (runningId && doomed.indexOf(runningId) >= 0) runningId = null;
        commit();
        return true;
    }

    /* ------------------------------------------------------------ 订阅 */

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        subscribers.push(fn);
        return function () {
            for (var i = 0; i < subscribers.length; i++) {
                if (subscribers[i] === fn) {
                    subscribers.splice(i, 1);
                    return;
                }
            }
        };
    }

    // 跨标签页：清单是全量列表，读到新值直接换掉
    if (window.addEventListener) {
        window.addEventListener('storage', function (event) {
            if (event.key !== STORAGE_KEY && event.key !== null) return;
            items = readStorage();
            emit();
        });
    }

    items = readStorage();
    // 55-timer.js 在本文件之后加载，计时状态那时才就绪，恢复后再重建计时起点
    setTimeout(reconcileRunning, 0);

    AI.tasks = {
        STORAGE_KEY: STORAGE_KEY,
        list: list,
        get: get,
        add: add,
        importMany: importMany,
        addMany: addMany,
        setStatus: setStatus,
        complete: complete,
        beginTiming: beginTiming,
        resumeTiming: resumeTiming,
        finishTiming: finishTiming,
        endTiming: endTiming,
        elapsedOf: elapsedOf,
        remove: remove,
        childrenOf: childrenOf,
        depthOf: depthOf,
        subscribe: subscribe,
        makeId: makeId,
        slugify: slugify,
        yyyymmdd: yyyymmdd
    };
})();
