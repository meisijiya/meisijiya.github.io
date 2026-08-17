(function () {
  'use strict';
  var s = document.currentScript || document.querySelector('script#hexo-agent');
  var d = s ? s.dataset : {};
  var base = (s && s.src ? s.src.replace(/embed\.js.*$/, '') : '/agent/');
  var mode = d.mode || 'mock';
  var cfg = {
    apiBase: d.api || '',
    mode: mode,
    title: d.title || 'AI 助手',
    subtitle: d.subtitle || '基于博客知识库，可联网与思考',
    position: d.position || 'right',
    enableWebsearch: d.websearch !== 'off',
    enableKnowledge: d.knowledge !== 'off'
  };
  // v0.4.25: 字体预连接 — 提前建立到 jsDelivr 的 TCP/TLS 通道，
  // 把霞鹜文楷 WOFF2 的 RTT 从 ~300ms 降到 ~50ms（设计 doc §3.2 / P0-3 采纳）。
  // review P1-2 fix: 追加 <link rel=preload as=font> 把字体文件本体也并行拉，
  // 消除"预连接完再发请求"的第二次 RTT（spec §3.2 second RTT 优化）。
  // 注：完整 CJK subset 实际 ~1MB（设计 doc 估计 < 50KB 不切实际，CJK 基本区 6700+ 字
  // 物理下限），靠 unicode-range + font-display:swap 让浏览器只在 CJK 字符出现时下载，
  // 且不阻塞首屏渲染（fallback 到系统楷体/衬线）。
  function injectFontPreconnects() {
    var hosts = [
      { url: 'https://cdn.jsdelivr.net', cross: false },
      { url: 'https://fonts.gstatic.com', cross: true }
    ];
    hosts.forEach(function (h) {
      var l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = h.url;
      if (h.cross) l.crossOrigin = 'anonymous';
      l.setAttribute('data-hxa', 'preconnect');
      document.head.appendChild(l);
    });
    // preload 主字体文件（与 agent.css @font-face src 一致）
    var p = document.createElement('link');
    p.rel = 'preload';
    p.as = 'font';
    p.type = 'font/woff2';
    p.href = 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/files/lxgwwenkai-regular-subset-4.woff2';
    p.crossOrigin = 'anonymous';
    p.setAttribute('data-hxa', 'preload-font');
    document.head.appendChild(p);
  }
  function load(href, cb) {
    if (mode === 'real' && /mock\.js$/.test(href)) return cb();
    var el = document.createElement('link');
    if (/\.js$/.test(href)) {
      el = document.createElement('script');
      el.src = href;
      el.async = false;
    } else {
      el.rel = 'stylesheet';
      el.href = href;
    }
    el.onload = cb;
    el.onerror = cb;
    document.head.appendChild(el);
  }
  injectFontPreconnects();
  load(base + 'agent.css', function () {
    load(base + 'agent-common.js', function () {
      if (mode === 'mock') load(base + 'mock.js', function () { load(base + 'agent.js', function () {}); });
      else load(base + 'agent.js', function () {});
    });
  });
  window.HexoAgentConfig = cfg;
})();
