/**
 * Hexo Agent 共享工具：登录弹窗 + URL 解析
 *
 * @用途
 *   1. extractArticleContext()  — 从 window.location 解析 hexo 路由格式的文章上下文
 *   2. showLogin()              — 登录/注册弹窗（real 模式未登录时弹出）
 *      内部辅助：closeLogin / switchTab / submitLogin / submitRegister / showErr
 *
 * @依赖（运行时由使用方页面在加载 agent.js 之前先加载本文件）
 *   - window.HexoAgentConfig (可选) — 包含 apiBase 字段
 *   - window.HexoAgent.open  (可选) — 登录成功后调用，触发面板打开
 *
 * @加载顺序（典型用法）
 *   <script src="agent-common.js"></script>
 *   <script src="agent.js"></script>
 *
 * @v0.4.22 抽共用
 * @v0.4.23 UX polish — tab-segment 登录/注册切换 + 验证码 + 遮罩/ESC 关闭
 */
(function (global) {
  'use strict';

  // ==================== extractArticleContext ====================
  /**
   * 从当前页面 URL 解析文章上下文（hexo 路由格式 /:year/:month/:day/:category.../:title/）
   * 非文章页面（首页/标签/分类/归档/关于/搜索等）返回空对象
   * @returns {{articleCategory: ?string, articleTitle: ?string, articleSectionAnchor: ?string}}
   */
  function extractArticleContext() {
    var path = window.location.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (path.length < 4) return {};
    var skip = { 'tags': 1, 'categories': 1, 'archives': 1, 'about': 1, 'search': 1, 'page': 1 };
    if (skip[path[0]]) return {};
    var articleTitle = decodeURIComponent(path[path.length - 1]);
    var articleCategory = path.slice(3, -1).map(decodeURIComponent).join('/');
    var hash = window.location.hash;
    var articleSectionAnchor = hash ? decodeURIComponent(hash.slice(1)) : null;
    // 防御性：截断过长的 sectionAnchor（与后端 @Size(max=500) 对齐）
    if (articleSectionAnchor && articleSectionAnchor.length > 500) {
      articleSectionAnchor = articleSectionAnchor.substring(0, 500);
    }
    return {
      articleCategory: articleCategory || null,
      articleTitle: articleTitle || null,
      articleSectionAnchor: articleSectionAnchor || null
    };
  }

  // ==================== showLogin (v0.4.23 tab-segment) ====================
  /**
   * 弹出登录/注册对话框（real 模式未登录场景）
   * 登录/注册成功后调用 window.HexoAgent.open() 打开面板
   * 自包含：不依赖外部 el()/config() helper
   *
   * 交互细节：
   *   - 顶部 tab-segment "登录 | 注册" 切换
   *   - 点遮罩（弹窗外）/ 按 ESC → 关闭（带 fade-out 150ms + scale(.95) 动画）
   *   - 点弹窗内容 → 不关（事件不冒泡到遮罩）
   *   - 注册 tab：邮箱 + 验证码 + 密码 + 确认密码 + 可选昵称
   *   - 注册成功后存 token + 关 modal + 开 panel
   */
  function showLogin() {
    var TOKEN_KEY = 'hexo.token';
    // 确保 .hxa-root 容器存在
    var r = document.querySelector('.hxa-root');
    if (!r) {
      r = document.createElement('div');
      r.className = 'hxa-root';
      document.body.appendChild(r);
    }
    if (r.querySelector('.hxa-login')) return;
    var apiBase = (global.HexoAgentConfig && global.HexoAgentConfig.apiBase) || '';
    var box = document.createElement('div');
    box.className = 'hxa-login';
    box.innerHTML =
      '<div class="hxa-login__box">' +
        '<div class="hxa-login__tabs" role="tablist">' +
          '<button class="hxa-login__tab hxa-login__tab--active" data-tab="login" type="button" role="tab">登 录</button>' +
          '<button class="hxa-login__tab" data-tab="register" type="button" role="tab">注 册</button>' +
        '</div>' +
        '<div class="hxa-login__sub" data-sub="login">输入邮箱和密码开始对话</div>' +
        '<div class="hxa-login__sub" data-sub="register" hidden>注册新账号（邮箱 + 验证码 + 密码）</div>' +
        // 登录表单
        '<div class="hxa-login__panel" data-panel="login">' +
          '<input class="hxa-login__input" type="email" placeholder="邮箱" autocomplete="email" data-field="login-email">' +
          '<input class="hxa-login__input" type="password" placeholder="密码" autocomplete="current-password" data-field="login-pass">' +
          '<button class="hxa-login__btn" data-action="submit-login" type="button">登 录</button>' +
        '</div>' +
        // 注册表单
        '<div class="hxa-login__panel" data-panel="register" hidden>' +
          '<input class="hxa-login__input" type="email" placeholder="邮箱" autocomplete="email" data-field="reg-email">' +
          '<div class="hxa-login__code-row">' +
            '<input class="hxa-login__input hxa-login__input--code" type="text" inputmode="numeric" placeholder="邮箱验证码" maxlength="6" autocomplete="one-time-code" data-field="reg-code">' +
            '<button class="hxa-login__code-btn" type="button" data-action="send-code">发送验证码</button>' +
          '</div>' +
          '<input class="hxa-login__input" type="password" placeholder="密码（8-32 位含字母数字）" autocomplete="new-password" data-field="reg-pass">' +
          '<input class="hxa-login__input" type="password" placeholder="确认密码" autocomplete="new-password" data-field="reg-pass2">' +
          '<div class="hxa-login__pw-hint">两次密码需一致；留空昵称将自动用邮箱前缀</div>' +
          '<input class="hxa-login__input" type="text" placeholder="昵称（留空用邮箱前缀）" maxlength="32" autocomplete="nickname" data-field="reg-nick">' +
          '<button class="hxa-login__btn" data-action="submit-register" type="button">创建账号</button>' +
        '</div>' +
        '<div class="hxa-login__error" data-field="err"></div>' +
      '</div>';
    r.appendChild(box);

    // 元素引用
    var tabs = box.querySelectorAll('.hxa-login__tab');
    var panels = box.querySelectorAll('.hxa-login__panel');
    var subs = box.querySelectorAll('[data-sub]');
    var errEl = box.querySelector('[data-field="err"]');

    /**
     * 在共享 error 区域展示错误文本
     * @param {string} msg — 错误信息
     */
    function showErr(msg) {
      errEl.textContent = msg || '';
      if (msg) errEl.setAttribute('data-show', '1');
      else errEl.removeAttribute('data-show');
    }

    /**
     * 关闭登录弹窗（带 fade-out + scale 动画）
     * 动画结束后从 DOM 移除并清理 ESC 监听
     */
    function closeLogin() {
      if (box.getAttribute('data-closing') === '1') return;
      box.setAttribute('data-closing', '1');
      document.removeEventListener('keydown', onKeydown, true);
      // 150ms 与 CSS 动画时长对齐
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 170);
    }

    /**
     * ESC 键监听 — 捕获阶段确保即便表单 input 聚焦也生效
     */
    function onKeydown(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        closeLogin();
      }
    }

    /**
     * 切换登录/注册 tab
     * @param {string} name — 'login' 或 'register'
     */
    function switchTab(name) {
      if (name !== 'login' && name !== 'register') return;
      tabs.forEach(function (t) {
        if (t.getAttribute('data-tab') === name) t.classList.add('hxa-login__tab--active');
        else t.classList.remove('hxa-login__tab--active');
      });
      panels.forEach(function (p) {
        if (p.getAttribute('data-panel') === name) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
      subs.forEach(function (s) {
        if (s.getAttribute('data-sub') === name) s.removeAttribute('hidden');
        else s.setAttribute('hidden', '');
      });
      showErr('');
    }

    /**
     * 读取注册表单字段值，构造后端 RegisterRequest 兼容的 payload。
     *
     * <p>后端 {@code RegisterRequest} 必填字段：email / emailCode / password /
     * confirmPassword / nickname（v0.4.19 BREAKING）。前端 widget 把 "确认密码"
     * 单独做 input 收集到 {@code reg-pass2}，发送时复制为 {@code confirmPassword}。
     *
     * <p>nickname 是后端必填；UI 上"可选"，但留空时自动 fallback 到邮箱 @
     * 前缀（避免"看着可选实际必填"的认知冲突）。
     *
     * @returns {{email:string, emailCode:string, password:string,
     *   confirmPassword:string, nickname:string}}
     */
    function readRegisterPayload() {
      var panel = box.querySelector('[data-panel="register"]');
      var email = panel.querySelector('[data-field="reg-email"]').value.trim();
      var nickInput = panel.querySelector('[data-field="reg-nick"]').value.trim();
      return {
        email: email,
        emailCode: panel.querySelector('[data-field="reg-code"]').value.trim(),
        password: panel.querySelector('[data-field="reg-pass"]').value,
        confirmPassword: panel.querySelector('[data-field="reg-pass2"]').value,
        nickname: nickInput || email.split('@')[0] || 'user'
      };
    }

    /**
     * 发送邮箱验证码（注册流程前置步骤）
     * 调用 POST /api/auth/email-code，purpose: 'REGISTER'（大写枚举值）
     * 成功提示 dev 模式可填 123456（仅当后端未集成 SMTP 时）
     */
    function sendCode(btn) {
      var emailEl = box.querySelector('[data-field="reg-email"]');
      var email = emailEl.value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showErr('请先输入有效邮箱');
        emailEl.focus();
        return;
      }
      btn.disabled = true;
      var orig = btn.textContent;
      btn.textContent = '发送中...';
      showErr('');
      fetch(apiBase + '/api/auth/email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, purpose: 'REGISTER' })
      }).then(function (resp) { return resp.json().then(function (j) { return { ok: resp.ok, j: j }; }); }).then(function (r) {
        if (r.ok && r.j && r.j.code === 0) {
          btn.textContent = '已发送 ✓';
          showErr('验证码已发送，请查收邮箱');
          // 60s 冷却
          var left = 60;
          var tid = setInterval(function () {
            left--;
            if (left <= 0) { clearInterval(tid); btn.disabled = false; btn.textContent = orig; return; }
            btn.textContent = left + 's 后重发';
          }, 1000);
        } else {
          btn.disabled = false; btn.textContent = orig;
          showErr((r.j && r.j.msg) || '发送失败，请稍后重试');
        }
      }).catch(function () {
        btn.disabled = false; btn.textContent = orig;
        showErr('网络错误，请重试');
      });
    }

    /**
     * 提交登录表单
     */
    function submitLogin() {
      var email = box.querySelector('[data-field="login-email"]').value.trim();
      var pass = box.querySelector('[data-field="login-pass"]').value;
      var btn = box.querySelector('[data-action="submit-login"]');
      if (!email || !pass) { showErr('请填写邮箱和密码'); return; }
      btn.disabled = true; btn.textContent = '登录中...';
      showErr('');
      fetch(apiBase + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: pass })
      }).then(function (resp) { return resp.json(); }).then(function (j) {
        if (j && j.code === 0 && j.data && j.data.token) {
          try { localStorage.setItem(TOKEN_KEY, j.data.token); } catch (_) {}
          closeLogin();
          if (global.HexoAgent && typeof global.HexoAgent.open === 'function') {
            global.HexoAgent.open();
          }
        } else {
          showErr((j && j.msg) || '登录失败');
          btn.disabled = false; btn.textContent = '登 录';
        }
      }).catch(function () {
        showErr('网络错误，请重试');
        btn.disabled = false; btn.textContent = '登 录';
      });
    }

    /**
     * 提交注册表单
     * 前端先校验 password === password2 + 密码强度（8-32 位含字母数字）
     * 通过后发送 {email, emailCode, password, confirmPassword, nickname} 到后端
     * confirmPassword = 输入的 password2；nickname 留空时自动 fallback 到邮箱 @ 前缀
     */
    function submitRegister() {
      var pass = box.querySelector('[data-field="reg-pass"]').value;
      var pass2 = box.querySelector('[data-field="reg-pass2"]').value;
      if (pass.length < 8 || pass.length > 32) { showErr('密码需 8-32 位'); return; }
      if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) { showErr('密码需含字母和数字'); return; }
      if (pass !== pass2) { showErr('两次密码不一致'); return; }
      var payload = readRegisterPayload();
      if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
        showErr('请输入有效邮箱'); return;
      }
      if (!payload.emailCode || payload.emailCode.length < 4) {
        showErr('请输入邮箱验证码'); return;
      }
      var btn = box.querySelector('[data-action="submit-register"]');
      btn.disabled = true; btn.textContent = '创建中...';
      showErr('');
      fetch(apiBase + '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (resp) { return resp.json(); }).then(function (j) {
        if (j && j.code === 0 && j.data && j.data.token) {
          try { localStorage.setItem(TOKEN_KEY, j.data.token); } catch (_) {}
          closeLogin();
          if (global.HexoAgent && typeof global.HexoAgent.open === 'function') {
            global.HexoAgent.open();
          }
        } else {
          showErr((j && j.msg) || '注册失败');
          btn.disabled = false; btn.textContent = '创建账号';
        }
      }).catch(function () {
        showErr('网络错误，请重试');
        btn.disabled = false; btn.textContent = '创建账号';
      });
    }

    // ===== 事件绑定 =====
    // 遮罩点击：仅当点击目标是遮罩本身时关闭（事件不冒泡到 box）
    box.addEventListener('click', function (e) {
      if (e.target === box) closeLogin();
    });
    // ESC 监听（捕获阶段）
    document.addEventListener('keydown', onKeydown, true);
    // tab 切换
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
    });
    // 委托：所有 data-action 按钮
    box.querySelectorAll('[data-action]').forEach(function (b) {
      var act = b.getAttribute('data-action');
      b.addEventListener('click', function () {
        if (act === 'submit-login') submitLogin();
        else if (act === 'submit-register') submitRegister();
        else if (act === 'send-code') sendCode(b);
      });
    });
    // Enter 键提交（登录 tab：密码框 Enter 提交；注册 tab：每个 input Enter 跳下一个，最后一个 Enter 提交）
    box.querySelectorAll('[data-panel="login"] input').forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (inp.getAttribute('data-field') === 'login-email') {
            box.querySelector('[data-field="login-pass"]').focus();
          } else {
            submitLogin();
          }
        }
      });
    });
    var regInputs = box.querySelectorAll('[data-panel="register"] input');
    regInputs.forEach(function (inp, idx) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var next = regInputs[idx + 1];
          if (next) next.focus();
          else submitRegister();
        }
      });
    });

    // 默认聚焦第一个 input
    setTimeout(function () {
      var first = box.querySelector('[data-panel="login"] input');
      if (first) first.focus();
    }, 100);
  }

  // ==================== 暴露 ====================
  global.HexoAgentCommon = {
    extractArticleContext: extractArticleContext,
    showLogin: showLogin
  };
})(typeof window !== 'undefined' ? window : this);