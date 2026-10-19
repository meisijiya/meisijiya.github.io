/**
 * 图片懒加载兜底脚本。
 *
 * 与 scripts/lazy-image.js（hexo 生成期过滤器）互补：
 * - 过滤器只作用于文章正文，无法覆盖 profile / photos / 归档等页面里
 *   主题模板直接输出的 <img>，也覆盖不到改造前已生成的历史页面；
 * - 本脚本在 DOM 就绪后扫描这些遗漏的图片，补上 loading / decoding。
 *
 * 约束：
 * - 只补属性，不改尺寸、不换 src，因此不会引入 CLS，也不会触发二次布局计算；
 * - 首屏可见的头图用 loading="eager"，首屏图若懒加载会直接拖慢 LCP。
 */
(function () {
  'use strict';

  // 需要扫描的容器：文章正文与常规文章结构
  var CONTENT_SELECTOR = '.post-content img, article img';

  // 首屏可见、不应懒加载的图片：文章头图
  var EAGER_SELECTOR = '.post-header img';

  /** 首屏（视口内）的图走 eager，其余走 lazy */
  function isInViewport(img) {
    var rect = img.getBoundingClientRect();
    return rect.top < (window.innerHeight || 0) && rect.bottom > 0;
  }

  function applyLoading(img) {
    var eager = img.matches(EAGER_SELECTOR) || isInViewport(img);
    // 已有显式声明的一律尊重，不过度覆盖
    if (!img.hasAttribute('loading')) {
      img.setAttribute('loading', eager ? 'eager' : 'lazy');
    }
    if (!img.hasAttribute('decoding')) {
      img.setAttribute('decoding', 'async');
    }
  }

  function init() {
    var images = document.querySelectorAll(CONTENT_SELECTOR);
    for (var i = 0; i < images.length; i++) {
      applyLoading(images[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
