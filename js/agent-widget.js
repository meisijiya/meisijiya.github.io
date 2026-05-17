/**
 * Hexo Agent Widget (Chic Theme Edition)
 */
(function() {
    'use strict';

    const CONFIG = {
        API_BASE: 'http://localhost:8001',
        STORAGE_KEY: 'hexo-agent-widget',
        MAX_MESSAGES: 20,   // 对齐后端 HISTORY_LIMIT(5轮) × 4(含source/system消息)
        AVATAR_URL: '/images/bubu.jpeg'
    };

    const state = {
        token: null,
        sessionId: null,
        isOpen: false,
        isDragging: false,
        isProcessing: false,
        abortController: null,
        messages: [],
        position: { x: null, y: null },
        user: null  // { nickname, avatar_url }
    };

    function $(selector) { return document.querySelector(selector); }

    function saveState() {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
                token: state.token,
                sessionId: state.sessionId,
                position: state.position,
                user: state.user,
                messages: state.messages.slice(-CONFIG.MAX_MESSAGES)
            }));
        } catch (e) {}
    }

    function loadState() {
        try {
            const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
            if (saved) {
                const data = JSON.parse(saved);
                state.token = data.token || null;
                state.sessionId = data.sessionId || null;
                state.position = data.position || { x: null, y: null };
                state.user = data.user || null;
                state.messages = data.messages || [];
            }
        } catch (e) {}
    }

    function restoreMessages() {
        if (!state.messages.length) return;
        const messagesEl = $('#agentMessages');
        state.messages.forEach(function(msg) {
            const el = document.createElement('div');
            let cls = 'hexo-agent-message ' + msg.role;
            if (msg.className) cls += ' ' + msg.className;
            el.className = cls;
            el.innerHTML = (msg.role === 'assistant' && !msg.className) ? renderMarkdown(msg.content) : msg.content;
            messagesEl.appendChild(el);
        });
        setTimeout(function() {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }, 100);
    }

    // ==================== Markdown ====================
    function renderMarkdown(text) {
        if (typeof marked === 'undefined') return escapeHtml(text);
        try {
            marked.setOptions({ breaks: true, gfm: true });
            return marked.parse(text);
        } catch (e) {
            return escapeHtml(text);
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ==================== Theme ====================
    function isDarkMode() {
        return document.body.classList.contains('dark-theme') ||
               (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    function updateTheme() {
        const widget = $('.hexo-agent-widget');
        if (widget) widget.classList.toggle('dark-mode', isDarkMode());
    }

    // ==================== Bounds ====================
    function checkBounds() {
        const trigger = $('#agentTrigger');
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        const viewWidth = window.innerWidth;
        const viewHeight = window.innerHeight;
        let left = parseInt(trigger.style.left) || rect.left;
        let bottom = parseInt(trigger.style.bottom) || (viewHeight - rect.bottom);
        if (left + 56 > viewWidth) left = viewWidth - 66;
        if (left < 10) left = 10;
        if (bottom + 56 > viewHeight) bottom = viewHeight - 66;
        if (bottom < 10) bottom = 10;
        trigger.style.left = left + 'px';
        trigger.style.bottom = bottom + 'px';
        trigger.style.right = 'auto';
        state.position = { x: left + 'px', y: bottom + 'px' };
        saveState();
    }

    // ==================== API ====================
    async function apiRequest(endpoint, options = {}) {
        const url = `${CONFIG.API_BASE}${endpoint}`;
        return fetch(url, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers }
        });
    }

    async function anonymousLogin() {
        const response = await apiRequest('/api/auth/anonymous', { method: 'POST' });
        const data = await response.json();
        state.token = data.token;
        saveState();
        return data;
    }

    async function sendMessage(message) {
        state.abortController = new AbortController();
        return await apiRequest('/api/chat', {
            method: 'POST',
            body: JSON.stringify({ message, session_id: state.sessionId, token: state.token }),
            signal: state.abortController.signal
        });
    }

    function stopResponse() {
        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }
        state.isProcessing = false;
        hideTyping();
        hideAgentStatus();
        updateSendButton();
        addMessage('system', '已停止响应');
    }

    // ==================== UI ====================
    function createWidget() {
        const container = document.createElement('div');
        container.className = 'hexo-agent-widget';
        container.innerHTML = `
            <div class="hexo-agent-trigger" id="agentTrigger">
                <img src="${CONFIG.AVATAR_URL}" alt="AI" class="hexo-agent-avatar" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                <div class="hexo-agent-avatar-fallback" style="display:none">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
                </div>
            </div>
            <div class="hexo-agent-popup" id="agentPopup">
                <div class="hexo-agent-header">
                    <span class="hexo-agent-header-title">AI 助手</span>
                    <button class="hexo-agent-header-close" id="agentClose">&times;</button>
                </div>
                <div class="hexo-agent-status">
                    <span><span class="hexo-agent-status-dot" id="statusDot"></span><span id="statusText">未连接</span></span>
                    <span id="agentTypeText" class="hexo-agent-type-text" style="display:none;"></span>
                    <span id="userInfo"></span>
                </div>
                <div class="hexo-agent-messages" id="agentMessages"></div>
                <div class="hexo-agent-typing" id="agentTyping">
                    <span></span><span></span><span></span>
                    <span class="hexo-agent-status-text" id="agentStatusText" style="display:none;"></span>
                </div>
                <div class="hexo-agent-login" id="agentLogin">
                    <button class="hexo-agent-login-btn github" id="btnGithub">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
                        GitHub 登录
                    </button>
                    <button class="hexo-agent-login-btn anonymous" id="btnAnonymous">匿名体验</button>
                </div>
                <div class="hexo-agent-input-area" id="agentInputArea" style="display:none;">
                    <textarea class="hexo-agent-input" id="agentInput" placeholder="输入消息..." rows="1" disabled></textarea>
                    <button class="hexo-agent-send-btn" id="agentSend" disabled>
                        <span class="send-icon">&#10148;</span>
                        <span class="stop-icon" style="display:none">&#9632;</span>
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(container);
    }

    function showWelcome() {
        const content = `欢迎来到老江湖的 AI 助手。

**基本用法：**
- 直接提问技术问题，会优先从知识库检索
- 输入「上网搜 + 关键词」触发网络搜索
- 输入「对比/分析 + 主题」触发深度推理
- 知识库搜不到时会提示你，要不要上网搜

有问题随时问，祝你探索愉快。`;
        const messagesEl = $('#agentMessages');
        const messageEl = document.createElement('div');
        messageEl.className = 'hexo-agent-message system';
        messageEl.innerHTML = renderMarkdown(content);
        messagesEl.appendChild(messageEl);
    }

    // ==================== Messages ====================
    function addMessage(role, content, extra = {}) {
        const messagesEl = $('#agentMessages');
        const messageEl = document.createElement('div');
        let className = `hexo-agent-message ${role}`;
        if (extra.className) className += ` ${extra.className}`;
        messageEl.className = className;
        messageEl.innerHTML = (role === 'assistant' && !extra.className) ? renderMarkdown(content) : content;
        messagesEl.appendChild(messageEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        state.messages.push({ role, content, ...extra });
        saveState();
    }

    /** 添加特殊样式消息（ReAct 思考/动作/观察/回答） */
    function addSpecialMessage(className, html) {
        const messagesEl = $('#agentMessages');
        const el = document.createElement('div');
        el.className = `hexo-agent-message ${className}`;
        el.innerHTML = html;
        messagesEl.appendChild(el);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addAgentInfo(agentName, message) {
        const displayName = {
            'knowledge': '知识库',
            'search': '网络搜索',
            'react': '深度推理',
            'chat': '对话'
        }[agentName] || agentName;
        updateAgentStatus(`[${displayName}] ${message}`, agentName);
    }

    function addSources(articles) {
        let html = '<div class="sources-header">参考来源</div><ul class="hexo-agent-sources-list">';
        articles.forEach(a => {
            const name = a.name || a.relative_path || '未知';
            const score = a.score ? ` (${(a.score * 100).toFixed(0)}%)` : '';
            const blogUrl = a.blog_url || '';
            if (blogUrl && blogUrl !== 'https://meisijiya.github.io') {
                html += `<li><a href="${escapeHtml(blogUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>${score}</li>`;
            } else {
                html += `<li>${escapeHtml(name)}${score}</li>`;
            }
        });
        html += '</ul>';
        addMessage('assistant', html, { className: 'sources' });
    }

    function addSearchOptions(data) {
        let html = `<div class="hexo-agent-search-options">`;
        html += `<p>${escapeHtml(data.message)}</p>`;
        html += `<div class="hexo-agent-options-buttons">`;
        data.options.forEach(option => {
            if (option.action === 'search') {
                const searchQuery = '上网搜 ' + option.query;
                html += `<button class="hexo-agent-option-btn search" onclick="window.hexoAgentSearch('${escapeHtml(searchQuery)}')">上网搜索</button>`;
            } else if (option.action === 'done') {
                html += `<button class="hexo-agent-option-btn done" onclick="window.hexoAgentDone(this)">够了</button>`;
            }
        });
        html += `</div></div>`;
        addMessage('assistant', html, { className: 'search-options' });
    }

    function addSearchSources(data) {
        let html = `<div class="hexo-agent-search-sources">`;
        html += `<div class="sources-header">${escapeHtml(data.message)}</div>`;
        html += `<ul class="hexo-agent-sources-list">`;
        data.sources.forEach(source => {
            const title = source.title || '未知来源';
            const url = source.url || '';
            if (url) {
                html += `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></li>`;
            } else {
                html += `<li>${escapeHtml(title)}</li>`;
            }
        });
        html += `</ul></div>`;
        addMessage('assistant', html, { className: 'search-sources' });
    }

    function addKnowledgeSources(data) {
        let html = `<div class="hexo-agent-knowledge-sources">`;
        html += `<div class="sources-header">${escapeHtml(data.message)}</div>`;
        if (data.articles && data.articles.length > 0) {
            html += `<ul class="hexo-agent-sources-list">`;
            data.articles.forEach(a => {
                const name = a.name || a.relative_path || '未知';
                const score = a.score ? ` (${(a.score * 100).toFixed(0)}%)` : '';
                const blogUrl = a.blog_url || '';
                if (blogUrl && blogUrl !== 'https://meisijiya.github.io') {
                    html += `<li><a href="${escapeHtml(blogUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>${score}</li>`;
                } else {
                    html += `<li>${escapeHtml(name)}${score}</li>`;
                }
            });
            html += `</ul>`;
        }
        html += `</div>`;
        addMessage('assistant', html, { className: 'knowledge-sources' });
    }

    window.hexoAgentSearch = function(query) {
        document.querySelector('.hexo-agent-message.search-options')?.remove();
        const input = $('#agentInput');
        if (input) { input.value = query; handleSend(); }
    };

    window.hexoAgentDone = function(button) {
        const msg = button.closest('.hexo-agent-message');
        if (msg) msg.remove();
    };

    function showTyping() { $('#agentTyping').classList.add('active'); }
    function hideTyping() { $('#agentTyping').classList.remove('active'); }

    function updateAgentStatus(status, agentName) {
        const statusText = $('#agentTypeText');
        if (statusText) {
            statusText.textContent = status;
            statusText.style.display = 'inline';
            statusText.className = 'hexo-agent-type-text agent-' + agentName;
        }
    }

    function hideAgentStatus() {
        const statusText = $('#agentTypeText');
        if (statusText) {
            statusText.style.display = 'none';
        }
    }

    function updateSendButton() {
        const btn = $('#agentSend');
        if (!btn) return;
        const sendIcon = btn.querySelector('.send-icon');
        const stopIcon = btn.querySelector('.stop-icon');
        if (state.isProcessing) {
            sendIcon.style.display = 'none';
            stopIcon.style.display = 'inline';
            btn.disabled = false;
            btn.classList.add('stop-mode');
        } else {
            sendIcon.style.display = 'inline';
            stopIcon.style.display = 'none';
            btn.classList.remove('stop-mode');
            btn.disabled = !$('#agentInput').value.trim();
        }
    }

    // ==================== Login ====================
    async function handleAnonymousLogin() {
        try {
            await anonymousLogin();
            updateUI();
            showWelcome();
        } catch (error) {
            addMessage('error', '登录失败：' + error.message);
        }
    }

    function handleGithubLogin() {
        fetch(`${CONFIG.API_BASE}/api/auth/github`)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.authorize_url) {
                    var oauthWindow = window.open(data.authorize_url, 'github-oauth', 'width=600,height=700,scrollbars=yes');
                    if (!oauthWindow) {
                        addMessage('system', '请允许弹出窗口以完成 GitHub 登录');
                    }
                }
            })
            .catch(function(err) {
                addMessage('system', 'GitHub 登录失败，请稍后重试');
            });
    }

    function updateUI() {
        const isLoggedIn = !!state.token;
        $('#statusDot').classList.toggle('connected', isLoggedIn);
        $('#statusText').textContent = isLoggedIn ? '已连接' : '未连接';
        $('#agentLogin').style.display = isLoggedIn ? 'none' : 'flex';
        $('#agentInputArea').style.display = isLoggedIn ? 'flex' : 'none';
        $('#agentInput').disabled = !isLoggedIn;
        updateUserInfo();
    }

    function updateUserInfo() {
        const userInfoEl = $('#userInfo');
        if (!userInfoEl) return;
        if (state.user && state.token) {
            var avatar = state.user.avatar_url
                ? '<img src="' + state.user.avatar_url + '" class="hexo-agent-user-avatar">'
                : '<div class="hexo-agent-user-avatar-default"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg></div>';
            userInfoEl.innerHTML = '<div class="hexo-agent-user-info">' + avatar + '<span class="hexo-agent-user-name">' + escapeHtml(state.user.nickname || '') + '</span><button class="hexo-agent-logout-btn" id="btnLogout" title="退出登录">&times;</button></div>';
            $('#btnLogout').addEventListener('click', handleLogout);
        } else {
            userInfoEl.innerHTML = '';
        }
    }

    function handleLogout() {
        state.token = null;
        state.user = null;
        state.sessionId = null;
        state.messages = [];
        saveState();
        updateUI();
        addMessage('system', '已退出登录');
    }

    // ==================== Send ====================
    async function handleSend() {
        if (state.isProcessing) {
            stopResponse();
            return;
        }

        const input = $('#agentInput');
        const message = input.value.trim();
        if (!message) return;

        input.value = '';
        input.style.height = 'auto';
        addMessage('user', escapeHtml(message));

        state.isProcessing = true;
        updateSendButton();
        showTyping();

        try {
            const response = await sendMessage(message);
            await handleStreamResponse(response);
        } catch (error) {
            if (error.name === 'AbortError') {
                // User stopped
            } else {
                addMessage('error', '发送失败：' + error.message);
            }
        } finally {
            state.isProcessing = false;
            state.abortController = null;
            updateSendButton();
            hideTyping();
            hideAgentStatus();
        }
    }

    /**
     * 解析 ReAct Agent 流式文本，根据 Thought/Action/Observation/Final Answer
     * 标记将不同部分渲染为不同背景色的块
     */
    function renderReactStream(text) {
        // 如果不包含 ReAct 标记，按普通 Markdown 渲染
        if (!/Thought:|Action:|Action Input:|Observation:|Final Answer:/i.test(text)) {
            return renderMarkdown(text);
        }

        var lines = text.split('\n');
        var html = '';
        var currentSection = null;
        var currentContent = [];

        function flush() {
            if (!currentSection || currentContent.length === 0) return;
            var content = currentContent.join('\n').trim();
            if (!content) { currentContent = []; return; }

            switch (currentSection) {
                case 'thought':
                    html += '<div class="react-thought-stream">' + renderMarkdown(content) + '</div>';
                    break;
                case 'action':
                    html += '<div class="react-action-stream">🔍 ' + escapeHtml(content) + '</div>';
                    break;
                case 'action_input':
                    html += '<div class="react-input-stream">' + escapeHtml(content) + '</div>';
                    break;
                case 'observation':
                    html += '<div class="react-obs-stream">' + renderMarkdown(content) + '</div>';
                    break;
                case 'final_answer':
                    html += '<div class="react-answer-stream">' + renderMarkdown(content) + '</div>';
                    break;
                default:
                    html += renderMarkdown(content);
            }
            currentContent = [];
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^Thought:/i.test(line)) {
                flush();
                currentSection = 'thought';
                currentContent.push(line.replace(/^Thought:\s*/i, ''));
            } else if (/^Action Input:/i.test(line)) {
                flush();
                currentSection = 'action_input';
                currentContent.push(line.replace(/^Action Input:\s*/i, ''));
            } else if (/^Action:/i.test(line)) {
                flush();
                currentSection = 'action';
                currentContent.push(line.replace(/^Action:\s*/i, ''));
            } else if (/^Observation:/i.test(line)) {
                flush();
                currentSection = 'observation';
                currentContent.push(line.replace(/^Observation:\s*/i, ''));
            } else if (/^Final Answer:/i.test(line)) {
                flush();
                currentSection = 'final_answer';
                currentContent.push(line.replace(/^Final Answer:\s*/i, ''));
            } else if (currentSection) {
                currentContent.push(line);
            }
        }
        flush();

        return html || renderMarkdown(text);
    }

    async function handleStreamResponse(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let assistantMessage = '';
        let messageEl = null;
        let buffer = '';
        let pendingEvent = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line) continue;
                if (line.startsWith('event: ')) {
                    pendingEvent = line.slice(7).trim();
                } else if (line.startsWith('data: ')) {
                    const eventType = pendingEvent;
                    pendingEvent = null;
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (eventType) {
                            if (eventType === 'routing') {
                                hideTyping();
                                addAgentInfo(data.agent || data.agent_name || 'AI', data.message);
                                showTyping();
                            } else if (eventType === 'sources') {
                                addSources(data.articles);
                            } else if (eventType === 'search_options') {
                                addSearchOptions(data);
                            } else if (eventType === 'knowledge_sources') {
                                addKnowledgeSources(data);
                            } else if (eventType === 'search_sources') {
                                addSearchSources(data);
                            } else if (eventType === 'react_action') {
                                showTyping();
                            } else if (eventType === 'react_search_results') {
                                // 搜索结果由 react_formatted.tools 统一渲染
                            } else if (eventType === 'react_formatted') {
                                hideTyping();

                                let finalHtml = '';
                                if (data.tools && data.tools.length > 0) {
                                    finalHtml += '<div class="react-tool-group">';
                                    data.tools.forEach(function(tool) {
                                        finalHtml += '<div class="react-tool-action">🔍 调用工具: ' + escapeHtml(tool.action) + '</div>';
                                        if (tool.sources && tool.sources.length > 0) {
                                            finalHtml += '<div class="react-tool-sources">';
                                            finalHtml += '<div class="sources-header">🔍 找到 ' + tool.sources.length + ' 条搜索结果</div>';
                                            finalHtml += '<ul class="hexo-agent-sources-list">';
                                            tool.sources.forEach(function(source) {
                                                var title = source.title || '未知来源';
                                                var url = source.url || '';
                                                if (url) {
                                                    finalHtml += '<li><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(title) + '</a></li>';
                                                } else {
                                                    finalHtml += '<li>' + escapeHtml(title) + '</li>';
                                                }
                                            });
                                            finalHtml += '</ul></div>';
                                        }
                                    });
                                    finalHtml += '</div>';
                                }
                                if (data.thought) {
                                    finalHtml += '<div class="react-thought">' + renderMarkdown(data.thought) + '</div>';
                                }

                                var formattedEl = document.createElement('div');
                                formattedEl.className = 'hexo-agent-message assistant';
                                formattedEl.innerHTML = finalHtml;
                                if (messageEl && messageEl.parentNode) {
                                    messageEl.parentNode.insertBefore(formattedEl, messageEl);
                                } else {
                                    $('#agentMessages').appendChild(formattedEl);
                                }
                                $('#agentMessages').scrollTop = $('#agentMessages').scrollHeight;
                                state.messages.push({ role: 'assistant', content: data.answer, className: 'react-formatted' });
                                saveState();
                            } else if (eventType === 'done') {
                                state.sessionId = data.session_id;
                                saveState();
                                hideAgentStatus();
                            }
                        } else if (data.content) {
                            if (!messageEl) {
                                hideTyping();
                                messageEl = document.createElement('div');
                                messageEl.className = 'hexo-agent-message assistant';
                                $('#agentMessages').appendChild(messageEl);
                            }
                            assistantMessage += data.content;
                            messageEl.innerHTML = renderReactStream(assistantMessage);
                            $('#agentMessages').scrollTop = $('#agentMessages').scrollHeight;
                        }
                    } catch (e) {}
                }
            }
        }
        // 流式结束后保存 assistant 回复到 state
        if (assistantMessage) {
            state.messages.push({ role: 'assistant', content: assistantMessage });
            saveState();
        }
    }

    // ==================== Drag ====================
    function initDrag() {
        const trigger = $('#agentTrigger');
        let startX, startY, startLeft, startBottom;

        trigger.addEventListener('mousedown', (e) => {
            state.isDragging = true;
            trigger.classList.add('dragging');
            startX = e.clientX;
            startY = e.clientY;
            startLeft = trigger.offsetLeft;
            startBottom = window.innerHeight - trigger.offsetTop - trigger.offsetHeight;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!state.isDragging) return;
            const newLeft = startLeft + (e.clientX - startX);
            const newBottom = startBottom - (e.clientY - startY);
            trigger.style.left = Math.max(0, Math.min(newLeft, window.innerWidth - 56)) + 'px';
            trigger.style.bottom = Math.max(0, Math.min(newBottom, window.innerHeight - 56)) + 'px';
            trigger.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (!state.isDragging) return;
            state.isDragging = false;
            trigger.classList.remove('dragging');
            state.position = { x: trigger.style.left, y: trigger.style.bottom };
            saveState();
        });
    }

    function restorePosition() {
        if (state.position.x && state.position.y) {
            const trigger = $('#agentTrigger');
            trigger.style.left = state.position.x;
            trigger.style.bottom = state.position.y;
            trigger.style.right = 'auto';
            setTimeout(checkBounds, 100);
        }
    }

    // ==================== Events ====================
    function bindEvents() {
        $('#agentTrigger').addEventListener('click', (e) => {
            if (state.isDragging) return;
            togglePopup();
        });
        $('#agentClose').addEventListener('click', () => togglePopup(false));
        $('#btnAnonymous').addEventListener('click', handleAnonymousLogin);
        $('#btnGithub').addEventListener('click', handleGithubLogin);
        $('#agentSend').addEventListener('click', handleSend);
        $('#agentInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
        });
        $('#agentInput').addEventListener('input', (e) => {
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
            updateSendButton();
        });
        window.addEventListener('resize', checkBounds);
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateTheme);
        }
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('message', function(e) {
            if (e.data && e.data.type === 'github-oauth-success') {
                state.token = e.data.token;
                state.user = e.data.user || null;
                saveState();
                updateUI();
                addMessage('system', 'GitHub 登录成功！');
            } else if (e.data && e.data.type === 'github-oauth-error') {
                addMessage('system', 'GitHub 登录失败：' + (e.data.error || '未知错误'));
            }
        });
    }

    function togglePopup(show) {
        const popup = $('#agentPopup');
        state.isOpen = show !== undefined ? show : !state.isOpen;
        popup.classList.toggle('active', state.isOpen);
        if (state.isOpen) {
            $('#agentInput').focus();
            checkBounds();
        }
    }

    // ==================== Init ====================
    function init() {
        loadState();
        createWidget();
        restoreMessages();
        restorePosition();
        bindEvents();
        initDrag();
        updateUI();
        updateTheme();
        setTimeout(checkBounds, 500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
