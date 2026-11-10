/**
 * 页内关键字高亮与移动端菜单开合。
 *
 * 检索入口已迁移到 search-panel.js；本文件只保留高亮四件套与 mobileBtn，
 * 供文章页内联 onclick（scrollToHighlight / mobileBtn）与 search-panel 落地跳转使用。
 */

// ---------- 全局状态 ----------
window.currentHighlightIndex = -1;
window.highlightCount = 0;

// ---------- 文章内关键字高亮 ----------

// 就地拆掉高亮标记：不能走 innerHTML 重写，那会重建 .post-content 整棵子树，
// 让 code-copy.js 给 .copy-btn 绑的 click 监听与 MathJax 渲染节点一起丢掉。
function unwrapMarks(content) {
  if (!content) return;
  const parents = new Set();
  content.querySelectorAll('mark').forEach(function (mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parents.add(parent);
  });
  parents.forEach(function (parent) {
    if (parent.normalize) parent.normalize();
  });
}

function highlightPostContent(keyword) {
  const content = document.querySelector('.post-content');
  if (!content) return false;

  unwrapMarks(content);

  const needles = Array.isArray(keyword)
    ? keyword
    : (keyword == null ? [] : [keyword]);
  const cleaned = needles.map(function (k) { return String(k || '').trim(); }).filter(Boolean);
  if (!cleaned.length) return false;

  // 长词优先，避免短词先切碎长词
  const sorted = cleaned.slice().sort(function (a, b) { return b.length - a.length; });
  const escaped = sorted.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  const regex = new RegExp('(' + escaped.join('|') + ')', 'gi');

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach(function (node) {
    if (!regex.test(node.nodeValue)) { regex.lastIndex = 0; return; }
    regex.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    node.nodeValue.split(regex).forEach(function (text, i) {
      if (i % 2 === 1) {
        const mark = document.createElement('mark');
        mark.textContent = text;
        fragment.appendChild(mark);
      } else {
        fragment.appendChild(document.createTextNode(text));
      }
    });
    node.parentNode.replaceChild(fragment, node);
  });

  return true;
}

// 落地高亮：读 ?sq= → 高亮 → 把下标设到目标小节内第一个 mark
function initHighlightFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sq = params.get('sq');
  if (!sq) return;
  const keywords = sq.split(/\s+/).filter(Boolean);
  if (!highlightPostContent(keywords)) return;
  const marks = Array.prototype.slice.call(document.querySelectorAll('.post-content mark'));
  let idx = 0;
  const hash = window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : '';
  if (hash) {
    const target = document.getElementById(hash);
    if (target) {
      // 小节正文是标题的兄弟节点，不是子节点：取文档顺序里标题之后的第一个 mark
      const first = marks.findIndex(function (m) {
        return (target.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      });
      if (first >= 0) idx = first;
      // 不做二次滚动对齐：本站文章带懒加载图片，布局在 load 后仍在变，
      // 强行 scrollIntoView 会被随后的布局位移抵消；原生锚点滚动已把目标小节带进视口首屏
    }
  }
  window.currentHighlightIndex = idx;
  updateHighlightCount();
}

function getHighlights() {
  const content = document.querySelector('.post-content');
  return content ? content.querySelectorAll('mark') : [];
}

function scrollToHighlight(index, smooth = true) {
  const highlights = getHighlights();
  if (highlights.length === 0) return;

  if (index < 0) index = highlights.length - 1;
  if (index >= highlights.length) index = 0;

  window.currentHighlightIndex = index;
  highlights[index].scrollIntoView({
    behavior: smooth ? 'smooth' : 'auto',
    block: 'center'
  });

  updateHighlightCount();
}

// 关闭高亮：摘掉全部 mark、收起「第 N/M 处」浮条，并去掉 URL 上的 ?sq（刷新不再重新标）
function clearHighlights() {
  const content = document.querySelector('.post-content');
  unwrapMarks(content);
  window.currentHighlightIndex = -1;
  window.highlightCount = 0;
  const nav = document.getElementById('highlight-nav');
  if (nav) nav.style.display = 'none';
  const url = new URL(window.location.href);
  if (url.searchParams.has('sq')) {
    url.searchParams.delete('sq');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}

function updateHighlightCount() {
  const highlights = getHighlights();
  window.highlightCount = highlights.length;
  const nav = document.getElementById('highlight-nav');
  if (nav) {
    const countEl = nav.querySelector('.count');
    if (countEl) {
      countEl.textContent = `${window.currentHighlightIndex + 1}/${
        window.highlightCount
      }`;
    }
    nav.style.display = window.highlightCount > 0 ? 'flex' : 'none';
  }
}

// ---------- 移动端菜单开合（模板里是 onclick="mobileBtn()"） ----------

function mobileBtn() {
  var toggleMenu = document.getElementsByClassName('menu-toggle')[0];
  var mobileMenu = document.getElementById('mobile-menu');
  if (!toggleMenu || !mobileMenu) return;

  if (toggleMenu.classList.contains('active')) {
    toggleMenu.classList.remove('active');
    mobileMenu.classList.remove('active');
  } else {
    toggleMenu.classList.add('active');
    mobileMenu.classList.add('active');
  }
}

// ---------- 导出到 window ----------
window.highlightPostContent = highlightPostContent;
window.getHighlights = getHighlights;
window.scrollToHighlight = scrollToHighlight;
window.updateHighlightCount = updateHighlightCount;
window.mobileBtn = mobileBtn;
window.initHighlightFromUrl = initHighlightFromUrl;
window.clearHighlights = clearHighlights;

// ---------- 初始化 ----------
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHighlightFromUrl);
} else {
  initHighlightFromUrl();
}