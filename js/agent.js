(function () {
  'use strict';
  var ROOT = '.hxa-root';
  var STORE_KEY = 'hexo.agent.v1';
  var TOKEN_KEY = 'hexo.token';
  var MARKER = '__hxaInited';
  var _initReady = false;
  var MAX_LOCAL_SESSIONS = 10; // v0.4.3: LRU 上限，缓存最多 10 个会话 metadata
  var ENC = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  // v0.4.3: 去掉 MEM_UPDATE 块，避免预览里出现"<!--MEM_UPDATE-->{...}"原始标记
  function stripMemUpdate(s) { if (!s) return ''; var i = s.indexOf('<!--MEM_UPDATE-->'); return i >= 0 ? s.substring(0, i).trim() : s; }
  var DEF_CFG = { apiBase: '', mode: 'mock', title: 'AI 助手', subtitle: '基于博客知识库，可联网与思考', position: 'right', enableWebsearch: true, enableKnowledge: true };
  function config() { return window.HexoAgentConfig || DEF_CFG; }
  // v0.4.22 抽共用：extractArticleContext 实现移至 agent-common.js（带 sectionAnchor 500 字符截断）
  var extractArticleContext = window.HexoAgentCommon && window.HexoAgentCommon.extractArticleContext
    ? window.HexoAgentCommon.extractArticleContext
    : function () {
        console.warn('[hexo-agent] agent-common.js not loaded — article context unavailable');
        return {};
      };
  function now() { return Date.now(); }
  function uid() { return 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function loadStore() { try { var r = localStorage.getItem(STORE_KEY); if (r) return JSON.parse(r); } catch (_) {} return { sessions: {}, currentSessionId: '', ball: { x: -1, y: -1, snapped: 'right' } }; }
  function saveStore(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (_) {} }

  var st0 = loadStore();
  var c0 = config();
  var pendingRemote = null;
  var state = {
    open: false, streaming: false, abort: null,
    tools: { websearch: c0.enableWebsearch !== false, knowledge: c0.enableKnowledge !== false },
    currentSessionId: st0.currentSessionId || '',
    sessions: st0.sessions || {},
    ball: st0.ball || { x: -1, y: -1, snapped: 'right' }
  };
  // v0.4.5.2: 永不自动创建 s_ 占位——只清 currentSessionId 引用
  if (state.currentSessionId && !state.sessions[state.currentSessionId]) {
    state.currentSessionId = '';
  }
  // v0.4.3: LRU 淘汰超过 MAX_LOCAL_SESSIONS 的旧会话（按 lastActiveAt asc 淘汰最旧）
  function evictOldestSessions() {
    var ids = Object.keys(state.sessions);
    if (ids.length <= MAX_LOCAL_SESSIONS) return;
    var sorted = ids.map(function (k) { return { id: k, t: state.sessions[k].lastActiveAt || 0 }; })
      .sort(function (a, b) { return a.t - b.t; });
    var toRemove = sorted.slice(0, sorted.length - MAX_LOCAL_SESSIONS);
    toRemove.forEach(function (x) { delete state.sessions[x.id]; });
  }
  function persist() { evictOldestSessions(); saveStore({ sessions: state.sessions, currentSessionId: state.currentSessionId, ball: state.ball }); }
  function newSessionObj(id, title) { return { id: id, title: title || '新对话', createdAt: now(), lastActiveAt: now(), archived: false, messages: [] }; }
  function currentSession() { return state.sessions[state.currentSessionId]; }
  function setToolsFromConfig() { var c = config(); state.tools.websearch = c.enableWebsearch !== false; state.tools.knowledge = c.enableKnowledge !== false; }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    if (children) {
      if (!Array.isArray(children)) children = [children];
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }
  function svg(d, size) {
    var s = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="' + (size || 16) + '" height="' + (size || 16) + '">' + d + '</svg>';
    var wrap = document.createElement('span');
    wrap.innerHTML = s;
    return wrap.firstChild;
  }
  var ICO = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    chatPill: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    list: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    // v0.4.25: 右抽屉触发按钮（顶部栏右侧 user icon）
    user: '<circle cx="12" cy="8" r="4" fill="currentColor" stroke="none"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>'
  };
  function I(name) { return svg(ICO[name] || '', 16); }

  function ensureRoot() {
    var r = document.querySelector(ROOT);
    if (r) return r;
    r = el('div', { class: 'hxa-root' });
    document.body.appendChild(r);
    return r;
  }

  function renderBall() {
    var r = ensureRoot(), c = config();
    // v0.4.26.1 hotfix (rev3): 改 var → assignment，使用 module-level 的 ball (line 211)
    // 原 renderBall 内 var ball 是 function-local，导致 click-outside handler 等其他
    // module-scope 的代码 ReferenceError: ball is not defined。
    ball = el('div', { class: 'hxa-ball' + (c.position === 'left' || state.ball.snapped === 'left' ? ' hxa-ball--left' : ''), 'data-variant': 'a2' });
    ball.appendChild(el('span', { class: 'hxa-ball__icon' }, [I('chatPill')]));
    ball.appendChild(el('span', { class: 'hxa-ball__label' }, 'AI 助手'));
    ball.appendChild(el('span', { class: 'hxa-ball__badge' }));
    var x = state.ball.x, y = state.ball.y;
    if (x >= 0) ball.style.left = x + 'px';
    if (y >= 0) ball.style.top = y + 'px';
    if (x < 0) { ball.style.right = c.position === 'left' ? 'auto' : '24px'; ball.style.left = c.position === 'left' ? '24px' : 'auto'; }
    if (y < 0) ball.style.bottom = '24px';
    ball.addEventListener('click', function () { if (!ball.dataset.dragging) open(); });
    bindBallDrag(ball);
    r.appendChild(ball);
    return ball;
  }
  function bindBallDrag(ball) {
    // v0.4.25 PR-3: 在 v0.4.22 + PR-2 既有 bindBallDrag 基础上**增强**视觉降级方案——
    // 不切到 transform 路径（避免破坏 repositionBall / renderBall / state.ball schema），
    // 只叠加：① rAF 节流 ② 拖拽时 box-shadow 加深（GPU 路径）③ 释放弹性回弹。
    // 设计 doc §3.4 + Council P1-5：不用 clip-path（cross-browser + 性能差），
    // 用 transform:scale(.95) → scale(1.05)（拖拽中）→ scale(1)（释放）走 GPU 合成层。
    var sx, sy, ox, oy, moved = false, rafId = null;
    function pt(e) { return e.touches ? e.touches[0] : e; }
    function applyMove(clientX, clientY) {
      var dx = clientX - sx, dy = clientY - sy;
      // v0.4.26.1 hotfix: 拖拽阈值 4→10（原 4px 在人手指/鼠标静止点击时会被 5-9px 微抖误判为
      // drag，导致 onUp 跳过 tap 兜底 open()，用户反馈"只能拖拽"。10px 足以覆盖人手静止
      // 点击的微抖，但仍能识别真实拖动意图）。
      if (Math.abs(dx) + Math.abs(dy) > 10) moved = true;
      ball.style.left = Math.max(4, Math.min(window.innerWidth - 60, ox + dx)) + 'px';
      ball.style.top = Math.max(4, Math.min(window.innerHeight - 60, oy + dy)) + 'px';
      ball.style.right = ball.style.bottom = 'auto';
      ball.classList.remove('hxa-ball--left');
      // PR-3: 拖拽中加深暖橙阴影 + scale(1.05) 暗示"抓握中"，走 transform 路径不影响 left/top
      ball.style.transform = 'scale(1.05)';
      ball.style.boxShadow = '0 16px 48px -8px rgba(255,122,69,.6), 0 4px 12px -4px rgba(15,23,42,.12)';
    }
    function onMove(e) {
      // rAF 节流（Council P1-2）：每帧最多 1 次样式写，避免高频 mousemove 触发 reflow
      if (rafId) return;
      var p = pt(e);
      // v0.4.26.1 hotfix: 删除 v0.4.26 commit 2 引入的 4px 阈值守卫 + 提前 return。
      // 原守卫在 tap 微抖 5-9px 时误判为 drag，跳过 onUp 的 tap 兜底，UI「只能拖拽」。
      // 删除后 onMove 无条件触发 rAF → applyMove，moved 设值完全交给 applyMove 的 10px 阈值。
      // touchmove 上的 preventDefault 不影响 click 合成（W3C Touch Events §4.5.2），
      // 所以可以无条件 preventDefault 阻止页面滚动，配合 cancelable 守卫避免 cancelable=false 警告。
      e.cancelable && e.preventDefault && e.preventDefault();
      rafId = requestAnimationFrame(function () {
        applyMove(p.clientX, p.clientY);
        rafId = null;
      });
    }
    function onUp(e) {
      // 取消 pending rAF 帧（避免抬起后还有一帧延迟样式写）
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      [['mousemove', onMove], ['mouseup', onUp], ['touchmove', onMove], ['touchend', onUp]].forEach(function (p) { document.removeEventListener(p[0], p[1]); });
      var rect = ball.getBoundingClientRect(), snap = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
      var nx = snap === 'left' ? 24 : window.innerWidth - rect.width - 24;
      var ny = Math.max(24, Math.min(window.innerHeight - 80, rect.top));
      // PR-3: 弹性回弹 cubic-bezier(.34, 1.56, .64, 1) 0.4s（overshoot 后回中），同时过渡 transform + box-shadow 复位
      ball.style.transition = 'left .4s cubic-bezier(.34, 1.56, .64, 1), top .4s cubic-bezier(.34, 1.56, .64, 1), transform .3s ease, box-shadow .3s ease';
      ball.style.left = nx + 'px'; ball.style.top = ny + 'px';
      ball.style.right = ball.style.bottom = 'auto';
      // PR-3: 释放后 transform 复位到 scale(1) + boxShadow 清空（继承 .hxa-ball 默认）
      ball.style.transform = '';
      ball.style.boxShadow = '';
      ball.classList.toggle('hxa-ball--left', snap === 'left');
      state.ball = { x: nx, y: ny, snapped: snap };
      persist();
      // v0.4.26.1 hotfix (rev5): 总是立即清 ball.dataset.dragging。
      // 原逻辑 `if (!moved)` 在 PC tap (mousedown→mouseup 纯静止, moved=false) 时正常清掉，
      // 但 mobile tap 即便肉眼静止，iOS Safari / Android Chrome 触屏采样也会产生 10-15px 的微抖，
      // 触发 onMove → applyMove → moved=true → if (!moved) 跳过清空 → dataset 残留 '1'
      // → mobile 合成 click (touchend 后 ~50-300ms) 看到 dataset='1' → click listener 拒绝 open()。
      // 结果：mobile 用户看似「点 ball 没反应」，实际是 click listener 被错误的 drag 状态阻塞。
      // 修复：dataset 立刻清空（不再等 420ms setTimeout）。代价是 drag-end-on-ball 罕见场景下
      // click 会立即 open panel（spec 上 mousedown+mouseup 同元素 click 应 fire，可接受）。
      ball.dataset.dragging = '';
      if (moved) { e.stopPropagation && e.stopPropagation(); }
      setTimeout(function () { ball.style.transition = ''; }, 420);  // 仅清 transition style
    }
    function down(e) {
      var p = pt(e); sx = p.clientX; sy = p.clientY;
      ox = parseInt(ball.style.left, 10) || ball.getBoundingClientRect().left;
      oy = parseInt(ball.style.top, 10) || ball.getBoundingClientRect().top;
      moved = false; ball.dataset.dragging = '1';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
      // v0.4.25 hotfix: 不再调 e.preventDefault()。原因：touchstart 上 preventDefault 会
      // 让浏览器不再合成后续的 click 事件（W3C Touch Events §4.5.2），导致移动端 tap
      // 球无法触发 line 111 的 click listener。拖动期间的页面滚动阻止由 onMove 在
      // 确认位移 > 4px（moved=true）后 preventDefault 处理。
    }
    ball.addEventListener('mousedown', down);
    ball.addEventListener('touchstart', down, { passive: false });
  }
  function repositionBall() {
    var ball = document.querySelector('.hxa-ball'); if (!ball) return;
    var W = window.innerWidth, H = window.innerHeight;
    var bW = ball.offsetWidth || 56, bH = ball.offsetHeight || 56;
    var b = state.ball, x = b.x, y = b.y, snap = b.snapped;
    if (snap === 'left') x = 24;
    else if (snap === 'right') x = W - bW - 24;
    if (y >= 0) y = Math.max(24, Math.min(H - bH - 24, y));
    ball.style.left = x + 'px'; ball.style.top = y + 'px';
    ball.style.right = ball.style.bottom = 'auto';
    b.x = x; b.y = y; persist();
  }

  var ball, panel, body, ta, sendBtn, sessDrawer;
  // v0.4.25 hotfix: 右抽屉 DOM 引用 + open 状态机（panel 内 absolute，无 backdrop）
  var rightDrawer, rightDrawerOpen = false;
  function renderPanel() {
    var r = ensureRoot(), c = config();
    panel = el('div', { class: 'hxa-panel' + (state.ball.snapped === 'left' ? ' hxa-panel--left' : '') });
    var head = el('div', { class: 'hxa-head' });
    head.appendChild(el('button', { class: 'hxa-head__btn', title: '会话列表', onclick: toggleSessions }, [I('list')]));
    head.appendChild(el('button', { class: 'hxa-head__btn hxa-head__btn--logout', title: '退出登录', onclick: logout }, [I('logout')]));
    var info = el('div', { class: 'hxa-head__info' });
    info.appendChild(el('div', { class: 'hxa-head__title', id: 'hxa-title' }, c.title));
    info.appendChild(el('div', { class: 'hxa-head__sub', id: 'hxa-sub' }, c.subtitle));
    head.appendChild(info);
    // v0.4.25: 右抽屉触发按钮（与左侧 hamburger 对称，user icon）
    head.appendChild(el('button', { class: 'hxa-head__btn hxa-head__btn--user', title: '用户信息', 'aria-label': '用户信息', onclick: openRightDrawer }, [I('user')]));
    head.appendChild(el('button', { class: 'hxa-head__btn', title: '收起', onclick: close }, [I('close')]));
    panel.appendChild(head);
    sessDrawer = renderSessionsDrawer();
    panel.appendChild(sessDrawer);
    body = el('div', { class: 'hxa-body', id: 'hxa-body' });
    panel.appendChild(body);
    var foot = el('div', { class: 'hxa-foot' });
    var tools = el('div', { class: 'hxa-foot__tools' });
    [['knowledge', '知识库'], ['websearch', '联网']].forEach(function (kv) {
      var b = el('button', { class: 'hxa-tool', 'data-tool': kv[0], title: kv[1] }, [el('span', { class: 'hxa-tool__dot' }), kv[1]]);
      bindToolBtn(b, kv[0]);
      tools.appendChild(b);
    });
    tools.appendChild(el('div', { style: 'flex:1' }));
    tools.appendChild(el('button', { class: 'hxa-head__btn', title: '新对话', onclick: createSession }, [I('plus')]));
    foot.appendChild(tools);
    var inputRow = el('div', { class: 'hxa-foot__input' });
    ta = el('textarea', { class: 'hxa-foot__ta', id: 'hxa-ta', rows: '1', placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）' });
    sendBtn = el('button', { class: 'hxa-foot__send', id: 'hxa-send', title: '发送', onclick: onSendClick }, [I('send')]);
    inputRow.appendChild(ta);
    inputRow.appendChild(sendBtn);
    foot.appendChild(inputRow);
    foot.appendChild(el('div', { class: 'hxa-foot__hint' }, 'Enter 发送 · Shift+Enter 换行'));
    panel.appendChild(foot);
    r.appendChild(panel);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); onSendClick(); } });
    ta.addEventListener('input', autoGrow);
    updateToolsUI();
    renderSession();
    // v0.4.25 hotfix: 右抽屉 DOM 注入到 panel 内部（与 .hxa-sessions 同模式）
    // panel 内 absolute 定位相对 panel 边界，不依赖 backdrop 也覆盖 body 区
    if (!rightDrawer) {
      rightDrawer = el('aside', { class: 'hxa-right-drawer', 'aria-label': '用户信息' });
      var closeBtn = el('button', { class: 'hxa-right-drawer__close', title: '关闭', 'aria-label': '关闭', onclick: closeRightDrawer }, '×');
      rightDrawer.appendChild(closeBtn);
      // v0.4.25 review fix: data-card 值与 querySelector 一致（修复渲染静默失败 P0 bug）
      rightDrawer.appendChild(el('div', { class: 'hxa-user-card', 'data-card': 'user-card' }));
      rightDrawer.appendChild(el('div', { class: 'hxa-token-card', 'data-card': 'token-card' }));
      rightDrawer.appendChild(el('div', { class: 'hxa-ltm-card', 'data-card': 'ltm-card' }));
      panel.appendChild(rightDrawer);
    }
  }
  function autoGrow() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  }
  function bindToolBtn(b, key) { b.addEventListener('click', function () { state.tools[key] = !state.tools[key]; updateToolsUI(); }); }
  function updateToolsUI() {
    if (!panel) return;
    panel.querySelectorAll('.hxa-tool').forEach(function (b) { b.toggleAttribute('data-on', !!state.tools[b.dataset.tool]); });
  }
  function renderSessionsDrawer() {
    var d = el('div', { class: 'hxa-sessions' });
    var head = el('div', { class: 'hxa-sessions__head' });
    head.appendChild(el('span', null, '历史会话'));
    head.appendChild(el('button', { class: 'hxa-sessions__close', title: '收起', onclick: toggleSessions }, [I('close')]));
    d.appendChild(head);
    var list = el('div', { class: 'hxa-sessions__list', id: 'hxa-sess-list' });
    d.appendChild(list);
    var newBtn = el('div', { class: 'hxa-sessions__new', onclick: createSession }, '+ 新建对话');
    d.appendChild(newBtn);
    return d;
  }
  function renderSessionList() {
    var list = panel.querySelector('#hxa-sess-list'); if (!list) return;
    list.innerHTML = '';
    Object.keys(state.sessions).map(function (k) { return state.sessions[k]; })
      .sort(function (a, b) { return b.lastActiveAt - a.lastActiveAt; })
      .forEach(function (s) {
 var item = el('div', { class: 'hxa-sessions__item', 'data-sid': s.id, 'data-active': s.id === state.currentSessionId ? '1' : '0', onclick: function () { switchSession(s.id); } });
 item.appendChild(el('span', { class: 'hxa-sessions__title', title: s.title }, s.title));
        item.appendChild(el('button', { class: 'hxa-sessions__act', title: '重命名', onclick: function (e) { e.stopPropagation(); renameSession(s.id); } }, [I('edit')]));
        item.appendChild(el('button', { class: 'hxa-sessions__act', title: '删除', onclick: function (e) { e.stopPropagation(); deleteSession(s.id); } }, [I('trash')]));
        list.appendChild(item);
      });
  }
  function renderSession() {
    if (!body) return;
    body.innerHTML = '';
    var sess = currentSession();
    if (!sess || !sess.messages.length) {
      body.appendChild(el('div', { class: 'hxa-empty' }, [
        el('div', { class: 'hxa-empty__icon' }, '💬'),
        el('div', null, '开始你的第一次对话'),
        el('div', { style: 'margin-top:6px;font-size:12px;color:var(--hxa-muted-2)' }, 'Enter 发送，Shift+Enter 换行')
      ]));
      renderSessionList();
      refreshSendBtnState();
      return;
    }
    sess.messages.forEach(function (m) { body.appendChild(renderMessage(m)); });
    scrollBody();
    renderSessionList();
    refreshSendBtnState();
  }
  function scrollBody() {
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }

  function renderMessage(m) {
  // v0.4.11.2: 修 el() 4 参数 bug——JS 只取前 3 参数，第 4 个 c 被静默丢弃
  if (m.compressed) {
   var c = el('div', { class: 'hxa-fold__think', style: 'white-space:pre-wrap;word-wrap:break-word' });
   var fullText = m.content || '';
   renderMarkdownInto(c, fullText);
   return el('details', { class: 'hxa-fold', 'data-compressed': '1' }, [
     el('summary', null, '📦早期对话摘要 [点击展开]（' + (fullText.length) + ' 字）'),
     c
   ]);
 }
  var wrap = el('div', { class: 'hxa-msg hxa-msg--' + (m.role === 'user' ? 'user' : 'asst'), 'data-msg-id': m._msgId || '' });
 if (m.role === 'assistant' && m.folds && m.folds.length) renderFolds(wrap, m.folds);
    var bub = el('div', { class: 'hxa-bubble' });
    if (m.role === 'user') bub.textContent = m.content;
    else { var c = el('div', { class: 'hxa-content' }); renderMarkdownInto(c, m.content || ''); bub.appendChild(c); }
    wrap.appendChild(bub);
    if (m.role === 'assistant') {
      if (m.meta) wrap.appendChild(renderMeta(m.meta));
      if (m.error) wrap.appendChild(renderError(m));
    }
    return wrap;
  }
  function renderFolds(wrap, folds) {
    folds.forEach(function (f) {
      var det = el('details', { class: 'hxa-fold' });
      if (f.open) det.setAttribute('open', '');
      // v0.4.24: 新增 tool_call kind — 历史消息重建 tool_call 折叠块
      var tag = f.kind === 'thinking' ? '思考过程'
        : f.kind === 'knowledge' ? '调用了 ' + (f.tool || '工具') + ' 工具'
        : f.kind === 'websearch' ? '已联网搜索'
        : f.kind === 'tool_call' ? '🔧 工具调用：' + (f.tool || '工具')
        : (f.title || '详情');
      det.appendChild(el('summary', null, [el('span', { class: 'hxa-fold__head__tag' }, tag)]));
      // v0.4.24: tool_call 复用 .hxa-fold__think 样式（pre-wrap + 200px max-height），与 thinking 视觉一致
      if (f.kind === 'thinking' || f.kind === 'tool_call') det.appendChild(el('div', { class: 'hxa-fold__think' }, f.body || ''));
      else if (f.kind === 'websearch') {
        var ul = el('ul', { class: 'hxa-fold__list' });
        (f.results || []).forEach(function (r) {
          var li = el('li');
          li.innerHTML = '<a href="' + ENC(r.url || '#') + '" target="_blank" rel="noopener noreferrer">' + ENC(r.title || r.url || '链接') + '</a>' +
            (r.content ? '<small>' + ENC(r.content.slice(0, 160)) + (r.content.length > 160 ? '…' : '') + '</small>' : '');
          ul.appendChild(li);
        });
        det.appendChild(ul);
      } else if (f.kind === 'knowledge') det.appendChild(el('pre', null, [el('code', null, typeof f.data === 'string' ? f.data : JSON.stringify(f.data, null, 2))]));
      wrap.appendChild(det);
    });
  }
  function renderMeta(meta) {
    var m = el('div', { class: 'hxa-msg__meta' });
    if (meta.usage) m.appendChild(el('span', null, 'tokens ' + (meta.usage.inputTokens || 0) + '+' + (meta.usage.outputTokens || 0)));
    if (meta.ms != null) m.appendChild(el('span', { style: 'margin-left:6px' }, ' · ' + (meta.ms / 1000).toFixed(1) + 's'));
    if (meta.compressionTriggered) m.appendChild(el('span', { style: 'color:var(--hxa-warn);margin-left:6px' }, '已压缩上下文'));
    return m;
  }
  function renderError(m) {
    var bar = el('div', { class: 'hxa-errbar' });
    bar.appendChild(el('span', null, '出错了：' + (m.error.message || '未知错误')));
    var btn = el('button', { class: 'hxa-errbar__retry', onclick: function () { retryLast(); } }, '重试');
    bar.appendChild(btn);
    return bar;
  }

  function renderMarkdownInto(host, text) {
    host.innerHTML = '';
    var rendered = renderMarkdown(text || '');
    host.innerHTML = rendered;
    bindCodeCopyButtons(host);
  }
  function bindCodeCopyButtons(scope) {
    scope.querySelectorAll('pre').forEach(function (pre) {
      var btn = el('button', { class: 'hxa-copy', title: '复制' }, '复制');
      btn.addEventListener('click', function () { copyCode(pre, btn); });
      pre.appendChild(btn);
    });
  }
  function copyCode(pre, btn) {
    var text = (pre.querySelector('code') || pre).innerText;
    function done() { btn.textContent = '已复制'; btn.setAttribute('data-done', '1'); setTimeout(function () { btn.textContent = '复制'; btn.removeAttribute('data-done'); }, 1500); }
    function fallback() {
      var t = document.createElement('textarea');
      t.value = text; t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); done(); } catch (_) {}
      document.body.removeChild(t);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  function renderMarkdown(text) {
    if (typeof window.marked === 'function') { try { return window.marked.parse(text); } catch (_) {} }
    return fallbackMd(text);
  }
  function fallbackMd(text) {
    var esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var lines = esc.split('\n'), out = [], codeBuf = [], inCode = false, m;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) { if (inCode) { out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>'); codeBuf = []; inCode = false; } else inCode = true; continue; }
      if (inCode) { codeBuf.push(line); continue; }
      if ((m = /^(#{1,3})\s+(.*)/.exec(line))) { var lv = m[1].length; out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>'); }
      else if ((m = /^>\s+(.*)/.exec(line))) out.push('<blockquote>' + inline(m[1]) + '</blockquote>');
      else if ((m = /^[-*]\s+(.*)/.exec(line))) out.push('<li>' + inline(m[1]) + '</li>');
      else if ((m = /^\d+\.\s+(.*)/.exec(line))) out.push('<li>' + inline(m[1]) + '</li>');
      else if (/^---+$/.test(line)) out.push('<hr/>');
      else if (line.trim() === '') out.push('');
      else out.push('<p>' + inline(line) + '</p>');
    }
    if (inCode) out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');
    return out.join('\n').replace(/(?:<li>[^]*?<\/li>\n?)+/g, function (m) { return '<ul>' + m + '</ul>'; });
  }
  function inline(s) { return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'); }

   function createSession() {
    if (state.streaming) abortStream();
    var id = uid();
    state.sessions[id] = newSessionObj(id, '新对话 ' + Object.keys(state.sessions).length);
    state.currentSessionId = id;
    persist();
    renderSession();
    if (sessDrawer) sessDrawer.removeAttribute('data-open');
    setTimeout(function () { ta && ta.focus(); }, 50);
  }
  function switchSession(id) {
    if (!state.sessions[id]) return;
    if (state.streaming) {
      abortStream();
      setTimeout(function () { switchSession(id); }, 50);
      return;
    }
    state.currentSessionId = id;
    persist();
    renderSession();
    if (sessDrawer) sessDrawer.removeAttribute('data-open');
    setTimeout(function () { ta && ta.focus(); }, 50);
    // v0.4.4: 10 min 软刷新：_fetchedAt 在 ensureSessionMessages 内部判断
 ensureSessionMessages(id);
 }
 function renameSession(id) {
    var s = state.sessions[id];
    if (!s || !sessDrawer) return;
    var item = sessDrawer.querySelector('[data-sid="' + id + '"]');
    if (!item) return;
    var t = item.querySelector('.hxa-sessions__title');
    if (!t || t.tagName === 'INPUT') return;
    var inp = el('input', { class: 'hxa-sessions__title', value: s.title });
    t.replaceWith(inp); inp.focus(); inp.select();
    var save = function (commit) {
      var v = commit ? (inp.value.trim() || s.title) : s.title;
      s.title = v; s.lastActiveAt = now();
      if (config().mode === 'real' && getToken() && !s.id.startsWith('s_')) patchSessionRemote(id, v);
      persist(); renderSessionList();
    };
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); save(true); }
      else if (e.key === 'Escape') { e.preventDefault(); save(false); }
    });
    inp.addEventListener('blur', function () { save(true); });
  }
  function deleteSession(id) {
    var s = state.sessions[id];
    if (!s || !confirm('删除会话「' + s.title + '」？')) return;
    if (config().mode === 'real' && getToken()) deleteSessionRemote(id);
    delete state.sessions[id];
    if (state.currentSessionId === id) {
      var ids = Object.keys(state.sessions);
      if (ids.length) {
        var next = ids.map(function (k) { return state.sessions[k]; })
          .sort(function (a, b) { return (b.lastActiveAt || 0) - (a.lastActiveAt || 0); })[0];
        state.currentSessionId = next.id;
      } else {
        // v0.4.5.2: 删完最后一个 session 也不自动建——保持 currentSessionId=''
        state.currentSessionId = '';
      }
    }
    persist();
    renderSession();
  }
  function toggleSessions() {
    if (!sessDrawer) return;
    if (sessDrawer.getAttribute('data-open')) sessDrawer.removeAttribute('data-open');
    else { sessDrawer.setAttribute('data-open', '1'); renderSessionList(); }
  }

  function ensureRemoteSession(sess) {
    if (sess && sess.id && !/^s_/.test(sess.id)) {
      return Promise.resolve({ id: sess.id });
    }
    if (pendingRemote) return pendingRemote;
    var title = (sess && sess.title) || '新对话';
    pendingRemote = fetch((config().apiBase || '') + '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({ title: title })
    }).then(function (r) { return r.json(); }).then(function (j) {
      pendingRemote = null;
      if (!j || j.code !== 0) throw new Error((j && j.msg) || 'session create failed');
      return j.data;
    }).catch(function (e) { pendingRemote = null; throw e; });
    return pendingRemote;
  }
  // v0.4.3 + v0.4.11: 拉取后端 historyList（带最后消息预览）填充到本地 state.sessions
  // 触发时机：init 时若本地无会话 / 打开抽屉时强制刷新
  // v0.4.11 修：opts.includeMessages 不传时默认 true —— 大部分场景需要完整 messages
  //   （渲染早期对话摘要需要 compressed summary），之前默认 false 漏掉 summary
  function loadHistoryList(opts) {
 opts = opts || {};
 var includeMessages = opts.includeMessages !== false;  // 默认 true
  if (config().mode !== 'real' || !getToken()) return Promise.resolve();
  var apiBase = config().apiBase || '';
  var url = apiBase + '/api/sessions/historyList?limit=10' + (includeMessages ? '&includeMessages=true' : '');
 return fetch(url, {
 headers: { 'Authorization': 'Bearer ' + getToken() }
 }).then(function (r) { return r.json(); }).then(function (j) {
 if (!j || j.code !==0 || !Array.isArray(j.data)) return;
 j.data.forEach(function (rs) {
 if (!rs || !rs.id) return;
 var existing = state.sessions[rs.id];
 if (existing) {
 existing.title = rs.title || existing.title;
 existing.lastActiveAt = Math.max(existing.lastActiveAt ||0, new Date(rs.lastActiveAt).getTime() ||0);
 existing._lastMessage = stripMemUpdate(rs.lastMessage || '');
 } else {
 state.sessions[rs.id] = {
 id: rs.id, title: rs.title || '后端会话',
 createdAt: new Date(rs.createdAt).getTime() || now(),
 lastActiveAt: new Date(rs.lastActiveAt).getTime() || now(),
 archived: !!rs.archived, messages: [], _lastMessage: stripMemUpdate(rs.lastMessage || '')
 };
 }
        if (includeMessages && Array.isArray(rs.messages)) {
            state.sessions[rs.id].messages = rs.messages.map(mapBackendMessage);
            state.sessions[rs.id]._fetchedAt = Date.now();
        }
 });
 if (typeof renderSessionList === 'function') renderSessionList();
 }).catch(function () {});
 }
 // v0.4.4: 把后端 message DTO映射成前端 message结构（含 compressed透传）
 // v0.4.24: 重建 thinking + tool_call 折叠块——刷新页面/加载历史时，
 //   从后端 MessageDto.thinking 字段取完整思考过程，
 //   从 toolCallsJson (JSON 字符串) 解析出 tool_call 数组。
 //   顺序：tool_call 先 push、thinking 后 unshift —— 保证 thinking 在最前（与 SSE 流行为一致）
 function mapBackendMessage(m) {
  var msg = {
  role: m.role,
  content: stripMemUpdate(m.content || ''),
  ts: m.createdAt ? new Date(m.createdAt).getTime() : now(),
  compressed: !!m.compressed,
  folds: [], meta: null, error: null
  };
  // tool_call 先 push（按时间顺序排在 thinking 之后）
  if (m.role === 'assistant' && m.toolCallsJson) {
  try {
  var calls = JSON.parse(m.toolCallsJson);
  if (Array.isArray(calls)) {
  calls.forEach(function (call) {
  msg.folds.push({
  kind: 'tool_call',
  tool: call.toolName || call.tool || '工具',
  args: call.args || '',
  result: call.result || '',
  body: (call.toolName || call.tool || '工具') + '(' + (call.args || '') + ') → ' + (call.result || ''),
  ts: call.timestamp || null,
  open: false
  });
  });
  }
  } catch (e) {
  console.warn('[mapBackendMessage] toolCallsJson parse failed:', e, m.toolCallsJson);
  }
  }
  // thinking 后 unshift（总在最前）
  if (m.role === 'assistant' && m.thinking) {
  msg.folds.unshift({
  kind: 'thinking',
  body: m.thinking,
  open: false
  });
  }
  return msg;
 }
  // v0.4.3: 懒加载历史 session 消息——本地缓存命中（messages.length > 0）则跳过
  function ensureSessionMessages(sid) {
 var s = state.sessions[sid];
 if (!s) return Promise.resolve();
 if (/^s_/.test(sid)) return Promise.resolve();
 if (s._fetchedAt && (Date.now() - s._fetchedAt) < 10 * 60 * 1000) return Promise.resolve();
 if (config().mode !== 'real' || !getToken()) return Promise.resolve();
 return fetch((config().apiBase || '') + '/api/sessions/' + encodeURIComponent(sid) + '/messages', {
 headers: { 'Authorization': 'Bearer ' + getToken() }
 }).then(function (r) { return r.json(); }).then(function (j) {
 if (!j || j.code !==0 || !Array.isArray(j.data)) return;
 s.messages = j.data.map(mapBackendMessage);
 s._fetchedAt = Date.now();
 persist();
 if (typeof renderSession === 'function' && state.currentSessionId === sid) renderSession();
 }).catch(function () {});
 }
 // v0.4.4: 后台限流2 并发预拉过期 session（_fetchedAt 未设置 或超过10分钟）
 function prefetchStaleSessions() {
  var STALE_MS =10 *60 *1000; //10分钟
  var nowTs = Date.now();
  var pending = Object.keys(state.sessions)
  .filter(function (k) { return !/^s_/.test(k); })
  .filter(function (k) {
  var s = state.sessions[k];
  return !s._fetchedAt || (nowTs - s._fetchedAt) > STALE_MS;
  });
  if (pending.length ===0) return Promise.resolve();
  //限流2 并发
  var queue = pending.slice();
  function next() {
  if (queue.length ===0) return Promise.resolve();
  var sid = queue.shift();
  return ensureSessionMessages(sid).finally(next);
 }
 return Promise.all([next(), next()]);
 }
  function patchSessionRemote(id, newTitle) {
    fetch((config().apiBase || '') + '/api/sessions/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
      body: JSON.stringify({ newTitle: newTitle })
    }).catch(function () {});
  }
  function deleteSessionRemote(id) {
    fetch((config().apiBase || '') + '/api/sessions/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + getToken() }
    }).catch(function () {});
  }

  function onSendClick() {
    if (state.streaming) { abortStream(); return; }
    if (!state.currentSessionId || !state.sessions[state.currentSessionId]) return;
    var text = (ta && ta.value || '').trim();
    if (!text) return;
    send(text);
  }
   function send(text) {
    if (!_initReady) { setTimeout(function () { send(text); }, 300); return; }
    if (state.streaming) return;
    var sess = currentSession();
    if (!sess) return;
    if (/^新(对话|会话)/.test(sess.title)) {
      sess.title = text.slice(0, 30);
      if (typeof renderSessionList === 'function') renderSessionList();
    }
    // v0.4.9: 已有 session（后端 UUID）继续对话时，ensureSessionMessages 被 10 分钟缓存
    // 拦截后消息可能与本地状态错位。强制每次 send 重新拉一次再 push。
    if (!/^s_/.test(sess.id)) {
      ensureSessionMessages(sess.id).then(function () {
        if (state.currentSessionId !== sess.id) return; // 用户已切到别的 session
        appendAndStream(sess, text);
      });
    } else {
      appendAndStream(sess, text);
    }
  }
  function appendAndStream(sess, text) {
    sess.lastActiveAt = now();
    var ts = now();
    sess.messages.push({ role: 'user', content: text, ts: ts });
    var m = { role: 'assistant', content: '', folds: [], ts: ts, meta: null, error: null, _msgId: 'm_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) };
    sess.messages.push(m);
    persist();
    renderSession();
    if (ta) { ta.value = ''; autoGrow(); }
    startAssistant(sess, m, text);
  }
  function retryLast() {
    var sess = currentSession();
    if (!sess) return;
    for (var i = sess.messages.length - 1; i >= 0; i--) {
      if (sess.messages[i].role === 'user') {
        var last = sess.messages[i].content;
        sess.messages = sess.messages.slice(0, i + 1);
        var asst = { role: 'assistant', content: '', folds: [], ts: now(), meta: null, error: null };
        sess.messages.push(asst);
        persist();
        renderSession();
        startAssistant(sess, asst, last);
        return;
      }
    }
  }
  function startAssistant(sess, asstMsg, text) {
    state.streaming = true;
    setStreamingUI(true);
    if (config().mode === 'real' && getToken()) {
      ensureRemoteSession(sess).then(function (r) {
        var newId = (r && r.id) || sess.id;
        if (newId && sess.id !== newId) {
          // v0.4.7: 必须重命名 state.sessions 的 key + 同步 currentSessionId + 重渲染抽屉
          // 之前只改 sess.id 字符串导致后续 switchSession / renameSession / deleteSession 全部失效
          state.sessions[newId] = sess;
          delete state.sessions[sess.id];
          sess.id = newId;
          if (state.currentSessionId === sess.id) {
            // sess.id 已更新，无需改
          } else if (!state.currentSessionId || state.sessions[state.currentSessionId] !== sess) {
            state.currentSessionId = newId;
          }
          persist();
          if (typeof renderSessionList === 'function') renderSessionList();
        }
        return streamReal(sess, asstMsg, text, newId);
      }).catch(function (e) {
        appendError(asstMsg, 'AGENT_ERROR', (e && e.message) || 'session create failed');
        finishStream(sess, asstMsg);
      });
    } else streamMock(sess, asstMsg, text);
  }
  function applyEvent(m, ev, p, t0) {
    if (ev === 'thinking') {
      var tf = m.folds.find(function (f) { return f.kind === 'thinking'; });
      if (!tf) { tf = { kind: 'thinking', body: '', open: true }; m.folds.unshift(tf); }
      tf.body = (tf.body || '') + (p.delta || '');
    } else if (ev === 'knowledge') m.folds.push({ kind: 'knowledge', tool: p.tool, data: p.data, open: false });
    else if (ev === 'websearch') m.folds.push({ kind: 'websearch', query: p.query, results: p.results || [], open: true });
    else if (ev === 'answer') return { delta: p.delta || '' };
    else if (ev === 'done') {
      m.meta = { usage: p.usage || { inputTokens: 0, outputTokens: 0 }, ms: p.ms != null ? p.ms : (now() - t0), compressionTriggered: !!p.compressionTriggered };
      m.folds.forEach(function (f) { if (f.kind === 'thinking') f.open = false; });
      return { done: true };
    } else if (ev === 'error') { m.error = { code: p.code || 'AGENT_ERROR', message: p.message || '出错了' }; return { done: true }; }
    return null;
  }
  function streamMock(sess, asstMsg, text) {
    var ctx = { pending: '', t0: now(), rt: null }, ac = { aborted: false };
    state.abort = function () { ac.aborted = true; if (window.HexoMock) window.HexoMock.cancel(); };
    function onEvt(o) { if (ac.aborted) return; dispatchEvent(ctx, asstMsg, sess, o.event, o.data || {}); }
    if (window.HexoMock) window.HexoMock.stream(text, onEvt);
  }
  function streamReal(sess, asstMsg, text, sid) {
    var ac = new AbortController();
    state.abort = function () { ac.abort(); };
    fetch((config().apiBase || '') + '/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken(), 'Accept': 'text/event-stream' },
      body: JSON.stringify(Object.assign({ sessionId: sid, userMessage: text }, extractArticleContext())),
      signal: ac.signal
    }).then(function (resp) {
      if (!resp.ok) return resp.text().then(function (b) {
        var j; try { j = JSON.parse(b); } catch (_) { j = null; }
        appendError(asstMsg, (j && j.code) === 40100 ? 'UNAUTHORIZED' : 'AGENT_ERROR', (j && j.msg) || ('HTTP ' + resp.status));
        finishStream(sess, asstMsg);
      });
      return pumpSSE(resp.body.getReader(), sess, asstMsg);
    }).catch(function (e) {
      if (e && e.name === 'AbortError') finishStream(sess, asstMsg);
      else { appendError(asstMsg, 'AGENT_ERROR', (e && e.message) || 'network error'); finishStream(sess, asstMsg); }
    });
  }
  function flushCtx(ctx, m) { ctx.rt = null; var c = findAsstBubble(m); if (c) { var x = c.querySelector('.hxa-content'); if (x) renderMarkdownInto(x, ctx.pending); } scrollBody(); }
  function dispatchEvent(ctx, m, sess, ev, p) {
    var res = applyEvent(m, ev, p, ctx.t0);
    if (res && res.delta) { ctx.pending += res.delta; m.content = ctx.pending; if (!ctx.rt) ctx.rt = setTimeout(function () { flushCtx(ctx, m); }, 60); }
    var l = findAsstBubble(m); if (l) syncFoldsAndMeta(l, m);
    scrollBody();
    if (res && res.done && !m._finished) { m._finished = true; finishStream(sess, m); }
  }
  function pumpSSE(reader, sess, asstMsg) {
    var ctx = { pending: '', t0: now(), rt: null }, dec = new TextDecoder('utf-8'), buf = '';
    function read() {
      return reader.read().then(function (r) {
        if (r.done) {
          flushCtx(ctx, asstMsg);
          if (!asstMsg.meta && !asstMsg.error) {
            asstMsg.meta = { usage: null, ms: now() - ctx.t0, finishReason: 'stream_cut' };
          }
          return;
        }
        buf += dec.decode(r.value, { stream: true });
        var parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (var i = 0; i < parts.length; i++) {
          var ev = '', data = '';
          parts[i].split('\n').forEach(function (ln) {
            if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
            else if (ln.indexOf('data:') === 0) data += (data ? '\n' : '') + ln.slice(5).trim();
          });
          if (!ev || !data) continue;
          var payload; try { payload = JSON.parse(data); } catch (_) { continue; }
          dispatchEvent(ctx, asstMsg, sess, ev, payload);
          if (asstMsg.meta || asstMsg.error) { return; }
        }
        return read();
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return;
        // v0.4.23: Spring + Reactor Netty 在 Transfer-Encoding: chunked 模式下漏写
        // 0\r\n\r\n 终止符，Chrome 抛 ERR_INCOMPLETE_CHUNKED_ENCODING。如果
        // asstMsg.meta 已经设置（即流已收到 event:done），说明业务侧已完成，
        // 这是无害的 stream_cut，不应标记为 AGENT_ERROR。
        var msg = (e && e.message) || 'stream error';
        if (asstMsg.meta && /ERR_INCOMPLETE_CHUNKED_ENCODING/i.test(msg)) {
          if (!asstMsg.meta.finishReason) asstMsg.meta.finishReason = 'stream_cut';
          return; // 静默吞掉，不污染 UI
        }
        appendError(asstMsg, 'AGENT_ERROR', msg);
      }).then(function () { if (!asstMsg._finished) { asstMsg._finished = true; finishStream(sess, asstMsg); } });
    }
    read();
  }
  function findAsstBubble(m) {
    if (!body) return null;
    // v0.4.9: 优先按 _msgId 查（保证消息对象与 DOM 节点一一对应，不受 messages 数组位置变动影响）
    if (m && m._msgId) {
      var byId = body.querySelector('.hxa-msg[data-msg-id="' + m._msgId + '"]');
      if (byId) return byId;
    }
    var s = currentSession();
    var i = s ? s.messages.indexOf(m) : -1;
    return i >= 0 ? body.querySelectorAll('.hxa-msg')[i] : null;
  }
  function syncFoldsAndMeta(wrap, m) {
    var c = wrap.querySelector('.hxa-content');
    if (c && c._lastText !== m.content) { renderMarkdownInto(c, m.content || ''); c._lastText = m.content; }
    var sigs = m.folds.map(function (f) { return (f.kind || '') + ':' + (f.tool || f.query || '') + ':' + (f.body || '').length; }).join('|');
    if (wrap._foldSig !== sigs) {
      wrap._foldSig = sigs;
      wrap.querySelectorAll(':scope > .hxa-fold, :scope > .hxa-msg__meta').forEach(function (n) { wrap.removeChild(n); });
      if (m.folds.length) {
        var tmp = document.createElement('div');
        renderFolds(tmp, m.folds);
        var ref = wrap.querySelector('.hxa-bubble');
        while (tmp.firstChild) wrap.insertBefore(tmp.firstChild, ref);
      }
      if (m.meta) wrap.appendChild(renderMeta(m.meta));
    }
    if (m.error && !wrap.querySelector(':scope > .hxa-errbar')) wrap.appendChild(renderError(m));
  }
  function appendError(m, code, message) { m.error = { code: code || 'AGENT_ERROR', message: message || '出错了' }; var l = findAsstBubble(m); if (l) syncFoldsAndMeta(l, m); }
  function abortStream() { if (state.abort) { try { state.abort(); } catch (_) {} state.abort = null; } }
  function finishStream(sess, m) { state.streaming = false; state.abort = null; setStreamingUI(false); var l = findAsstBubble(m); if (l) syncFoldsAndMeta(l, m); persist(); }
  function setStreamingUI(on) {
    if (!sendBtn) return;
    sendBtn.toggleAttribute('data-stop', on);
    sendBtn.title = on ? '停止' : '发送';
    sendBtn.replaceChildren(I(on ? 'stop' : 'send'));
    refreshSendBtnState();
  }
  // v0.4.6: 冷启动无 currentSessionId 时 send 按钮置灰——按用户明确要求
  // hexo.sessionId 只能从历史点选 / 手动"+"两条路径获得，不应让用户能"发送到空 session"
  function refreshSendBtnState() {
    if (!sendBtn) return;
    var noSession = !state.currentSessionId || !state.sessions[state.currentSessionId];
    var disabled = noSession || state.streaming;
    if (disabled) sendBtn.setAttribute('data-disabled', '1');
    else sendBtn.removeAttribute('data-disabled');
    sendBtn.title = noSession ? '请先选择或新建会话' : (state.streaming ? '停止' : '发送');
  }

  function open() {
    // 无 token 时弹出登录
    if (config().mode === 'real' && !getToken()) return showLogin();
    if (!panel) renderPanel();
    if (!panel) return;
    panel.setAttribute('data-open', '1');
    var b = document.querySelector('.hxa-ball'); if (b) b.setAttribute('data-open', '1');
    state.open = true;
    setTimeout(function () { ta && ta.focus(); }, 60);
  }
  // v0.4.22 抽共用：showLogin 实现移至 agent-common.js
  var showLogin = window.HexoAgentCommon && window.HexoAgentCommon.showLogin
    ? window.HexoAgentCommon.showLogin
    : function () {
      // v0.4.26.1 fallback: agent-common.js 加载失败时 console.warn + 用户可见 alert，
      // 避免「点 ball 静默不开 panel 又不弹登录」的 UX 黑屏。
      if (typeof console !== 'undefined') console.warn('[hexo-agent] agent-common.js not loaded, showLogin unavailable');
      if (typeof alert === 'function') alert('会话已过期或缺失，请刷新页面重新登录');
    };
  function close() {
    if (!panel) return;
    panel.removeAttribute('data-open');
    var b = document.querySelector('.hxa-ball'); if (b) b.removeAttribute('data-open');
    state.open = false;
    if (sessDrawer) sessDrawer.removeAttribute('data-open');
  }
  // v0.4.23: 退出登录 — 仅清 token + 关闭 panel，不自动重弹登录
  // user 表态：避免"刚退又被弹窗吓到"；再点入口按钮时 showLogin 自然触发
  function logout() {
    try { localStorage.removeItem('hexo.token'); } catch (_) {}
    close();
  }
  function toggle() { state.open ? close() : open(); }

  // ===== v0.4.25 右抽屉（用户信息） =====
  // hotfix: 从屏幕级 fixed + backdrop 改为 panel 内 absolute（与 .hxa-sessions 对称）
  // DOM 创建已合并到 renderPanel() 末尾（panel 内 append），无独立 backdrop。
  /**
   * 打开右抽屉：CSS translateX(100% → 0) 滑入 + 触发数据加载
   * 守卫：real 模式无 token 时切登录弹窗（与左抽屉 open 行为一致）
   */
  function openRightDrawer() {
    if (!panel) renderPanel();  // panel 未创建（罕见：用户图标点击早于 open）则懒加载
    if (config().mode === 'real' && !getToken()) { showLogin(); return; }
    rightDrawerOpen = true;
    if (rightDrawer) rightDrawer.classList.add('open');
    if (typeof loadDashboardData === 'function') loadDashboardData();
  }
  /**
   * 关闭右抽屉：移除 open class 触发 CSS translateX(100%) 滑出
   * 触发器：× 按钮 + Esc 键（IME 守卫在 init() 阶段绑，PR-2 实现）
   */
  function closeRightDrawer() {
    if (!rightDrawer) return;
    rightDrawerOpen = false;
    rightDrawer.classList.remove('open');
  }
  function toggleRightDrawer() { rightDrawerOpen ? closeRightDrawer() : openRightDrawer(); }

  // ===== v0.4.25 右抽屉数据加载（设计 doc §3.4 P1-1：5 fetch → 2 fetch）=====
  /**
   * 整合 dashboard endpoint — 一次返回 user + costMe + costToday + cost7Days。
   * 鉴权沿用现有 getToken() + Bearer header 模式（参考 streamReal / loadHistoryList）。
   * @returns {Promise<{user: object, costMe: object, costToday: object, cost7Days: array}>}
   */
  function fetchDashboard() {
    return fetch((config().apiBase || '') + '/api/agent/user/dashboard', {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    }).then(function (resp) {
      if (!resp.ok) throw new Error('Dashboard HTTP ' + resp.status);
      return resp.json();
    }).then(function (j) {
      // 后端统一响应包络 {code, msg, data} — 取 data；裸 JSON 也兼容
      return (j && j.data) ? j.data : j;
    });
  }
  /**
   * 长期记忆 endpoint — 独立 endpoint（dashboard 可不包含 LTM 让大对象可选）。
   * 返回结构由 LongTermMemoryService 决定；前端容忍 {fields: {...}} 与扁平两种形态。
   * @returns {Promise<object>}
   */
  function fetchLTM() {
    return fetch((config().apiBase || '') + '/api/agent/user/long-term-memory', {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    }).then(function (resp) {
      if (!resp.ok) throw new Error('LTM HTTP ' + resp.status);
      return resp.json();
    }).then(function (j) {
      return (j && j.data) ? j.data : j;
    });
  }
  /**
   * 把指定卡片切到 loading 骨架（spinner + 文案）。
   * @param {'user-card'|'token-card'|'ltm-card'} id — 卡片 DOM id（暂用 data-card 匹配）
   */
  function setCardLoading(id) {
    var card = rightDrawer && rightDrawer.querySelector('[data-card="' + id + '"]');
    if (!card) return;
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'hxa-card__loading' }, '加载中…'));
  }
  /**
   * 把指定卡片切到 error 态（红框 + 重试按钮）。
   * @param {string} id — 卡片标识
   * @param {string} msg — 错误描述
   */
  function setCardError(id, msg) {
    var card = rightDrawer && rightDrawer.querySelector('[data-card="' + id + '"]');
    if (!card) return;
    card.innerHTML = '';
    var box = el('div', { class: 'hxa-card__error' });
    box.appendChild(el('span', null, msg || '加载失败'));
    var btn = el('button', null, '重试');
    btn.addEventListener('click', function () { loadDashboardData(); });
    box.appendChild(btn);
    card.appendChild(box);
  }
  /**
   * 清掉卡片 loading/error 容器，等 render 函数填内容。
   */
  function clearCardLoading(id) {
    var card = rightDrawer && rightDrawer.querySelector('[data-card="' + id + '"]');
    if (!card) return;
    card.innerHTML = '';
  }

  /**
   * 并发拉取 dashboard + LTM（P0-5 采纳 Promise.allSettled：任一失败不影响其他卡片）。
   * 调度：dashboard 成功 → renderUserCard + renderTokenCard；LTM 成功 → renderLTMCard。
   * 失败：各自 setCardError（独立 loading/error，不互相阻塞）。
   */
  function loadDashboardData() {
    if (!rightDrawer) return;
    setCardLoading('user-card');
    setCardLoading('token-card');
    setCardLoading('ltm-card');
    Promise.allSettled([fetchDashboard(), fetchLTM()]).then(function (results) {
      var dash = results[0], ltm = results[1];
      if (dash.status === 'fulfilled') {
        renderUserCard(dash.value);
        renderTokenCard(dash.value);
      } else {
        console.warn('[hexo-agent] dashboard fetch failed:', dash.reason);
        setCardError('user-card', '用户信息加载失败');
        setCardError('token-card', 'Token 加载失败');
      }
      if (ltm.status === 'fulfilled') {
        renderLTMCard(ltm.value);
      } else {
        console.warn('[hexo-agent] LTM fetch failed:', ltm.reason);
        setCardError('ltm-card', '长期记忆加载失败');
      }
    });
  }

  /**
   * 把 ISO 时间戳格式化为"X 分钟/小时/天前"相对时间。
   * @param {string|number} iso — ISO 字符串或毫秒时间戳
   * @returns {string}
   */
  function relativeTime(iso) {
    if (!iso) return '';
    var t = (typeof iso === 'number') ? iso : new Date(iso).getTime();
    if (!t || isNaN(t)) return '';
    var diff = Date.now() - t;
    if (diff < 0) return '刚刚';
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + ' 天前';
    return new Date(t).toLocaleDateString('zh-CN');
  }

  // ===== v0.4.25 三段卡片渲染 =====
  // XSS 防御（设计 doc §3.3 P2-1 + 盲-1）：LTM 是 LLM 输出 = 不可信数据源，
  // 所有动态字符串**严格走 element.textContent = value**，**禁止 innerHTML**。
  // 字段 key 是静态枚举，所以走 createElement + setAttribute 安全。

  /** User 卡渲染：暖橙渐变头像（nickname 首字 + uppercase fallback）+ 昵称 + email + 注册时间 */
  function renderUserCard(dashboard) {
    var card = rightDrawer && rightDrawer.querySelector('[data-card="user-card"]');
    if (!card) return;
    clearCardLoading('user-card');
    card.innerHTML = '';
    var user = (dashboard && dashboard.user) || {};
    var nickname = user.nickname || user.email || 'U';
    var initial = nickname.charAt(0).toUpperCase();

    var avatar = el('div', { class: 'hxa-user-card__avatar' });
    avatar.textContent = initial;  // textContent — XSS 安全
    card.appendChild(avatar);

    var info = el('div', { class: 'hxa-user-card__info' });
    var nick = el('div', { class: 'hxa-user-card__nickname' });
    nick.textContent = user.nickname || '未设置';
    info.appendChild(nick);
    if (user.email) {
      var em = el('div', { class: 'hxa-user-card__email' });
      em.textContent = user.email;
      info.appendChild(em);
    }
    if (user.createdAt) {
      var meta = el('div', { class: 'hxa-user-card__meta' });
      meta.textContent = '注册于 ' + relativeTime(user.createdAt);
      info.appendChild(meta);
    }
    card.appendChild(info);
  }

  /**
   * 把 7 日用量数据点（cost7Days）渲染成 sparkline 折线图。
   * 纯 DOM API（createElementNS）构造 SVG，避免 innerHTML 拼接路径字符串的 XSS 风险。
   * 设计 doc §3.3 Token 卡：暖橙渐变 area fill + 折线 + 今日点高亮。
   * @param {HTMLElement} container — 容器（DOM 节点，由调用方创建）
   * @param {Array<{date:string, totalTokens:number}>} data — 7 日数据点
   */
  function renderSparkline(container, data) {
    if (!container) return;
    container.innerHTML = '';
    if (!data || data.length === 0) {
      var empty = el('span', { class: 'hxa-sparkline__empty' }, '暂无 7 日数据');
      container.appendChild(empty);
      return;
    }

    var width = 200, height = 40, padding = 4;
    var innerW = width - padding * 2;
    var innerH = height - padding * 2;
    var values = data.map(function (d) { return Number(d && d.totalTokens) || 0; });
    var maxVal = Math.max.apply(null, values.concat([1]));
    var minVal = Math.min.apply(null, values.concat([0]));
    var range = maxVal - minVal || 1;

    var SVG_NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'hxa-sparkline');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(height));
    svg.setAttribute('preserveAspectRatio', 'none');

    // 渐变 defs（暖橙 0.4 → 0 透明度）
    var defs = document.createElementNS(SVG_NS, 'defs');
    var grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', 'hxa-sparkline-gradient');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    [{ off: 0, op: 0.4 }, { off: 1, op: 0 }].forEach(function (s) {
      var stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', (s.off * 100) + '%');
      stop.setAttribute('stop-color', '#FF7A45');
      stop.setAttribute('stop-opacity', String(s.op));
      grad.appendChild(stop);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    // 数据点 → 屏幕坐标
    var pts = data.map(function (d, i) {
      var v = Number(d && d.totalTokens) || 0;
      var x = padding + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
      var y = padding + (1 - (v - minVal) / range) * innerH;
      return { x: x, y: y };
    });

    // 折线 + area path
    var lineD = pts.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + ' ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
    }).join(' ');
    var lastX = pts[pts.length - 1].x.toFixed(1);
    var firstX = pts[0].x.toFixed(1);
    var areaD = lineD + ' L ' + lastX + ' ' + (height - padding) + ' L ' + firstX + ' ' + (height - padding) + ' Z';

    var area = document.createElementNS(SVG_NS, 'path');
    area.setAttribute('d', areaD);
    area.setAttribute('fill', 'url(#hxa-sparkline-gradient)');
    svg.appendChild(area);

    var line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', lineD);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#FF7A45');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);

    // 散点：今日点（最后）高亮（r=3 + #FF4D4F 深红），其他点（r=1.5 + #FF7A45 暖橙）
    pts.forEach(function (p, i) {
      var c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', p.x.toFixed(1));
      c.setAttribute('cy', p.y.toFixed(1));
      c.setAttribute('r', i === pts.length - 1 ? '3' : '1.5');
      c.setAttribute('fill', i === pts.length - 1 ? '#FF4D4F' : '#FF7A45');
      svg.appendChild(c);
    });

    container.appendChild(svg);
  }

  /** Token 卡渲染：3 档数值（总额 / 本月 / 今日）+ sparkline 折线图（PR-3 绘制）*/
  function renderTokenCard(dashboard) {
    var card = rightDrawer && rightDrawer.querySelector('[data-card="token-card"]');
    if (!card) return;
    clearCardLoading('token-card');
    card.innerHTML = '';

    // 标题 + 刷新按钮
    var header = el('div', { class: 'hxa-card__header' });
    header.appendChild(el('h3', { class: 'hxa-card__title' }, 'Token 用量'));
    var refresh = el('button', { class: 'hxa-card__refresh', title: '刷新' }, '🔄 刷新');
    refresh.addEventListener('click', function () { loadDashboardData(); });
    header.appendChild(refresh);
    card.appendChild(header);

    // 3 档数值 grid
    // v0.4.26 oracle P1#2 修复：前端不再从单一 costMe 拿所有 3 档值；
    // 总额走 costMe，本月走 costMonth（CostTracker.userMonthSummary 新增），今日走 costToday。
    // 各档值都从对应子对象的 totalTokens 字段取（与下方 sparkline cost7Days 同口径）。
    var costMe = (dashboard && dashboard.costMe) || {};
    var costMonth = (dashboard && dashboard.costMonth) || {};
    var costToday = (dashboard && dashboard.costToday) || {};
    var grid = el('div', { class: 'hxa-token-card__grid' });
    [
      { key: 'totalTokens', label: '总额', source: costMe },
      { key: 'totalTokens', label: '本月', source: costMonth },
      { key: 'totalTokens', label: '今日', source: costToday }
    ].forEach(function (kv) {
      var item = el('div', { class: 'hxa-token-card__item' });
      var v = el('div', { class: 'hxa-token-card__value' });
      // v0.4.26: 数据源改成各档对应子对象（与 kv.source 绑定）
      v.textContent = String(kv.source[kv.key] != null ? kv.source[kv.key] : 0);  // textContent
      var l = el('div', { class: 'hxa-token-card__label' });
      l.textContent = kv.label;
      item.appendChild(v);
      item.appendChild(l);
      grid.appendChild(item);
    });
    card.appendChild(grid);

    // sparkline 实际绘制（PR-3）：7 日用量折线 + 暖橙渐变 area fill + 今日点高亮
    var sparklineContainer = el('div', { class: 'hxa-token-card__sparkline' });
    card.appendChild(sparklineContainer);
    renderSparkline(sparklineContainer, (dashboard && dashboard.cost7Days) || []);
  }

  /** LTM 卡渲染：10 字段默认展开（设计 doc §3.3 P1-3 采纳）
   *  每字段：name + value（多值 join） + confidence 进度条 + source 标签 + updatedAt。
   *  value 严格 textContent（XSS 防御核心）*/
  function renderLTMCard(ltm) {
    var card = rightDrawer && rightDrawer.querySelector('[data-card="ltm-card"]');
    if (!card) return;
    clearCardLoading('ltm-card');
    card.innerHTML = '';

    // 标题 + 刷新
    var header = el('div', { class: 'hxa-card__header' });
    header.appendChild(el('h3', { class: 'hxa-card__title' }, '长期记忆（10 字段）'));
    var refresh = el('button', { class: 'hxa-card__refresh', title: '刷新' }, '🔄 刷新');
    refresh.addEventListener('click', function () { loadDashboardData(); });
    header.appendChild(refresh);
    card.appendChild(header);

    // 10 字段 key → 中文标签。后端 LongTermMemory F_* 常量顺序对齐
    var fieldLabels = {
      nickname: '昵称', hobbies: '爱好', techStack: '技术栈',
      occupation: '职业', city: '城市', age: '年龄',
      style: '回答偏好', behaviorStyle: '行事风格',
      currentProject: '当前项目', pastTopics: '历史话题'
    };
    // 兼容 {fields: {key: {value, confidence, source, updatedAt}}} 与扁平 {key: string} 两种 schema
    var fields = (ltm && ltm.fields) || {};

    var hasAny = false;
    Object.keys(fieldLabels).forEach(function (key) {
      var fv = fields[key];
      if (fv == null) return;
      // 兼容扁平 string value
      if (typeof fv === 'string' || typeof fv === 'number') fv = { value: fv };
      if (fv.value == null || fv.value === '') return;
      hasAny = true;

      var fieldEl = el('div', { class: 'hxa-ltm-card__field' });

      var name = el('div', { class: 'hxa-ltm-card__field-name' });
      name.textContent = fieldLabels[key];
      fieldEl.appendChild(name);

      var value = el('div', { class: 'hxa-ltm-card__field-value' });
      // value 是 List<String> 时 join，否则 String —— **严格 textContent**
      value.textContent = Array.isArray(fv.value) ? fv.value.join('，') : String(fv.value);
      fieldEl.appendChild(value);

      var meta = el('div', { class: 'hxa-ltm-card__field-meta' });

      // confidence 进度条
      var conf = el('span', { class: 'hxa-ltm-card__confidence' });
      var confBar = el('span', { class: 'hxa-ltm-card__confidence-bar' });
      confBar.style.width = Math.round((typeof fv.confidence === 'number' ? fv.confidence : 0) * 100) + '%';
      conf.appendChild(confBar);
      meta.appendChild(conf);

      // source 标签
      var source = el('span', { class: 'hxa-ltm-card__source' });
      var src = fv.source || 'default';
      source.setAttribute('data-source', src);
      source.textContent = src === 'keyword' ? '关键词' : src === 'compression' ? '压缩' : '默认';
      meta.appendChild(source);

      // updatedAt 相对时间
      if (fv.updatedAt) {
        var updated = el('span', { class: 'hxa-ltm-card__field-updated' });
        updated.textContent = relativeTime(fv.updatedAt);
        meta.appendChild(updated);
      }

      fieldEl.appendChild(meta);
      card.appendChild(fieldEl);
    });

    if (!hasAny) card.appendChild(el('div', { class: 'hxa-card__empty' }, '暂无长期记忆'));
  }

  function configure(patch) {
    if (!patch) return;
    var c = window.HexoAgentConfig = config();
    for (var k in patch) c[k] = patch[k];
    setToolsFromConfig();
    if (panel) {
      var t = panel.querySelector('#hxa-title'), s = panel.querySelector('#hxa-sub');
      if (t && c.title) t.textContent = c.title;
      if (s && c.subtitle) s.textContent = c.subtitle;
    }
    updateToolsUI();
  }
  function getState() {
    return { open: state.open, sessions: Object.keys(state.sessions).length, current: state.currentSessionId, streaming: state.streaming };
  }
  function syncActiveSession(attempt) {
    if (config().mode !== 'real') return;
    var tok = getToken();
    if (!tok) {
      if ((attempt || 0) < 30) setTimeout(function () { syncActiveSession((attempt || 0) + 1); }, 200);
      return;
    }
    var apiBase = config().apiBase || '';
    var authH = { 'Authorization': 'Bearer ' + tok };
    function tsOf(d) {
      if (!d) return 0;
      if (typeof d === 'string' || typeof d === 'number') return new Date(d).getTime() || 0;
      if (Array.isArray(d)) return new Date(d[0], (d[1] || 1) - 1, d[2] || 1, d[3] || 0, d[4] || 0, d[5] || 0).getTime();
      return 0;
    }
    fetch(apiBase + '/api/sessions', { headers: authH })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.code === 0 && Array.isArray(j.data)) {
          j.data.forEach(function (rs) {
            if (!rs || !rs.id) return;
            var ts = tsOf(rs.lastActiveAt) || now();
            if (state.sessions[rs.id]) {
              state.sessions[rs.id].title = rs.title || state.sessions[rs.id].title;
              state.sessions[rs.id].lastActiveAt = Math.max(state.sessions[rs.id].lastActiveAt || 0, ts);
            } else {
              state.sessions[rs.id] = newSessionObj(rs.id, rs.title || '后端会话');
              state.sessions[rs.id].lastActiveAt = ts;
            }
          });
        }
        return fetch(apiBase + '/api/sessions/active', { headers: authH });
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var remoteSid = (j && j.data && j.data.sessionId) || '';
        var cur = state.currentSessionId;
        if (cur && !/^s_/.test(cur) && state.sessions[cur]) return;
        var picked = '';
        if (remoteSid && state.sessions[remoteSid]) picked = remoteSid;
        else {
          var remotes = Object.keys(state.sessions)
            .filter(function (k) { return !/^s_/.test(k); })
            .map(function (k) { return state.sessions[k]; })
            .sort(function (a, b) { return (b.lastActiveAt || 0) - (a.lastActiveAt || 0); });
          if (remotes.length) picked = remotes[0].id;
        }
        if (!picked) return;
        state.currentSessionId = picked;
        if (!state.sessions[picked].messages.length) {
          state.sessions[picked].title = state.sessions[picked].title || '后端会话';
        }
        persist();
        if (typeof renderSession === 'function') renderSession();
      }).catch(function () {});
  }
  function init() {
    if (window[MARKER]) return;
    window[MARKER] = 1;
    setToolsFromConfig();
    renderBall();
    // v0.4.25 hotfix: 右抽屉 DOM 在 renderPanel() 内部 append（与 sessDrawer 同模式），init 不再单独注入
    // v0.4.25: IME 守卫 — Esc 在中文/日文输入法 composition 期间不应关闭抽屉
    // 设计 doc §3.3 + Council P2 采纳。
    var isComposing = false;
    document.addEventListener('compositionstart', function () { isComposing = true; });
    document.addEventListener('compositionend', function () { isComposing = false; });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && rightDrawerOpen && !isComposing) {
        e.preventDefault();
        closeRightDrawer();
      }
    });
    // v0.4.26 hotfix (review P1-3 重写)：双向 click-outside-to-close。
    // 原 review fix 的 `panel.contains(target) && target === panel` 是死代码（用户极少精确
    // 点 panel 本体；panel 之外又因 `contains` 为 false 走不进分支）。改为规范化语义：
    //   1) drawer 打开时，click 不在 drawer 子树内 → closeDrawer（点 chat 区即关）
    //   2) panel 打开时，click 不在 panel 子树内 → closePanel（点 drawer/ball/blog 区即关）
    // 守卫：①IME composition 期间不关（防止中文输入法 commit 时误关）
    //      ②target 是 TEXTAREA / INPUT / contentEditable 时不关（用户正在输入）
    //      ③ball listener 自己管 open，不去关它（target=ball 时 panel.contains(ball)=true 不进 close 分支）
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || t === document || t === document.documentElement) return;
      if (isComposing) return;
      var tag = t.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || t.isContentEditable) return;
      // v0.4.26.1 hotfix (rev3): 排除 ball 区域。ball 与 panel 都是 .hxa-root 的子节点（兄弟关系），
      // 所以 panel.contains(ball) === false，否则 click ball 会触发：
      //   ball listener 111 open() → state.open=true → click bubbles → handler 立刻 close()
      //   形成 open→immediately-close 的死循环，用户看到「点 ball 啥也不发生」。
      // ball 自己管 open（line 111 listener），不能被 click-outside 关。
      if (ball && (t === ball || ball.contains(t))) return;
      // v0.4.26.1 hotfix (rev4): 排除 drawer 触发按钮（.hxa-head__btn）。
      // user/list 按钮 onclick 触发 drawer open，同一 click bubble 到 document：
      //   rightDrawerOpen=false → true, drawer.classList.add('open') [target phase]
      //   bubble 到 document → click-outside 看到 rightDrawerOpen=true + panel.contains(btn)=true
      //   + !rightDrawer.contains(btn)=true（btn 在 panel.head 不在 rightDrawer 子树）
      //   → 立刻 closeRightDrawer()，造成「点 user-btn 弹一下立刻收」。
      // 检查 t 是否 .hxa-head__btn 内，是就跳过 drawer 自动关。
      var isHeadBtn = t.closest && t.closest('.hxa-head__btn');

      // 对话历史列表面板（左抽屉）打开时，点 panel 内但 sessDrawer 外 → 关闭左抽屉
      // user 反馈：移动端希望「点对话窗口区收起面板」，三个面板（左右抽屉 + 对话窗口）对称关闭。
      // 注意：sessDrawer 是 panel 子元素（renderPanel line 229），所以点 panel.contains(t) 时
      // 命中，但需排除点 sessDrawer 内部（toggle + × button 自己处理）。
      if (sessDrawer && sessDrawer.getAttribute('data-open') === '1' &&
          panel && panel.contains(t) && !sessDrawer.contains(t) && !isHeadBtn) {
        sessDrawer.removeAttribute('data-open');
        return;  // 一次 click 只关一个面板
      }
      // 用户面板（右抽屉）打开时，点 chat 区（panel 内但 drawer 外）→ 关闭右抽屉
      if (rightDrawerOpen && rightDrawer && panel && panel.contains(t) && !rightDrawer.contains(t) && !isHeadBtn) {
        closeRightDrawer();
        return;
      }
      // 对话窗口 (panel) 打开时，点 panel 外 → 关 panel
      if (state.open) {
        if (panel && !panel.contains(t)) {
          close();
        }
      }
    });
    repositionBall();
    var resizeT = null;
    window.addEventListener('resize', function () { clearTimeout(resizeT); resizeT = setTimeout(repositionBall, 80); });
 // v0.4.4.3: 先拉 historyList，完成后选最新后端 session；无后端且无当前才创 s_
 var isColdStart = Object.keys(state.sessions).filter(function (k) { return !/^s_/.test(k); }).length === 0;
 loadHistoryList({ includeMessages: isColdStart }).then(function () {
    _initReady = true;
    // v0.4.6: 冷启动绝不自动选 session——保持 currentSessionId=''
    // 用户必须：①手动点"+"新建 或 ②在历史列表点选 → 才会设置 currentSessionId
    // loadHistoryList 仍加载列表（用于抽屉显示），但 currentSessionId 保持空
    // 防止"登录时后端自动建的 session 幽灵般出现"
    if (typeof renderSession === 'function') renderSession();
    if (!isColdStart) prefetchStaleSessions();
 });
    if (typeof window.marked !== 'function' && config().mode === 'real') {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js';
      s.async = true; s.onerror = function () {};
      document.head.appendChild(s);
    }
    // v0.4.26.1 hotfix (rev2): hexo theme 没 inline load agent-common.js，
    // mode=real + 无 token 时 open() 调 showLogin 走 console.warn fallback，
    // panel 不弹、也不 showLogin 弹窗（用户看不到任何反馈）。
    // 修复：init 末尾 dyn-inject agent-common.js（init 比 click 早，足够早的同步插入）。
    if (typeof window.HexoAgentCommon === 'undefined') {
      var ac = document.createElement('script');
      ac.src = '/js/agent-common.js';
      ac.async = false;  // 旧 spec 但仍 work：保证下完再触发后续 click 事件
      ac.onerror = function () { console.warn('[hexo-agent] agent-common.js load failed'); };
      document.head.appendChild(ac);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.HexoAgent = { open: open, close: close, toggle: toggle, send: send, configure: configure, getState: getState, _state: state, _config: config };
})();
