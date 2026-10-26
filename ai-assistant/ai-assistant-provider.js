/**
 * AI 阅读助手 —— Provider 适配层（浏览器侧 classic script）。
 *
 * 职责边界：只做「配置归一 / 错误分型 / 流式协议翻译」三件事，不碰 DOM、不持有 UI 状态。
 * 外部只认 window.AIAssistant.provider 上的三个函数：
 *   normalizeConfig(raw) -> {protocol, baseUrl, apiKey, model, endpoint, headers}
 *   classifyError(info)  -> {kind, title, hint, detail}
 *   streamChat(cfg, payload) -> AsyncGenerator
 *
 * 两种协议的差异全部在本文件里消化，上层只面对一套内部统一格式：
 *   messages:[{role:'user'|'assistant', content:[
 *              {type:'text', text}
 *            | {type:'tool_use', id, name, input}
 *            | {type:'tool_result', tool_use_id, content}]}]
 *   tools:[{name, description, parameters}]（parameters 是 JSON Schema 对象）
 *
 * 协议映射（保持「谁调用、谁回结果」的配对顺序）：
 *   - OpenAI 兼容：tool_use -> assistant.tool_calls；tool_result -> 独立的 {role:'tool'} 消息；
 *   - Anthropic：  tool_use -> content 里的 tool_use 块；tool_result -> user 消息里的 tool_result 块。
 */
(function () {
    'use strict';

    var AI = window.AIAssistant = window.AIAssistant || {};

    var ANTHROPIC_VERSION = '2023-06-01';
    var ANTHROPIC_MAX_TOKENS = 2048;
    var MAX_DETAIL_LENGTH = 200;

    // 版本段（/v1、/v1beta、/v2 …）出现即视为调用方已自带路径前缀，再补 /v1 会拼出 /v1/v1
    var VERSION_SUFFIX_RE = /\/v[0-9][a-z0-9]*$/i;

    function normalizeProtocol(value) {
        var protocol = value == null ? '' : String(value).trim().toLowerCase();
        return protocol === 'anthropic' ? 'anthropic' : 'openai';
    }

    function stripTrailingSlash(value) {
        var text = value == null ? '' : String(value).trim();
        while (text.length > 0 && text.charAt(text.length - 1) === '/') {
            text = text.slice(0, -1);
        }
        return text;
    }

    /**
     * baseUrl 归一：
     *   - 去掉结尾斜杠；
     *   - openai：结尾没有版本段时补 /v1（OpenAI 的 chat/completions 挂在 /v1 下）；
     *   - anthropic：结尾已有 /v1 时先摘掉，因为消息路径自带 /v1（否则会拼成 /v1/v1/messages）。
     */
    function normalizeBaseUrl(rawBaseUrl, protocol) {
        var base = stripTrailingSlash(rawBaseUrl);
        if (!base) return '';
        if (protocol === 'anthropic') {
            if (/\/v1$/i.test(base)) base = base.slice(0, -3);
            return base;
        }
        if (!VERSION_SUFFIX_RE.test(base)) base += '/v1';
        return base;
    }

    /**
     * 归一用户填写的连接配置。缺字段不抛异常：返回空串，让调用方在发请求前自己校验，
     * 免得配置面板在用户还没填完时就弹出一坨堆栈。
     */
    function normalizeConfig(raw) {
        var input = raw || {};
        var protocol = normalizeProtocol(input.protocol);
        var baseUrl = normalizeBaseUrl(input.baseUrl, protocol);
        var apiKey = input.apiKey == null ? '' : String(input.apiKey).trim();
        var model = input.model == null ? '' : String(input.model).trim();

        var endpoint = '';
        if (baseUrl) {
            endpoint = protocol === 'anthropic' ? baseUrl + '/v1/messages' : baseUrl + '/chat/completions';
        }

        var headers;
        if (protocol === 'anthropic') {
            headers = {
                'Content-Type': 'application/json',
                // 先用 Bearer：多数 Anthropic 兼容网关（含 MiniMax /anthropic）只放行
                // Content-Type 与 Authorization 这两个头，带上 x-api-key 会被预检挡下。
                'Authorization': 'Bearer ' + apiKey
            };
        } else {
            headers = {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
            };
        }

        return {
            protocol: protocol,
            baseUrl: baseUrl,
            apiKey: apiKey,
            model: model,
            endpoint: endpoint,
            headers: headers
        };
    }

    /**
     * Anthropic 协议的备用鉴权头。
     * 官方 Anthropic API 要 x-api-key + anthropic-version，浏览器直连还得带
     * anthropic-dangerous-direct-browser-access；而 MiniMax 这类兼容网关的 CORS
     * 只放行 Content-Type 与 Authorization，带上 x-api-key 会被预检挡下。
     * 两套头各试一次，浏览器直连才能对两类 Provider 都成立。
     */
    function anthropicAltHeaders(apiKey) {
        return {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true'
        };
    }

    /**
     * 抹掉形似凭据的片段。Provider 的错误体偶尔会回显密钥，
     * 提示文案里绝不能出现明文，否则截图就等于泄密。
     */
    function redact(text, secret) {
        if (!text) return '';
        var out = String(text);
        if (secret) out = out.split(secret).join('***');
        out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
        out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer ***');
        out = out.replace(/\b(x-api-key\s*[:=]\s*)\S+/gi, '$1***');
        return out;
    }

    /**
     * 错误分型。浏览器直连最大的坑是「分不清 CORS 与鉴权失败」，
     * 所以每类都给出可执行的下一步，而不是笼统的「请求失败」。
     */
    function classifyError(info) {
        var input = info || {};
        var bodyText = redact(input.bodyText == null ? '' : String(input.bodyText), input.apiKey || '');
        var detail = bodyText.slice(0, MAX_DETAIL_LENGTH);
        var hasNetworkError = !!input.networkError;
        var status = typeof input.status === 'number' ? input.status : null;

        var kind;
        var title;
        var hint;

        if (input.streamBroken) {
            // 响应已经开始才断：是连接中途断了，不是浏览器不让读。
            // 不分清就会把用户引去查 CORS 配置，而真正的原因是流被掐断。
            kind = 'stream';
            title = '回复中途断开';
            hint = '模型已经开口，但连接在回复中途断了（常见于本地网关或模型侧超时）。重试一次，或换更短的提问。';
        } else if (hasNetworkError || status === 0) {
            if (input.reachable === false) {
                kind = 'network';
                title = '连不上 Provider';
                hint = '请求没到达服务端。检查 Base URL 的协议与端口，以及本地网关是否在运行。';
            } else {
                kind = 'cors';
                title = '浏览器直连被拒绝';
                hint = 'Provider 收到了请求，但没回 CORS 头，浏览器因此不让 JS 读取响应。换用支持浏览器直连的端点（MiniMax 的 Anthropic 协议 Base URL 填 https://api.minimax.cn/anthropic，OpenAI 兼容填 https://api.minimax.cn/v1），或在本机跑 node tools/ai-assistant-proxy.js 后把 Base URL 指向代理地址。';
            }
        } else if (status === 401 || status === 403) {
            kind = 'auth';
            title = '密钥无效或权限不足';
            hint = '检查 API Key 与协议是否匹配：OpenAI 兼容端点与 MiniMax 兼容端点用 Authorization: Bearer，Anthropic 官方 API 用 x-api-key。';
        } else if (status === 429) {
            kind = 'rate';
            title = '额度不足或触发限流';
            hint = '稍后重试，或更换模型与 Provider。';
        } else if (status >= 500 && status <= 599) {
            kind = 'server';
            title = 'Provider 服务异常';
            hint = '可稍后重试，或更换模型与 Provider。';
        } else if (status >= 400 && status <= 499) {
            kind = 'bad_request';
            title = '请求被拒绝';
            hint = detail || '检查模型名与请求体格式';
        } else {
            kind = 'network';
            title = '网络请求失败';
            hint = '请检查网络连通性与 Base URL 是否可访问，然后重试。';
        }

        return {kind: kind, title: title, hint: hint, detail: detail};
    }

    /**
     * 判断 400 是不是「鉴权头形态不对」引起的。
     * Anthropic 缺 version 头会报 400，但 400 绝大多数是请求体本身有问题，
     * 那种情况换头只会把真实错误盖掉，所以只认下面这些明显的头相关字样。
     */
    function looksLikeHeaderProblem(bodyText) {
        if (!bodyText) return false;
        return /x-api-key|api[-_ ]?key|authenticat|authorization|anthropic-version|api version|invalid.*(key|token)/i
            .test(String(bodyText));
    }

    function mergeUsage(base, next) {
        if (!next || typeof next !== 'object') return base;
        var out = {};
        if (base) {
            for (var k in base) {
                if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
            }
        }
        for (var k2 in next) {
            if (Object.prototype.hasOwnProperty.call(next, k2)) out[k2] = next[k2];
        }
        return out;
    }

    /**
     * 合并 usage 字段，但只补 base 里还没有的字段（first-wins）。
     * Anthropic 的 message_start 是输入侧的权威口径：后续事件里回显的 0
     * 不能把已经算好的输入顶掉，否则同一轮对话会被算少。
     */
    function mergeUsageFirst(base, next) {
        if (!next || typeof next !== 'object') return base;
        var out = {};
        if (base) {
            for (var k in base) {
                if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
            }
        }
        for (var k2 in next) {
            if (!Object.prototype.hasOwnProperty.call(next, k2)) continue;
            if (!Object.prototype.hasOwnProperty.call(out, k2)) out[k2] = next[k2];
        }
        return out;
    }

    /** usage 里的数字可能是字符串或 null，统一成「有限数字或 null」：拿不到就是 null，不拿 0 充数。 */
    function usageNumber(value) {
        if (value == null) return null;
        var num = Number(value);
        return isFinite(num) ? num : null;
    }

    /**
     * 把各协议原样返回的 usage 折算成统一的用量事件：
     *   Anthropic：input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens，
     *              output 取最后一次拿到的 output_tokens（message_delta 里是本轮累计输出），
     *              cache = 缓存写入 + 缓存读取；
     *   OpenAI 兼容：input = prompt_tokens，output = completion_tokens（取末块 usage）。
     * 缺字段一律给 null，上层据此显示「未知」，不猜、不填 0。
     */
    function buildUsageEvent(firstFields, latestFields) {
        var first = firstFields || {};
        var latest = latestFields || {};
        var input = null;
        var output = null;
        var cache = null;

        var inputTokens = usageNumber(first.input_tokens);
        var cacheCreation = usageNumber(first.cache_creation_input_tokens);
        var cacheRead = usageNumber(first.cache_read_input_tokens);
        if (inputTokens != null || cacheCreation != null || cacheRead != null) {
            input = (inputTokens || 0) + (cacheCreation || 0) + (cacheRead || 0);
        }
        if (cacheCreation != null || cacheRead != null) {
            cache = (cacheCreation || 0) + (cacheRead || 0);
        }

        var outputTokens = usageNumber(latest.output_tokens);
        if (outputTokens != null) output = outputTokens;

        var promptTokens = usageNumber(latest.prompt_tokens);
        if (promptTokens != null) input = promptTokens;
        var completionTokens = usageNumber(latest.completion_tokens);
        if (completionTokens != null) output = completionTokens;

        return {type: 'usage', input: input, output: output, cache: cache};
    }

    function toolResultText(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content;
        try {
            return JSON.stringify(content);
        } catch (e) {
            return String(content);
        }
    }

    /** 统一格式的 content 归一成数组，字符串 content 直接当纯文本处理。 */
    function splitContent(content) {
        if (Array.isArray(content)) return content.slice();
        if (typeof content === 'string') return [{type: 'text', text: content}];
        if (content && typeof content === 'object') return [content];
        return [];
    }

    function buildOpenAIBody(conf, payload) {
        var data = payload || {};
        // stream_options 让服务端在流末尾补一块 usage，前端据此显示这次对话消耗了多少 Token。
        // 不认识这个字段的服务端会直接忽略它，不会因此报错（OpenAI 兼容协议里它是可选参数）
        var body = {
            model: conf.model,
            stream: true,
            stream_options: {include_usage: true},
            messages: []
        };

        var system = data.system ? String(data.system) : '';
        if (system) body.messages.push({role: 'system', content: system});

        var source = Array.isArray(data.messages) ? data.messages : [];
        for (var i = 0; i < source.length; i++) {
            var msg = source[i] || {};
            var role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user');
            var parts = splitContent(msg.content);
            var texts = [];
            var calls = [];
            var results = [];

            for (var j = 0; j < parts.length; j++) {
                var part = parts[j] || {};
                if (part.type === 'tool_use') {
                    calls.push({
                        id: part.id || '',
                        type: 'function',
                        function: {
                            name: part.name || '',
                            arguments: JSON.stringify(part.input == null ? {} : part.input)
                        }
                    });
                } else if (part.type === 'tool_result') {
                    results.push({
                        role: 'tool',
                        tool_call_id: part.tool_use_id || '',
                        content: toolResultText(part.content)
                    });
                } else if (part.type === 'text') {
                    texts.push(part.text == null ? '' : String(part.text));
                }
            }

            if (role === 'system') {
                if (texts.length) body.messages.push({role: 'system', content: texts.join('\n')});
                continue;
            }

            if (role === 'assistant') {
                var assistantMessage = {role: 'assistant', content: texts.length ? texts.join('\n') : null};
                if (calls.length) assistantMessage.tool_calls = calls;
                body.messages.push(assistantMessage);
            } else if (texts.length || !results.length) {
                body.messages.push({role: 'user', content: texts.join('\n')});
            }

            // tool_result 单独成消息，并紧跟在发起调用的 assistant 之后，保证配对顺序
            for (var k = 0; k < results.length; k++) body.messages.push(results[k]);
        }

        var tools = Array.isArray(data.tools) ? data.tools : [];
        // 收尾轮：干脆不带工具，也不带 tool_choice。
        // 兼容层不保证认 tool_choice='none'，模型仍会返回 tool_use，
        // 那样这一轮又没有正文，答案就丢了。
        if (tools.length && data.toolChoice !== 'none') {
            body.tools = [];
            for (var t = 0; t < tools.length; t++) {
                var tool = tools[t] || {};
                body.tools.push({
                    type: 'function',
                    function: {
                        name: tool.name || '',
                        description: tool.description || '',
                        parameters: tool.parameters || {type: 'object', properties: {}}
                    }
                });
            }
        }

        return body;
    }

    function buildAnthropicBody(conf, payload) {
        var data = payload || {};
        var body = {model: conf.model, stream: true, max_tokens: ANTHROPIC_MAX_TOKENS, messages: []};
        var systemParts = [];
        if (data.system) systemParts.push(String(data.system));

        var source = Array.isArray(data.messages) ? data.messages : [];
        for (var i = 0; i < source.length; i++) {
            var msg = source[i] || {};
            var role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user');
            var parts = splitContent(msg.content);
            var blocks = [];
            var resultBlocks = [];
            var texts = [];

            for (var j = 0; j < parts.length; j++) {
                var part = parts[j] || {};
                if (part.type === 'tool_use') {
                    blocks.push({
                        type: 'tool_use',
                        id: part.id || '',
                        name: part.name || '',
                        input: part.input == null ? {} : part.input
                    });
                } else if (part.type === 'tool_result') {
                    resultBlocks.push({
                        type: 'tool_result',
                        tool_use_id: part.tool_use_id || '',
                        content: toolResultText(part.content)
                    });
                } else if (part.type === 'text') {
                    var textValue = part.text == null ? '' : String(part.text);
                    texts.push(textValue);
                    // 空的 text 块会被 Anthropic 判 400（content blocks 不能为空）
                    if (textValue) blocks.push({type: 'text', text: textValue});
                } else if (part.type === 'thinking') {
                    // 思考块要原样回传（Anthropic 协议要求 thinking + signature）
                    blocks.push({
                        type: 'thinking',
                        thinking: part.thinking == null ? '' : String(part.thinking),
                        signature: part.signature == null ? '' : String(part.signature)
                    });
                }
            }

            // Anthropic 的 system 是顶层字段，消息里的 system 角色折叠进来
            if (role === 'system') {
                if (texts.length) systemParts.push(texts.join('\n'));
                continue;
            }

            if (blocks.length) body.messages.push({role: role, content: blocks});
            // tool_result 必须装在 user 消息里
            if (resultBlocks.length) body.messages.push({role: 'user', content: resultBlocks});
        }

        if (systemParts.length) body.system = systemParts.join('\n\n');

        var tools = Array.isArray(data.tools) ? data.tools : [];
        // 同上：收尾轮不带 tools（也不带 tool_choice），模型无从调用工具，只能写答案
        if (tools.length && data.toolChoice !== 'none') {
            body.tools = [];
            for (var t = 0; t < tools.length; t++) {
                var tool = tools[t] || {};
                body.tools.push({
                    name: tool.name || '',
                    description: tool.description || '',
                    input_schema: tool.parameters || {type: 'object', properties: {}}
                });
            }
        }

        return body;
    }

    /** cfg 可以是原始配置，也可以是 normalizeConfig 的产物；后者的 endpoint/headers 优先保留。 */
    function resolveConfig(cfg) {
        var conf = normalizeConfig(cfg);
        if (cfg && cfg.endpoint) conf.endpoint = String(cfg.endpoint);
        if (cfg && cfg.headers && typeof cfg.headers === 'object') conf.headers = cfg.headers;
        return conf;
    }

    function anthropicErrorStatus(type) {
        var name = String(type || '').toLowerCase();
        if (name.indexOf('rate_limit') >= 0) return 429;
        if (name.indexOf('authentication') >= 0) return 401;
        if (name.indexOf('permission') >= 0) return 403;
        if (name.indexOf('invalid_request') >= 0) return 400;
        return 500;
    }

    /**
     * 探活：请求失败时要分清「网络不通」与「浏览器不让读」。
     * no-cors 请求不需要 CORS 头，服务端只要有回应（哪怕 404/405）就说明网络是通的，
     * 那失败就出在 CORS 上，提示才指得对方向。
     */
    async function probeReachable(url) {
        if (!url) return false;
        try {
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            var timer = controller ? setTimeout(function () { controller.abort(); }, 3000) : null;
            var init = { method: 'GET', mode: 'no-cors', cache: 'no-store' };
            if (controller) init.signal = controller.signal;
            await fetch(url, init);
            clearTimeout(timer);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 发起一次流式对话。产出事件：
     *   {type:'text', text}
     *   {type:'tool_call', id, name, arguments}（arguments 是 JSON 字符串）
     *   {type:'error', error:{kind, title, hint, detail}}
     *   {type:'usage', input, output, cache}（Token 用量，缺的字段是 null）
     *   {type:'done', usage}
     */
    async function* streamChat(cfg, payload) {
        var conf = resolveConfig(cfg);
        var data = payload || {};

        if (!conf.endpoint || !conf.apiKey || !conf.model) {
            yield {
                type: 'error',
                error: {
                    kind: 'bad_request',
                    title: '配置不完整',
                    hint: '请填写 Base URL、API Key 与模型名后再试。',
                    detail: ''
                }
            };
            return;
        }

        var requestBody = conf.protocol === 'anthropic'
            ? buildAnthropicBody(conf, data)
            : buildOpenAIBody(conf, data);

        // 鉴权头有两套，任意一套被对方的 CORS 或鉴权规则挡下就换另一套再试一次，
        // 这样「浏览器直连」对官方 Anthropic API 与 MiniMax 这类兼容网关都成立。
        var headerForms = [conf.headers];
        if (conf.protocol === 'anthropic') headerForms.push(anthropicAltHeaders(conf.apiKey));

        var signal = data.signal || conf.signal;
        var response = null;
        var lastError = null;
        var firstError = null;

        for (var attempt = 0; attempt < headerForms.length; attempt += 1) {
            var init = {
                method: 'POST',
                headers: headerForms[attempt],
                body: JSON.stringify(requestBody)
            };
            if (signal) init.signal = signal;

            try {
                response = await fetch(conf.endpoint, init);
            } catch (err) {
                var reachable = await probeReachable(conf.endpoint);
                lastError = classifyError({
                    networkError: err,
                    bodyText: err && err.message ? String(err.message) : '',
                    apiKey: conf.apiKey,
                    reachable: reachable
                });
                // 只有「服务器有响应、但浏览器不让读」才值得换鉴权头重试；
                // 真的连不上时换头也没用，直接报错。
                if (lastError.kind === 'cors') {
                    // 换头那次失败不能盖掉第一次的真实错误：
                    // 备用头常被 CORS 拦下，用户看到的会是「浏览器直连被拒绝」，
                    // 而真正要修的是第一次返回的那个 400
                    if (firstError) {
                        firstError.detail = (firstError.detail ? firstError.detail + ' | ' : '') +
                            '换用备用鉴权头后：' + lastError.title;
                        yield {type: 'error', error: firstError};
                        return;
                    }
                    continue;
                }
                yield {type: 'error', error: lastError};
                return;
            }

            if (response && response.ok) break;

            var errorBody = '';
            try {
                errorBody = await response.text();
            } catch (e) {
                errorBody = '';
            }
            lastError = classifyError({
                status: response ? response.status : 0,
                bodyText: errorBody,
                apiKey: conf.apiKey
            });
            if (!firstError) firstError = lastError;
            // 只在「鉴权头形态不对」时换头重试：401/403 一定是鉴权问题；
            // 400 多半是请求体本身不对（Anthropic 缺 version 头也会报 400），
            // 换头救不了，硬换反而把真实错误体盖成 CORS 报错
            var status = response ? response.status : 0;
            if (status === 401 || status === 403) continue;
            if (status === 400 && looksLikeHeaderProblem(errorBody)) continue;
            yield {type: 'error', error: lastError};
            return;
        }

        if (!response || !response.ok) {
            yield {
                type: 'error',
                error: firstError || lastError || classifyError({status: 0, apiKey: conf.apiKey})
            };
            return;
        }

        var pending = [];
        var usage = null;
        // 输入侧字段（Anthropic 的三笔）只认第一次拿到的值，输出侧字段取最后一次拿到的值
        var usageFirst = null;
        var usageLatest = null;
        var finished = false;
        var buffer = '';
        var toolCalls = {};
        var blocks = {};

        function pushText(text) {
            pending.push({type: 'text', text: text});
        }

        // 思考内容单独走一条事件，别混进正文气泡里
        function pushThinking(text) {
            pending.push({type: 'thinking', text: text});
        }

        function pushToolCall(call) {
            pending.push({type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments});
        }

        function handleOpenAiData(raw) {
            var obj;
            try {
                obj = JSON.parse(raw);
            } catch (e) {
                return; // 单块解析失败只跳过这一块，不能让整条流断掉
            }
            if (!obj || typeof obj !== 'object') return;
            if (obj.usage) {
                usage = mergeUsage(usage, obj.usage);
                // OpenAI 兼容协议把 usage 放在流末尾的那一块，取最后一次拿到的值
                usageLatest = mergeUsage(usageLatest, obj.usage);
            }

            var choices = Array.isArray(obj.choices) ? obj.choices : [];
            for (var i = 0; i < choices.length; i++) {
                var delta = choices[i] && choices[i].delta;
                if (!delta) continue;
                if (typeof delta.content === 'string' && delta.content !== '') pushText(delta.content);
                // 兼容写法：思考内容有的端点放在 reasoning_content / reasoning 里
                var reasoning = delta.reasoning_content;
                if (typeof reasoning !== 'string') reasoning = delta.reasoning;
                if (typeof reasoning === 'string' && reasoning !== '') pushThinking(reasoning);

                var deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
                for (var j = 0; j < deltas.length; j++) {
                    var call = deltas[j] || {};
                    var key = typeof call.index === 'number' ? call.index : 0;
                    var acc = toolCalls[key];
                    if (!acc) {
                        acc = toolCalls[key] = {id: '', name: '', args: ''};
                    }
                    if (call.id) acc.id = call.id;
                    var fn = call.function || {};
                    if (fn.name) {
                        // 名字可能分片到达，也可能被 Provider 整段重复，两种都兼容
                        if (acc.name === '') acc.name = fn.name;
                        else if (acc.name !== fn.name) acc.name += fn.name;
                    }
                    if (fn.arguments) acc.args += fn.arguments;
                }
            }
        }

        function handleAnthropicData(raw) {
            var obj;
            try {
                obj = JSON.parse(raw);
            } catch (e) {
                return;
            }
            if (!obj || typeof obj !== 'object') return;

            var type = obj.type;
            if (type === 'message_start') {
                if (obj.message && obj.message.usage) {
                    usage = mergeUsage(usage, obj.message.usage);
                    // 输入侧（input_tokens / 缓存两笔）以 message_start 为准
                    usageFirst = mergeUsageFirst(usageFirst, obj.message.usage);
                    usageLatest = mergeUsage(usageLatest, obj.message.usage);
                }
            } else if (type === 'content_block_start') {
                var block = obj.content_block || {};
                blocks[obj.index] = {
                    type: block.type || 'text',
                    id: block.id || '',
                    name: block.name || '',
                    json: '',
                    text: '',
                    signature: ''
                };
                if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') pushText(block.text);
                // 思考块单独成流，不要混进正文
                if (block.type === 'thinking') {
                    if (typeof block.thinking === 'string' && block.thinking !== '') {
                        blocks[obj.index].text = block.thinking;
                        pushThinking(block.thinking);
                    }
                    if (typeof block.signature === 'string') blocks[obj.index].signature = block.signature;
                }
            } else if (type === 'content_block_delta') {
                var target = blocks[obj.index];
                if (!target) {
                    target = blocks[obj.index] = {type: 'text', id: '', name: '', json: '', text: '', signature: ''};
                }
                var delta = obj.delta || {};
                if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
                    pushText(delta.text);
                } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
                    target.text = (target.text || '') + delta.thinking;
                    pushThinking(delta.thinking);
                } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
                    // signature 是思考块的校验值，回传时必须原样带上
                    target.signature = (target.signature || '') + delta.signature;
                } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                    target.json += delta.partial_json;
                }
            } else if (type === 'content_block_stop') {
                var stopped = blocks[obj.index];
                if (stopped && stopped.type === 'tool_use' && !stopped.emitted) {
                    stopped.emitted = true;
                    pushToolCall({id: stopped.id, name: stopped.name, arguments: stopped.json || '{}'});
                }
            } else if (type === 'message_delta') {
                if (obj.usage) {
                    usage = mergeUsage(usage, obj.usage);
                    // message_delta 的 usage.output_tokens 是本轮累计输出（最后一次拿到的为准）
                    usageFirst = mergeUsageFirst(usageFirst, obj.usage);
                    usageLatest = mergeUsage(usageLatest, obj.usage);
                }
            } else if (type === 'message_stop') {
                finished = true;
            } else if (type === 'error') {
                var error = obj.error || {};
                pending.push({
                    type: 'error',
                    error: classifyError({
                        status: anthropicErrorStatus(error.type),
                        bodyText: error.message || '',
                        apiKey: conf.apiKey
                    })
                });
            }
        }

        function handleLine(line) {
            if (line.length && line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
            if (!line) return;
            if (line.charAt(0) === ':') return; // SSE 注释与心跳
            if (line.slice(0, 5) !== 'data:') return;
            var data_ = line.slice(5);
            if (data_.charAt(0) === ' ') data_ = data_.slice(1);
            if (data_ === '[DONE]') {
                finished = true;
                return;
            }
            if (conf.protocol === 'anthropic') handleAnthropicData(data_);
            else handleOpenAiData(data_);
        }

        function feed(text) {
            buffer += text;
            var index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                var line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                handleLine(line);
            }
        }

        function flushBuffer() {
            if (!buffer) return;
            var line = buffer;
            buffer = '';
            handleLine(line);
        }

        function flushOpenAiToolCalls() {
            var keys = Object.keys(toolCalls).sort(function (a, b) {
                return Number(a) - Number(b);
            });
            for (var i = 0; i < keys.length; i++) {
                var acc = toolCalls[keys[i]];
                pushToolCall({id: acc.id, name: acc.name, arguments: acc.args || '{}'});
            }
        }

        var reader = response.body && response.body.getReader ? response.body.getReader() : null;
        if (!reader) {
            // 没有可读流的老浏览器：一次性读全量再按 SSE 文本切分
            var whole = '';
            try {
                whole = await response.text();
            } catch (e) {
                whole = '';
            }
            feed(whole);
            flushBuffer();
        } else {
            var decoder = new TextDecoder('utf-8');
            while (!finished) {
                var chunk;
                try {
                    chunk = await reader.read();
                } catch (err) {
                    yield {
                        type: 'error',
                        error: classifyError({
                            streamBroken: true,
                            networkError: err,
                            bodyText: err && err.message ? String(err.message) : '',
                            apiKey: conf.apiKey
                        })
                    };
                    return;
                }
                if (chunk.done) break;
                feed(decoder.decode(chunk.value, {stream: true}));
                while (pending.length) yield pending.shift();
            }
            var tail = decoder.decode();
            if (tail) feed(tail);
            flushBuffer();
        }

        while (pending.length) yield pending.shift();

        // OpenAI 的工具参数是分片累积的，只有流结束才知道完整 JSON
        if (conf.protocol !== 'anthropic') {
            flushOpenAiToolCalls();
            while (pending.length) yield pending.shift();
        }

        // 思考块原样交回主流程：Anthropic 协议在工具轮之后要求把上一轮的
        // thinking 块与 signature 原样带回，缺了会被判 400
        var thinkingBlocks = [];
        Object.keys(blocks).forEach(function (key) {
            var block = blocks[key];
            if (block && block.type === 'thinking' && block.text) {
                thinkingBlocks.push({thinking: block.text, signature: block.signature || ''});
            }
        });
        if (thinkingBlocks.length) yield {type: 'thinking_blocks', blocks: thinkingBlocks};

        // Token 用量单独报一个事件，上层据此显示「这次对话消耗了多少 Token」
        yield buildUsageEvent(usageFirst, usageLatest);

        yield {type: 'done', usage: usage || null};
    }

    AI.provider = {
        normalizeConfig: normalizeConfig,
        classifyError: classifyError,
        streamChat: streamChat
    };
})();
