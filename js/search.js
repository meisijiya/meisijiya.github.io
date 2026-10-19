/**
 * 站内搜索：懒加载 search.xml 索引 + 结果渲染 + 文章内关键字高亮。
 *
 * 本文件由 header.ejs 以 <script src="..." defer> 引入。
 * 模板里的 onclick / oninput 内联属性是在全局作用域求值的，
 * 因此凡是被这些属性调用的函数都必须显式挂到 window 上（见文件末尾的导出块）。
 *
 * search.xml 体积不小（MB 级），改为懒加载：只有用户首次点击搜索图标
 * 或聚焦搜索输入框时才真正拉取，页面首屏不再为不搜索的访客付出这份开销。
 */

// ---------- 全局状态（走 window，内联属性需要读 currentHighlightIndex） ----------

window.searchData = [];
window.currentSearchKeyword = '';
window.currentHighlightIndex = -1;
window.highlightCount = 0;

// 索引是否已加载 / 正在加载中的 promise
var searchIndexLoaded = false;
var searchIndexLoading = null;

// ---------- 懒加载搜索索引 ----------

/**
 * 读取搜索索引路径。config.root 由 EJS 渲染在 .search-container 的
 * data-root 上（外链 JS 拿不到模板变量，只能从 DOM 读）。
 */
function searchIndexUrl() {
  var container = document.querySelector('.search-container');
  var root = container && container.dataset ? container.dataset.root : '';
  return (root || '/') + 'search.xml';
}

/**
 * 确保 search.xml 已加载并解析完成。重复调用不会重复发请求：
 * 已加载直接 resolve，进行中复用同一个 promise，失败后允许下次交互重试。
 */
function ensureSearchDataLoaded() {
  if (searchIndexLoaded) return Promise.resolve();
  if (searchIndexLoading) return searchIndexLoading;

  searchIndexLoading = fetch(searchIndexUrl())
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function (xmlText) {
      var xml = new DOMParser().parseFromString(xmlText, 'text/xml');
      var entries = xml.getElementsByTagName('entry');
      var data = [];
      for (var entry of entries) {
        data.push({
          title: entry.getElementsByTagName('title')[0]?.textContent || '',
          content: entry.getElementsByTagName('content')[0]?.textContent || '',
          url: entry.getElementsByTagName('url')[0]?.textContent || ''
        });
      }
      window.searchData = data;
      searchIndexLoaded = true;
    })
    .catch(function (err) {
      // 失败不抛未捕获异常，只记日志并放开后续重试
      searchIndexLoading = null;
      console.error('Failed to load search data:', err);
    });

  return searchIndexLoading;
}

/** 在首次交互时触发懒加载：点击搜索图标 / 聚焦搜索输入框 */
function bindSearchInteractions() {
  var icons = document.querySelectorAll('.search-icon-btn');
  icons.forEach(function (icon) {
    icon.addEventListener('click', function () {
      ensureSearchDataLoaded();
    });
  });

  var inputs = document.querySelectorAll('.nav-search-input');
  inputs.forEach(function (input) {
    // focusin 会冒泡，比 focus 好用
    input.addEventListener('focusin', function () {
      ensureSearchDataLoaded();
    });
  });
}

// ---------- 搜索框开合与外部点击 ----------

function toggleSearchInput() {
  const inputs = document.querySelectorAll('.nav-search-input');
  const results = document.querySelectorAll('.nav-search-result');
  inputs.forEach((input) => {
    input.classList.toggle('active');
    if (input.classList.contains('active')) {
      input.focus();
      ensureSearchDataLoaded();
    }
  });
  results.forEach((r) => (r.style.display = 'none'));
}

/**
 * 点击搜索区域之外才关闭搜索框。
 * 判据只有一个：点击目标是否落在该 .search-container 内部。
 * 早期版本只把「输入框」和「图标 <a>」算作区域内目标，
 * 结果 .clear-search 按钮被判成外部点击，点一下 × 搜索框就整个关掉。
 */
function handleClickOutsideSearch(event) {
  const searchContainers = document.querySelectorAll('.search-container');
  searchContainers.forEach((container) => {
    if (container.contains(event.target)) return;

    const searchInput = container.querySelector('.nav-search-input');
    if (searchInput) searchInput.classList.remove('active');

    // 每个容器各取自己的结果容器；保留搜索结果与输入内容，仅隐藏下拉框
    const resultContainer = container.querySelector('.nav-search-result');
    if (resultContainer) resultContainer.style.display = 'none';
  });
}

// ---------- 搜索与结果渲染 ----------

/** 输入框所在容器内的结果下拉容器 */
function getResultContainer(inputElement) {
  var container = inputElement.closest('.search-container');
  return container ? container.querySelector('.nav-search-result') : null;
}

/** 按当前关键字渲染结果下拉 */
function renderResults(inputElement) {
  const resultContainer = getResultContainer(inputElement);
  if (!resultContainer) return;

  const keyword = inputElement.value.trim().toLowerCase();
  resultContainer.innerHTML = '';

  if (!keyword) {
    resultContainer.style.display = 'none';
    return;
  }

  resultContainer.style.display = 'block';

  const results = window.searchData.filter(
    (data) =>
      (data.title && data.title.toLowerCase().includes(keyword)) ||
      (data.content && data.content.toLowerCase().includes(keyword))
  );

  if (results.length === 0) {
    resultContainer.innerHTML =
      '<p class="no-result">没有结果哟，换个关键词试试吧</p>';
    return;
  }

  const maxResults = 10;
  const limitedResults = results.slice(0, maxResults);

  const html = limitedResults
    .map((item) => {
      // 提取包含关键字的内容片段
      let contentSnippet = '';
      if (item.content) {
        // 找到包含关键字的内容片段
        const contentLower = item.content.toLowerCase();
        const keywordIndex = contentLower.indexOf(keyword);

        // 提取关键字前后的内容
        const start = Math.max(0, keywordIndex - 3 * keyword.length);
        const end = Math.min(
          item.content.length,
          keywordIndex + 3 * keyword.length
        );
        contentSnippet = item.content.substring(start, end);

        // 高亮关键字
        const keywordRegex = new RegExp(
          `(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`,
          'gi'
        );
        contentSnippet = contentSnippet.replace(
          keywordRegex,
          '<mark>$1</mark>'
        );
      }

      return `<div class="search-result-item">
  <a href="${item.url}">
    <div>标题：${item.title}</div>
    <div>内容：${contentSnippet}</div>
  </a>
</div>`;
    })
    .join('');
  resultContainer.innerHTML = html;
}

/** 导航搜索：渲染下拉 + 文章内高亮 */
function navSearch(inputElement) {
  const keyword = inputElement.value.trim().toLowerCase();
  window.currentSearchKeyword = keyword;

  // 文章内高亮不依赖索引，可以立即执行
  highlightPostContent(keyword);
  updateHighlightCount();

  if (searchIndexLoaded) {
    renderResults(inputElement);
    return;
  }

  // 索引还在路上：先收起下拉（此时搜索必然「无结果」，展示会误导），
  // 加载完成后用输入框里已有的内容补渲染一次
  const pendingContainer = getResultContainer(inputElement);
  if (pendingContainer) {
    pendingContainer.innerHTML = '';
    pendingContainer.style.display = 'none';
  }
  if (keyword) {
    ensureSearchDataLoaded().then(function () {
      // 加载期间用户可能已经换了关键字或关掉了框，渲染前以当前值为准
      if (searchIndexLoaded) renderResults(inputElement);
    });
  }
}

/** 清除搜索：清空输入框、刷新结果，并让输入框重新获得焦点 */
function clearSearch(btn) {
  var container = btn.closest('.search-container');
  var input = container
    ? container.querySelector('.nav-search-input')
    : btn.parentNode.querySelector('.nav-search-input');
  if (!input) return;

  input.value = '';
  navSearch(input);
  input.focus();
}

// ---------- 文章内关键字高亮 ----------

function highlightPostContent(keyword) {
  const content = document.querySelector('.post-content');
  if (!content) return false;

  content.innerHTML = content.innerHTML.replace(/<\/?mark>/g, '');

  if (!keyword) return false;

  const walker = document.createTreeWalker(
    content,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const escaped = keyword.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');

  textNodes.forEach(function (node) {
    if (!regex.test(node.nodeValue)) return;
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
// 模板内联属性（onclick / oninput）在全局作用域求值，
// 顶层 function 声明虽已是全局对象属性，这里再显式挂一次，
// 保证任何打包/包裹方式下 window.navSearch === navSearch 都成立。

window.toggleSearchInput = toggleSearchInput;
window.handleClickOutsideSearch = handleClickOutsideSearch;
window.navSearch = navSearch;
window.clearSearch = clearSearch;
window.renderResults = renderResults;
window.highlightPostContent = highlightPostContent;
window.getHighlights = getHighlights;
window.scrollToHighlight = scrollToHighlight;
window.updateHighlightCount = updateHighlightCount;
window.mobileBtn = mobileBtn;
window.ensureSearchDataLoaded = ensureSearchDataLoaded;

// ---------- 初始化 ----------

function initSearch() {
  document.addEventListener('click', handleClickOutsideSearch);
  bindSearchInteractions();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSearch);
} else {
  // 本文件以 defer 引入，正常不会走到这里；留着兼容被当作普通脚本注入的情况
  initSearch();
}
