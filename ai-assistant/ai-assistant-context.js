/*
 * 页面上下文提取
 *
 * 助手回答时不需要整篇正文，只需要「用户当前读到的那一节」。
 * 这里把正文 DOM 切成小节：一个小节 = 一个标题 + 它下面直到同级或更高级标题之间的内容。
 * 标题 id 由 hexo-renderer-marked 生成（中文 slug 原样保留），可直接用于锚点定位。
 *
 * 渐进式阅读：父标题的正文里混着子标题的正文，整节灌给模型既费 token 又容易看错归属。
 * 所以正文被拆成两层：直属正文（ownText，只到下一个标题为止）和直接子标题（children）。
 * 要更深的内容，就按 children 一层层往下取，任何一层都不含子层的正文。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
    var listeners = [];
    var headings = [];
    var currentId = null;
    var scrollTick = false;

    function root() {
        return document.querySelector('.post-content');
    }

    function articleTitle() {
        var el = document.querySelector('.post-title') || document.querySelector('h1');
        return el ? el.textContent.trim() : '';
    }

    /*
     * 从任意容器里取标题清单：当前页面与抓回来的别的文章共用同一套切分逻辑，
     * 免得两条路径各写一套、语义悄悄分叉。
     */
    function collectFrom(container) {
        if (!container) return [];
        var nodes = container.querySelectorAll(HEADING_SELECTOR);
        var list = [];
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var text = (node.textContent || '').trim();
            if (!text) continue;
            list.push({
                id: node.id || '',
                text: text,
                level: parseInt(node.tagName.charAt(1), 10),
                index: list.length,
                node: node
            });
        }
        return list;
    }

    function collect() {
        headings = collectFrom(root());
    }

    /* 标题路径：文章标题 + 上级标题链 + 当前标题 */
    function pathOfList(list, index, article) {
        var chain = [];
        for (var i = index - 1; i >= 0; i--) {
            if (list[i].level < list[index].level) {
                chain.unshift(list[i]);
            }
        }
        var trail = [];
        if (article) trail.push(article);
        for (var j = 0; j < chain.length; j++) trail.push(chain[j].text);
        trail.push(list[index].text);
        return trail;
    }

    function pathOf(index) {
        return pathOfList(headings, index, articleTitle());
    }

    /* 一个标题到下一个同级或更高级标题之间的范围 */
    function rangeOfList(list, index) {
        var start = list[index];
        var end = list.length;
        for (var i = index + 1; i < list.length; i++) {
            if (list[i].level <= start.level) {
                end = i;
                break;
            }
        }
        return { start: index, end: end };
    }

    function sectionRange(index) {
        return rangeOfList(headings, index);
    }

    /*
     * 取两个节点之间的正文。只认兄弟节点，所以不能拿当前页面的容器来判断：
     * 抓回来的文章有自己的 DOM，得按它自己的节点走。
     */
    function elementText(startNode, endNode) {
        if (!startNode) return '';
        var parts = [];
        var node = startNode.nextSibling;
        while (node && node !== endNode) {
            if (node.nodeType === 1) {
                var tag = node.tagName.toLowerCase();
                if (tag !== 'script' && tag !== 'style') {
                    parts.push((node.textContent || '').trim());
                }
            }
            node = node.nextSibling;
        }
        return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    /* 直属正文：只到下一个标题为止，子标题的正文一律不算自己的 */
    function ownTextOfList(list, index) {
        var next = index + 1 < list.length ? list[index + 1].node : null;
        return elementText(list[index].node, next);
    }

    /* 某个标题的最近祖先：层级被跳过时也不会把内容落到没人管的死角 */
    function ancestorIndex(list, index) {
        for (var k = index - 1; k >= 0; k--) {
            if (list[k].level < list[index].level) return k;
        }
        return -1;
    }

    /* 直接子标题：最近祖先是我就算直接子级，只要标题本身，不要正文 */
    function childrenOfList(list, index) {
        var range = rangeOfList(list, index);
        var children = [];
        for (var j = index + 1; j < range.end; j++) {
            if (ancestorIndex(list, j) === index) {
                children.push({ id: list[j].id, title: list[j].text, level: list[j].level });
            }
        }
        return children;
    }

    /* 目录：只有标题 */
    function outlineOfList(list) {
        var items = [];
        for (var i = 0; i < list.length; i++) {
            items.push({ id: list[i].id, title: list[i].text, level: list[i].level });
        }
        return items;
    }

    function outlineOf(container) {
        return outlineOfList(collectFrom(container));
    }

    function outline() {
        return outlineOfList(headings);
    }

    /* 一个小节的细粒度视图：直属正文 + 直接子标题 */
    function detailOfList(list, index, article) {
        return {
            id: list[index].id,
            title: list[index].text,
            level: list[index].level,
            path: pathOfList(list, index, article),
            ownText: ownTextOfList(list, index),
            children: childrenOfList(list, index)
        };
    }

    function indexOfId(list, id) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return i;
        }
        return -1;
    }

    function sectionOutline(id) {
        var index = indexOfId(headings, id);
        if (index < 0) return null;
        return detailOfList(headings, index, articleTitle());
    }

    function sectionOutlineOf(container, id, article) {
        var list = collectFrom(container);
        var index = indexOfId(list, id);
        if (index < 0) return null;
        return detailOfList(list, index, article);
    }

    function sectionById(id) {
        for (var i = 0; i < headings.length; i++) {
            if (headings[i].id === id) return sectionAt(i);
        }
        return null;
    }

    function sectionAt(index) {
        if (!headings[index]) return null;
        var range = sectionRange(index);
        var startNode = headings[index].node;
        var endNode = range.end < headings.length ? headings[range.end].node : null;
        return {
            id: headings[index].id,
            title: headings[index].text,
            level: headings[index].level,
            path: pathOf(index),
            text: elementText(startNode, endNode)
        };
    }

    /* 视口中间线之上最后一个标题，就是当前读到的小节 */
    function detectCurrent() {
        if (!headings.length) return;
        var container = root();
        if (!container) return;
        var nodes = container.querySelectorAll(HEADING_SELECTOR);
        var line = window.innerHeight * 0.35;
        var found = null;
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].getBoundingClientRect().top <= line) {
                found = headings[i].id;
            } else {
                break;
            }
        }
        // 读者还在文章开头、第一个标题都还没越过视线线时，
        // 「当前小节」取第一节，而不是显示成没有定位到
        if (!found) found = headings[0].id;
        if (found === currentId) return;
        currentId = found;
        for (var j = 0; j < listeners.length; j++) {
            try {
                listeners[j](currentId);
            } catch (e) {
                /* 单个监听器出错不能拖垮上下文跟踪 */
            }
        }
    }

    function onScroll() {
        if (scrollTick) return;
        scrollTick = true;
        window.requestAnimationFrame(function () {
            scrollTick = false;
            detectCurrent();
        });
    }

    function currentSection() {
        if (!currentId) detectCurrent();
        return currentId ? sectionById(currentId) : null;
    }

    function selection() {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
        var text = (sel.toString() || '').trim();
        if (!text) return null;
        var node = sel.anchorNode;
        var el = node && node.nodeType === 1 ? node : node && node.parentElement;
        var sectionId = null;
        while (el && el !== document.body) {
            if (el.tagName && /^H[1-6]$/.test(el.tagName)) {
                sectionId = el.id || null;
                break;
            }
            el = el.parentElement;
        }
        if (!sectionId) {
            var section = currentSection();
            sectionId = section ? section.id : null;
        }
        return { text: text, sectionId: sectionId };
    }

    function init() {
        collect();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll, { passive: true });
        detectCurrent();
    }

    AI.context = {
        init: init,
        articleTitle: articleTitle,
        listHeadings: function () {
            return headings.map(function (h) {
                return { id: h.id, text: h.text, level: h.level };
            });
        },
        outline: outline,
        sectionOutline: sectionOutline,
        outlineOf: outlineOf,
        sectionOutlineOf: sectionOutlineOf,
        currentSection: currentSection,
        currentSectionId: function () {
            return currentId;
        },
        sectionById: sectionById,
        sectionAt: sectionAt,
        selection: selection,
        onChange: function (cb) {
            listeners.push(cb);
        }
    };
})();
