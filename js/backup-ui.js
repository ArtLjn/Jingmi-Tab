/* ============================================================
   backup-ui.js —— 账号与备份（左下角头像打开）
   职责：
     1. 账号 + 密码登录 / 邮箱注册 / 退出；
     2. 登录后按账号立即备份或从服务器恢复；
     3. 服务地址固定为后台地址，RAG/账号等技术配置不在前台暴露。
   约束：
     · 密码不落盘；只保存服务端返回的会话令牌；
     · 恢复是两步确认，第一次点击只预览，第二次才覆盖；
     · chrome.permissions.request 必须在点击回调的同步栈第一行调用。
   ============================================================ */
(function (global) {
  'use strict';

  var els = {};
  var opts = {};
  var registering = false;
  var authBusy = false;
  var restoreAt = 0;
  var restoreTimer = 0;

  function $(sel) { return document.querySelector(sel); }

  function settings() { return opts.getSettings ? opts.getSettings() : null; }

  function field(name) { return els[name] ? els[name].value.trim() : ''; }

  function backupCfg() { return (settings() && settings().backup) || {}; }

  function serverUrl() {
    /* 测试环境可通过 __BACKUP_SERVER__ 指向本地替身；正式环境固定域名 */
    return global.__BACKUP_SERVER__ || (global.Backup && global.Backup.DEFAULT_SERVER) || 'https://api.jingmi.lllcnm.cn';
  }

  function cfg() {
    return {
      serverUrl: serverUrl(),
      token: backupCfg().authToken || '',
      deviceId: 'default',
      auto: true
    };
  }

  function authCfg() {
    return { serverUrl: serverUrl(), token: backupCfg().authToken || '' };
  }

  function status(text, isErr) {
    if (!els.status) return;
    els.status.textContent = text || '';
    els.status.style.color = isErr ? 'rgba(255,150,150,0.92)' : 'rgba(255,255,255,0.62)';
  }

  function errText(err) {
    var code = String(err && err.code || '');
    var map = {
      network: '网络不通或服务不可达',
      timeout: '请求超时',
      auth: '登录已过期，请重新登录',
      unauthorized: '登录已过期，请重新登录',
      http_401: '登录已过期，请重新登录',
      http_403: '没有访问权限',
      forbidden: '暂时无法注册，请稍后再试',
      conflict: '该账号已注册，请直接登录',
      rate_limited: '登录失败次数过多，请稍后再试',
      invalid_credentials: '账号或密码错误',
      too_large: '备份数据超过 2 MiB',
      http_413: '备份数据超过服务端上限',
      not_found: '服务器上还没有备份',
      bad_config: '请先登录账号',
      bad_response: '服务端返回异常，请稍后再试',
      http_404: '服务端版本过旧，缺少账号接口',
      permission_missing: '缺少服务地址的访问权限',
      invalid_payload: '备份内容不完整或账号密码格式不正确',
      unsupported_schema: '备份版本不兼容'
    };
    return map[code] || (err && err.message) || '操作失败';
  }

  function fmtTime(ms) {
    if (!ms) return '从未';
    try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); }
    catch (e) { return new Date(ms).toISOString(); }
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MiB';
    if (n >= 1024) return Math.round(n / 1024) + ' KiB';
    return n + ' B';
  }

  /** 必须在用户手势的同步栈里调用 */
  function requestPerm() {
    var pattern = global.Backup.originPattern(serverUrl());
    if (!pattern || typeof chrome === 'undefined' || !chrome.permissions) return Promise.resolve(false);
    try { return chrome.permissions.request({ origins: [pattern] }).catch(function () { return false; }); }
    catch (e) { return Promise.resolve(false); }
  }

  function permDenied(granted) {
    return granted === false && typeof chrome !== 'undefined' && chrome.permissions && chrome.permissions.request;
  }

  function resetError() {
    if (!global.Backup) return Promise.resolve();
    return global.Backup.updateStatus({ errorCode: '', errorText: '', nextAt: 0, attempts: 0 });
  }

  function clearSession() {
    if (global.Profiles) return Profiles.logout();
    var s = settings();
    if (!s) return Promise.resolve();
    s.backup = Object.assign({}, s.backup, { authToken: '', username: '' });
    return global.Settings.save(s).then(renderAccount);
  }

  function handleAuthError(err) {
    var code = String(err && err.code || '');
    if (['unauthorized', 'auth', 'http_401'].indexOf(code) < 0) return false;
    clearSession();
    return true;
  }

  function refreshStatus() {
    if (!global.Backup) return;
    global.Backup.readStatus().then(function (st) {
      if (st.errorText) {
        status('上次失败：' + st.errorText + (st.nextAt ? ' · 将于 ' + fmtTime(st.nextAt) + ' 重试' : ''), true);
        return;
      }
      if (st.lastOkAt) {
        status('上次备份：' + fmtTime(st.lastOkAt) + (st.sizeBytes ? ' · ' + fmtBytes(st.sizeBytes) : ''));
      } else {
        status('');
      }
    });
  }

  /* 弹窗说明随登录状态与登录/注册模式切换，避免注册时仍写“登录后”。 */
  function introText() {
    if (backupCfg().authToken && backupCfg().username) return '已开启自动备份，设置变化会自动同步到账号。';
    return registering ? '注册后自动备份设置，换设备或重装后可用同一账号恢复。' : '登录后自动备份设置，换设备或重装后可用同一账号恢复。';
  }

  function renderIntro() {
    if (els.intro) els.intro.textContent = introText();
  }

  function renderAccount() {
    var b = backupCfg();
    var logged = !!(b.authToken && b.username);
    renderIntro();
    if (els.accountLogged) els.accountLogged.hidden = !logged;
    if (els.accountForm) els.accountForm.hidden = logged;
    if (els.actions) els.actions.hidden = !logged;
    if (els.note) els.note.hidden = !logged;
    if (els.accountName) els.accountName.textContent = b.username || '';
    if (els.username && !els.username.value && b.username) els.username.value = b.username;

    if (els.avatar) els.avatar.textContent = logged ? String(b.username).slice(0, 1).toUpperCase() : '?';
    if (els.navAccountName) els.navAccountName.textContent = logged ? b.username : '登录账号';
    if (els.accountBtn) {
      els.accountBtn.classList.toggle('is-logged', logged);
      els.accountBtn.title = logged ? '已登录：' + b.username : '登录账号或备份设置';
    }
  }

  function openAccount() {
    if (!els.accountModal) return;
    setAuthMode(false);
    els.accountModal.hidden = false;
    if (els.accountBtn) els.accountBtn.setAttribute('aria-expanded', 'true');
    if (!(backupCfg().authToken && backupCfg().username) && els.username) {
      setTimeout(function () { els.username.focus(); }, 30);
    }
  }

  function closeAccount() {
    if (!els.accountModal || els.accountModal.hidden) return;
    els.accountModal.hidden = true;
    clearPasswords();
    if (els.accountBtn) els.accountBtn.setAttribute('aria-expanded', 'false');
  }

  function clearPasswords() {
    if (els.password) els.password.value = '';
    if (els.confirmPassword) els.confirmPassword.value = '';
  }

  function setAuthMode(value) {
    registering = value;
    clearPasswords();
    status('');
    els.confirmField.hidden = !value;
    els.confirmPassword.required = value;
    els.username.type = value ? 'email' : 'text';
    els.usernameLabel.textContent = value ? '邮箱账号' : '账号';
    els.username.placeholder = value ? '请输入邮箱地址' : '邮箱或已有用户名';
    els.password.autocomplete = value ? 'new-password' : 'current-password';
    els.password.placeholder = value ? '至少 8 位密码' : '请输入密码';
    els.password.minLength = value ? 8 : 1;
    els.login.hidden = value;
    els.registerBtn.type = value ? 'submit' : 'button';
    els.registerBtn.textContent = value ? '注册并登录' : '注册账号';
    els.registerBtn.classList.toggle('action-primary', value);
    els.backLogin.hidden = !value;
    renderIntro();
  }

  async function submitAuth(ev) {
    ev.preventDefault();
    if (authBusy) return;
    var user = field('username');
    var pass = els.password.value;
    var isRegister = registering;
    if (!user || !pass) { status('请输入账号和密码', true); return; }
    if (isRegister) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) { status('请输入有效的邮箱地址', true); return; }
      if (pass.length < 8 || pass.length > 128) { status('密码需要 8～128 位', true); return; }
      if (pass !== els.confirmPassword.value) { status('两次输入的密码不一致', true); return; }
    }
    /* 权限申请保留在用户提交表单的同步调用栈中。 */
    var perm = requestPerm();
    authBusy = true;
    [els.login, els.registerBtn, els.backLogin].forEach(function (el) { el.disabled = true; });
    try {
      var granted = await perm;
      if (permDenied(granted)) { status('未获得服务地址访问权限，请重试并允许', true); return; }
      status(isRegister ? '正在注册…' : '正在登录…');
      var data = isRegister
        ? await global.Backup.authRegister(authCfg(), user, pass)
        : await global.Backup.authLogin(authCfg(), user, pass);
      if (global.Profiles) { await Profiles.activate(data); return; }
      var s = settings();
      s.backup = Object.assign({}, s.backup, { authToken: data.token, username: data.user.username, token: '' });
      await global.Settings.save(s);
      await resetError();
      setAuthMode(false);
      renderAccount();
      status((isRegister ? '注册成功，已登录：' : '已登录：') + data.user.username);
    } catch (err) {
      status((isRegister ? '注册失败：' : '登录失败：') + errText(err), true);
    } finally {
      authBusy = false;
      [els.login, els.registerBtn, els.backLogin].forEach(function (el) { el.disabled = false; });
    }
  }

  async function logout() {
    var s = settings();
    var token = s && s.backup && s.backup.authToken;
    if (token) await global.Backup.authLogout(authCfg()).catch(function () {});
    await clearSession();
    setAuthMode(false);
    status('已退出登录');
  }

  async function backupNow() {
    var perm = requestPerm();
    var conf = cfg();
    if (!conf.token) { status('请先登录账号', true); return; }

    var granted = await perm;
    if (permDenied(granted)) { status('未获得服务地址访问权限，请重试并允许', true); return; }
    status('正在备份…');
    try {
      if (typeof QuickTags !== 'undefined' && QuickTags.flush) await QuickTags.flush();
      var pack = await global.Backup.collect();
      await global.Backup.push(conf, pack);
      status('已备份 · ' + fmtBytes(pack.sizeBytes));
      refreshStatus();
    } catch (err) {
      if (!handleAuthError(err)) status('备份失败：' + errText(err), true);
    }
  }

  async function restoreRemote() {
    var perm = requestPerm();
    var conf = cfg();
    if (!conf.token) { status('请先登录账号', true); return; }

    var granted = await perm;
    if (permDenied(granted)) { status('未获得服务地址访问权限，请重试并允许', true); return; }

    if (!restoreAt) {
      status('正在读取服务器备份信息…');
      try {
        var m = await global.Backup.meta(conf);
        var meta = m && (m.data || m);
        if (!meta || !meta.last_backup_at) { status('服务器上还没有备份'); return; }
        restoreAt = Date.now();
        els.restore.textContent = '确认恢复并覆盖本机';
        clearTimeout(restoreTimer);
        restoreTimer = setTimeout(resetRestore, 15000);
        status('服务器备份：' + meta.last_backup_at + (meta.size_bytes ? ' · ' + fmtBytes(meta.size_bytes) : '') + '；再次点击「确认恢复」');
      } catch (err) {
        if (!handleAuthError(err)) status('读取失败：' + errText(err), true);
      }
      return;
    }

    resetRestore();
    status('正在恢复…');
    try {
      var payload = await global.Backup.pull(conf);
      var summary = await global.Backup.apply(payload, { currentSettings: settings() });
      status('已恢复 ' + summary.tags + ' 个标签；正在重新加载…');
      setTimeout(function () { location.reload(); }, 400);
    } catch (err) {
      if (!handleAuthError(err)) status('恢复失败：' + errText(err), true);
    }
  }

  function resetRestore() {
    restoreAt = 0;
    clearTimeout(restoreTimer);
    if (els.restore) els.restore.textContent = '从服务器恢复';
  }

  function bind() {
    if (els.now) els.now.addEventListener('click', backupNow);
    if (els.restore) els.restore.addEventListener('click', restoreRemote);
    if (els.accountForm) els.accountForm.addEventListener('submit', submitAuth);
    if (els.registerBtn) els.registerBtn.addEventListener('click', function (ev) {
      if (!registering) { ev.preventDefault(); setAuthMode(true); els.username.focus(); }
    });
    if (els.backLogin) els.backLogin.addEventListener('click', function () { setAuthMode(false); els.username.focus(); });
    if (els.logout) els.logout.addEventListener('click', logout);
    if (els.accountBtn) els.accountBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (els.accountModal && els.accountModal.hidden) openAccount();
      else closeAccount();
    });
    if (els.accountClose) els.accountClose.addEventListener('click', closeAccount);
    if (els.accountModal) els.accountModal.addEventListener('click', function (ev) {
      if (ev.target === els.accountModal) closeAccount();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || !els.accountModal || els.accountModal.hidden) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeAccount();
    });
    document.addEventListener('workspace:view', closeAccount);
    document.addEventListener('workspace:close', closeAccount);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && changes[global.Backup.STATUS_KEY]) refreshStatus();
      });
    }
  }

  function mount(options) {
    opts = options || {};
    els = {
      intro: $('#backup-intro'),
      username: $('#backup-username'),
      password: $('#backup-password'),
      usernameLabel: $('#backup-username-label'),
      confirmField: $('#backup-confirm-field'),
      confirmPassword: $('#backup-confirm-password'),
      backLogin: $('#backup-back-login'),
      note: $('#backup-note'),
      login: $('#backup-login'),
      registerBtn: $('#backup-register'),
      logout: $('#backup-logout'),
      accountLogged: $('#backup-account-logged'),
      accountForm: $('#backup-account-form'),
      accountName: $('#backup-account-name'),
      actions: $('#backup-actions'),
      accountBtn: $('#workspace-account'),
      avatar: $('#workspace-account-avatar'),
      navAccountName: $('#workspace-account-name'),
      accountModal: $('#account-modal'),
      accountClose: $('#account-close'),
      now: $('#backup-now'),
      restore: $('#backup-restore'),
      status: $('#backup-status')
    };
    if (!els.accountModal || !els.accountBtn) return null;

    bind();
    renderAccount();
    refreshStatus();
    return { refresh: refreshStatus, renderAccount: renderAccount };
  }

  global.BackupUI = { mount: mount };
})(typeof self !== 'undefined' ? self : window);
