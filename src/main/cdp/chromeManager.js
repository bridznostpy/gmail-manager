'use strict';
/**
 * Launches and controls one Chrome instance per profile via the DevTools
 * Protocol (CDP). No puppeteer - we spawn real Chrome with
 * `--remote-debugging-port` and talk to it over the DevTools HTTP + WebSocket
 * endpoints. Each profile = its own `--user-data-dir` so cookies/logins are
 * isolated and persist between runs.
 *
 * Port allocation walks the configured [portStart, portEnd] range.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const WebSocket = require('ws');

const fingerprint = require('./fingerprint');
const logger = require('../logger');
const { t } = require('../i18n');

function commonChromePaths() {
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:/Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    return [
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pfx86, 'Google/Chrome/Application/chrome.exe'),
      local && path.join(local, 'Google/Chrome/Application/chrome.exe'),
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
}

function resolveChrome(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  for (const p of commonChromePaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function httpJson(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForDevtools(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await httpJson(`http://127.0.0.1:${port}/json/version`);
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (_e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(t('err.devtoolsDown', { port }));
}

/** Minimal CDP client over the browser-level WebSocket. */
class CDPSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // CDP method -> [callback]
  }
  /** Subscribe to a CDP event, e.g. on('Target.attachedToTarget', cb). */
  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
          return;
        }
        if (!msg.id && msg.method) {
          const cbs = this.handlers.get(msg.method);
          if (cbs) for (const cb of cbs) {
            try { cb(msg.params || {}, msg.sessionId); } catch (_e) { /* обработчик не должен ронять сокет */ }
          }
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 15000);
    });
  }
  close() {
    try { this.ws && this.ws.close(); } catch (_e) {}
  }
}

// TODO(gmail-dom): эвристика статуса входа по DOM. Проверять на живом
// залогиненном Gmail, догадками не расширять (Rules 4/6).
const GMAIL_PROBE_EXPR = `(function(){
  try {
    var onMail = location.host === 'mail.google.com' && location.pathname.indexOf('/mail/') === 0;
    var signedIn = onMail && (
      !!document.querySelector('[gh="mtb"]') ||
      !!document.querySelector('a[href*="SignOutOptions"]') ||
      !!document.querySelector('div[role="main"]')
    );
    // Страницу входа определяем по хосту, а не по подстрокам в query: у уже
    // залогиненного инбокса в URL остаются flowName=GlifWebSignIn и
    // flowEntry=AccountChooser, из-за них он считался бы страницей входа.
    var signIn = location.host === 'accounts.google.com' ||
      (!onMail && !!document.querySelector('input[type="email"], input[type="password"]'));
    var RE = /[\\w.+-]+@[\\w.-]+\\.\\w{2,}/;
    var email = '';
    // 1. Заголовок вкладки - "Входящие (2) - user@gmail.com - Gmail". Не зависит
    // от языка интерфейса, в отличие от aria-label кнопки аккаунта.
    var m = RE.exec(document.title || '');
    if (m) email = m[0];
    if (!email) {
      var so = document.querySelector('a[href*="SignOutOptions"]');
      if (so) {
        m = RE.exec((so.getAttribute('aria-label') || '') + ' ' + (so.getAttribute('title') || ''));
        if (m) email = m[0];
      }
    }
    if (!email) {
      var nodes = document.querySelectorAll('[aria-label],[title],[data-email],[email]');
      for (var i = 0; i < nodes.length && i < 400; i++) {
        var n = nodes[i];
        var s = (n.getAttribute('data-email') || '') + ' ' + (n.getAttribute('email') || '') + ' '
              + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '');
        m = RE.exec(s);
        if (m) { email = m[0]; break; }
      }
    }
    return JSON.stringify({ href: location.href, signedIn: signedIn, signIn: signIn, email: email });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/** Вход в аккаунт приоритетнее страницы входа: инбокс может нести оба признака. */
function probeStatus(parsed) {
  if (parsed && parsed.signedIn) return 'ready';
  if (parsed && parsed.signIn) return 'needs_login';
  return 'unknown';
}

const STATUS_RANK = { ready: 3, needs_login: 2, unknown: 1 };

/**
 * Обёртка над плоской сессией браузерного соединения с интерфейсом CDPSession
 * (`send` / `close`), чтобы `inst.pageCdp` можно было перевесить на любую
 * вкладку без отдельного веб-сокета.
 */
function targetSession(cdp, sessionId) {
  return {
    sessionId,
    send: (method, params = {}, sid) => cdp.send(method, params, sid || sessionId),
    close: () => { cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); },
  };
}

class ChromeManager {
  constructor(store, dataDir) {
    this.store = store;
    this.dataDir = dataDir; // base dir for chrome user-data folders
    this.instances = new Map(); // profileId -> { proc, port, cdp, targetWs }
    this.activityWatchers = new Set(); // cb(profileId) - вкладка сменила адрес/заголовок
  }

  /**
   * Подписка на "в профиле что-то изменилось": пользователь перешёл по адресу
   * или у вкладки сменился заголовок. Момент входа в Gmail приложению больше
   * ниоткуда не приходит, а ждать следующего тика таймера долго.
   */
  onProfileActivity(cb) {
    this.activityWatchers.add(cb);
    return () => this.activityWatchers.delete(cb);
  }

  _notifyActivity(profileId) {
    for (const cb of this.activityWatchers) {
      try { cb(profileId); } catch (_e) { /* подписчик не должен ронять CDP */ }
    }
  }

  usedPorts() {
    return new Set([...this.instances.values()].map((i) => i.port));
  }

  async allocatePort() {
    const { portStart, portEnd } = this.store.get('cdp');
    const used = this.usedPorts();
    for (let p = portStart; p <= portEnd; p++) {
      if (used.has(p)) continue;
      if (await portFree(p)) return p;
    }
    throw new Error(t('err.noFreePort', { start: portStart, end: portEnd }));
  }

  userDataDir(profileId) {
    return path.join(this.dataDir, 'chrome-profiles', String(profileId));
  }

  isRunning(profileId) {
    return this.instances.has(profileId);
  }

  openPortsCount() {
    return this.instances.size;
  }

  /**
   * Launch Chrome for a profile, connect CDP, install the fingerprint on the
   * page target, and (optionally) navigate to an initial URL (gmail.com on
   * first run for manual login).
   */
  async launch(profile, { url } = {}) {
    if (this.instances.has(profile.id)) {
      return this.instances.get(profile.id);
    }
    const chromePath = resolveChrome(this.store.get('cdp').chromePath);
    if (!chromePath) {
      throw new Error(t('err.chromeNotFound'));
    }
    const port = await this.allocatePort();
    const udd = this.userDataDir(profile.id);
    fs.mkdirSync(udd, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${udd}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      `--window-size=${profile.fingerprint.screen.width - 100},${profile.fingerprint.screen.height - 120}`,
      `--user-agent=${profile.fingerprint.userAgent}`,
      `--lang=${profile.fingerprint.languages[0]}`,
    ];

    logger.info('cdp', t('cdp.launching', { label: profile.label, port }));
    const proc = spawn(chromePath, args, { detached: false, stdio: 'ignore' });
    proc.on('exit', (code) => {
      logger.warn('cdp', t('cdp.exited', { label: profile.label, code }));
      this.instances.delete(profile.id);
    });

    const version = await waitForDevtools(port);
    const cdp = new CDPSession(version.webSocketDebuggerUrl);
    await cdp.connect();

    const inst = { proc, port, cdp, profileId: profile.id };
    this.instances.set(profile.id, inst);

    // Каждая НОВАЯ вкладка профиля тоже должна получить фингерпринт: вход в
    // Gmail пользователь часто заканчивает в отдельной вкладке, и без этого она
    // шла бы с настоящими platform/screen/WebGL, отличными от карточки профиля.
    try {
      cdp.on('Target.attachedToTarget', async (params, _sid) => {
        const sessionId = params.sessionId;
        // Реагируем только на авто-аттач новых вкладок. Наши собственные
        // подключения (проба вкладок) сюда тоже прилетают, но у них таргет не
        // на паузе - и скрипт им ставить не надо, иначе он копился бы.
        if (!params.waitingForDebugger) return;
        try {
          if (params.targetInfo && params.targetInfo.type === 'page') {
            await cdp.send('Page.enable', {}, sessionId);
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
              source: fingerprint.injectionScript(profile.fingerprint),
            }, sessionId);
          }
        } catch (_e) { /* вкладку могли закрыть, пока мы к ней шли */ }
        // Снимать паузу обязательно и для любых типов таргетов: с
        // waitForDebuggerOnStart вкладка стоит, пока её не отпустят.
        try { await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId); } catch (_e) {}
      });
      await cdp.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      });

      // Вкладка сменила адрес или заголовок - повод пересканировать профиль:
      // именно так выглядит "пользователь вошёл в почту" со стороны браузера.
      // Сравниваем с прошлым состоянием вкладки, иначе наши же подключения к
      // ней (они тоже меняют targetInfo) гоняли бы скан по кругу.
      inst.seenTargets = new Map();
      cdp.on('Target.targetInfoChanged', (params) => {
        const ti = params.targetInfo;
        if (!ti || ti.type !== 'page') return;
        const key = (ti.url || '') + '|' + (ti.title || '');
        if (inst.seenTargets.get(ti.targetId) === key) return;
        inst.seenTargets.set(ti.targetId, key);
        this._notifyActivity(profile.id);
      });
      cdp.on('Target.targetDestroyed', (params) => {
        if (params && params.targetId) inst.seenTargets.delete(params.targetId);
      });
      await cdp.send('Target.setDiscoverTargets', { discover: true });
    } catch (e) {
      logger.warn('cdp', t('cdp.autoAttachFailed', { label: profile.label, error: e.message }));
    }

    // Attach to the first page target and install the fingerprint script so it
    // runs before any site JS on every navigation. Стартовая вкладка создана до
    // setAutoAttach, поэтому её подключаем руками.
    try {
      const targets = await httpJson(`http://127.0.0.1:${port}/json`);
      const page = targets.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) {
        const pageCdp = new CDPSession(page.webSocketDebuggerUrl);
        await pageCdp.connect();
        await pageCdp.send('Page.enable');
        await pageCdp.send('Runtime.enable');
        await pageCdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source: fingerprint.injectionScript(profile.fingerprint),
        });
        if (url) await pageCdp.send('Page.navigate', { url });
        inst.pageCdp = pageCdp;
        inst.pageTargetId = page.id;
      }
    } catch (e) {
      logger.warn('cdp', t('cdp.fingerprintFailed', { label: profile.label, error: e.message }));
    }

    logger.success('cdp', t('cdp.live', { label: profile.label, port }));
    return inst;
  }

  /** Все вкладки профиля: сначала похожие на Gmail, потом на страницу входа. */
  async _pageTargets(inst) {
    const res = await inst.cdp.send('Target.getTargets');
    const pages = (res.targetInfos || []).filter(
      (x) => x.type === 'page' && !/^(devtools|chrome-extension):/.test(x.url || ''),
    );
    const weight = (x) => {
      const u = x.url || '';
      if (/^https:\/\/mail\.google\.com\//.test(u)) return 0;
      if (/^https:\/\/accounts\.google\.com\//.test(u)) return 1;
      return 2;
    };
    return pages.sort((a, b) => weight(a) - weight(b));
  }

  /**
   * Прогнать эвристику входа в одной вкладке. Ходим через сессию браузера
   * (`Target.attachToTarget`), а не через отдельный веб-сокет: так проба не
   * зависит от того, отдаёт ли DevTools ссылку на вкладку по HTTP.
   */
  async _probeTarget(inst, info) {
    let sessionId = null;
    try {
      const att = await inst.cdp.send('Target.attachToTarget', {
        targetId: info.targetId, flatten: true,
      });
      sessionId = att.sessionId;
      await inst.cdp.send('Runtime.enable', {}, sessionId);
      const res = await inst.cdp.send('Runtime.evaluate', {
        expression: GMAIL_PROBE_EXPR, returnByValue: true, awaitPromise: false,
      }, sessionId);
      let parsed = {};
      try { parsed = JSON.parse(res.result.value); } catch (_e) {}
      return {
        targetId: info.targetId,
        status: probeStatus(parsed),
        email: parsed.email || '',
        href: parsed.href || info.url || '',
      };
    } finally {
      if (sessionId) {
        try { await inst.cdp.send('Target.detachFromTarget', { sessionId }); } catch (_e) {}
      }
    }
  }

  /**
   * Найти среди вкладок профиля ту, где реально открыт Gmail, и привязать к ней
   * `inst.pageCdp`. Вход пользователь часто заканчивает в другой вкладке, а не в
   * той, что была открыта при запуске, - без этого скан читал бы чужую страницу.
   */
  async _resolveGmailPage(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    const targets = await this._pageTargets(inst);
    let best = null;
    for (const info of targets) {
      let probe = null;
      try { probe = await this._probeTarget(inst, info); } catch (_e) { continue; }
      if (!best || STATUS_RANK[probe.status] > STATUS_RANK[best.status]) best = probe;
      if (best.status === 'ready') break;
    }
    if (!best) return { status: 'unknown', email: '', href: '' };

    if (best.status !== 'unknown' && best.targetId !== inst.pageTargetId) {
      try {
        const att = await inst.cdp.send('Target.attachToTarget', {
          targetId: best.targetId, flatten: true,
        });
        const next = targetSession(inst.cdp, att.sessionId);
        await next.send('Page.enable');
        await next.send('Runtime.enable');
        try { inst.pageCdp && inst.pageCdp.close(); } catch (_e) {}
        inst.pageCdp = next;
        inst.pageTargetId = best.targetId;
        logger.info('cdp', t('gmail.tabSwitched', { id: profileId }));
      } catch (_e) { /* остаёмся на прежней вкладке */ }
    }
    // У непонятной вкладки почте верить нельзя: адрес мог попасть в заголовок
    // случайной страницы.
    return {
      status: best.status,
      email: best.status === 'unknown' ? '' : best.email,
      href: best.href,
    };
  }

  /**
   * Scan the profile's Gmail tab to determine auth status. Reads the DOM for
   * signals of a logged-in inbox vs a sign-in screen. Перебирает все вкладки
   * профиля - Gmail может быть открыт не в стартовой.
   */
  async scanGmail(profileId, { quiet = false } = {}) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    const res = await this._resolveGmailPage(profileId);
    if (!quiet) {
      if (res.status === 'unknown') logger.warn('gmail', t('gmail.noTab', { id: profileId }));
      logger.info('gmail', t('gmail.scan', {
        id: profileId,
        status: t('gmailStatus.' + res.status),
        email: res.email ? ' (' + res.email + ')' : '',
      }));
    }
    return res;
  }

  async navigate(profileId, url) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.pageCdp) throw new Error(t('err.profileNotRunning'));
    await inst.pageCdp.send('Page.navigate', { url });
  }

  // ── Gmail automation over CDP ───────────────────────────────────────
  // TODO(gmail-dom): all selectors below are best-effort and must be validated
  // against a live logged-in Gmail. We only drive stable, non-reversed Gmail
  // mechanisms (compose-in-URL + Ctrl+Enter, DOM read of unread rows). No Gmail
  // API, no credentials - the user logs in by hand (Rules 4/6).

  /** Attach a fresh CDPSession to a specific page target by id. */
  async _attachTarget(port, targetId, tries = 40) {
    for (let i = 0; i < tries; i++) {
      try {
        const targets = await httpJson(`http://127.0.0.1:${port}/json`);
        const t = targets.find((x) => x.id === targetId && x.webSocketDebuggerUrl);
        if (t) {
          const cdp = new CDPSession(t.webSocketDebuggerUrl);
          await cdp.connect();
          return cdp;
        }
      } catch (_e) { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(t('err.attachFailed', { targetId }));
  }

  /** Evaluate an expression in the page and return its value by value. */
  async _eval(cdp, expression) {
    const res = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || t('err.evalFailed'));
    }
    return res && res.result ? res.result.value : undefined;
  }

  /** Poll a boolean predicate expression in the page until true (or give up). */
  async _waitFor(cdp, predicateExpr, tries = 40, delayMs = 250) {
    for (let i = 0; i < tries; i++) {
      try {
        if (await this._eval(cdp, predicateExpr)) return true;
      } catch (_e) { /* keep polling */ }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }

  /** Dispatch Ctrl+Enter - Gmail's send shortcut (works regardless of the
   *  keyboard-shortcuts setting). Focuses the body first. */
  async _sendCtrlEnter(cdp) {
    await this._eval(cdp, `(function(){var t=document.querySelector('div[role=textbox][aria-label*=Body], div[role=textbox]'); if(t)t.focus(); return true;})()`);
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 };
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, key));
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
  }

  /**
   * Send a first-message from a running profile. Opens Gmail's compose window
   * in a SEPARATE target (so the inbox tab used for reply-scanning stays put),
   * clicks Send (fallback Ctrl+Enter), waits for confirmation, then closes it.
   */
  async gmailCompose(profileId, { to, subject, body } = {}) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    if (!to) throw new Error(t('err.noRecipient'));
    const q = (s) => encodeURIComponent(String(s == null ? '' : s));
    const url = 'https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1'
      + `&to=${q(to)}&su=${q(subject)}&body=${q(body)}`;

    const { targetId } = await inst.cdp.send('Target.createTarget', { url });
    let pageCdp = null;
    try {
      pageCdp = await this._attachTarget(inst.port, targetId);
      await pageCdp.send('Page.enable');
      await pageCdp.send('Runtime.enable');

      const ready = await this._waitFor(pageCdp,
        `!!document.querySelector('div[role=button][aria-label^=Send], div[role=button][data-tooltip^=Send]')`, 40);
      if (!ready) throw new Error(t('err.composeNotRendered'));

      const clicked = await this._eval(pageCdp,
        `(function(){var b=document.querySelector('div[role=button][aria-label^=Send], div[role=button][data-tooltip^=Send]'); if(b){b.click(); return true;} return false;})()`);
      if (!clicked) await this._sendCtrlEnter(pageCdp);

      const sent = await this._waitFor(pageCdp,
        `(function(){ if(!document.querySelector('div[role=button][aria-label^=Send]')) return true; var e=document.querySelectorAll('span'); for(var i=0;i<e.length;i++){ if(/message sent|your message has been sent/i.test(e[i].textContent||'')) return true; } return false; })()`, 24);
      if (sent) logger.success('gmail', t('gmail.sent', { to }));
      else logger.warn('gmail', t('gmail.sendUnconfirmed', { to }));
      return { ok: !!sent };
    } finally {
      try { pageCdp && pageCdp.close(); } catch (_e) {}
      try { await inst.cdp.send('Target.closeTarget', { targetId }); } catch (_e) {}
    }
  }

  /**
   * Read unread conversations from the profile's inbox tab. Returns a shallow
   * list of { threadId, from, subject } for the auto-responder to act on.
   */
  async gmailListUnread(profileId, max = 25) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    // Привязаться к вкладке, где пользователь реально залогинен.
    try { await this._resolveGmailPage(profileId); } catch (_e) {}
    if (!inst.pageCdp) throw new Error(t('err.profileNotRunning'));
    const cdp = inst.pageCdp;
    const href = await this._eval(cdp, 'location.href');
    if (!/mail\.google\.com/.test(String(href || ''))) {
      await cdp.send('Page.navigate', { url: 'https://mail.google.com/mail/u/0/#inbox' });
      await this._waitFor(cdp, `/mail\\.google\\.com/.test(location.href)`, 24);
    }
    const expr = `(function(){try{`
      + `var rows=document.querySelectorAll('tr.zA.zE');var out=[];`
      + `for(var i=0;i<rows.length && out.length<${max};i++){var r=rows[i];`
      + `var id=r.getAttribute('data-legacy-thread-id')||r.getAttribute('id')||'';`
      + `var f=r.querySelector('span[email]');var from=f?(f.getAttribute('email')||f.textContent):'';`
      + `var s=r.querySelector('.bog, .y6 span');var subj=s?s.textContent:'';`
      + `out.push({threadId:id,from:from,subject:subj});}`
      + `return JSON.stringify(out);}catch(e){return '[]';}})()`;
    let list = [];
    try { list = JSON.parse((await this._eval(cdp, expr)) || '[]'); } catch (_e) {}
    return list.filter((x) => x && x.threadId);
  }

  /**
   * Open a thread on the inbox tab and send `text` as a reply. Used by the
   * auto-responder. Best-effort DOM automation - see TODO(gmail-dom) above.
   */
  async gmailReply(profileId, thread, text) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    try { await this._resolveGmailPage(profileId); } catch (_e) {}
    if (!inst.pageCdp) throw new Error(t('err.profileNotRunning'));
    const cdp = inst.pageCdp;
    const tid = typeof thread === 'string' ? thread : (thread && thread.threadId);
    if (!tid) throw new Error(t('err.noThreadId'));

    await cdp.send('Page.navigate', { url: 'https://mail.google.com/mail/u/0/#inbox/' + encodeURIComponent(tid) });
    const opened = await this._waitFor(cdp, `!!document.querySelector('div.adn, div[role=listitem]')`, 40);
    if (!opened) throw new Error(t('err.threadNotOpened'));

    await this._eval(cdp,
      `(function(){var b=document.querySelector('div[role=button][aria-label^=Reply], span.ams.bkH, div.amn'); if(b)b.click(); return true;})()`);
    const boxReady = await this._waitFor(cdp,
      `!!document.querySelector('div[role=textbox][aria-label*=Body], div[role=textbox]')`, 40);
    if (!boxReady) throw new Error(t('err.replyBoxNotOpened'));

    const put = JSON.stringify(String(text == null ? '' : text));
    await this._eval(cdp,
      `(function(){var t=document.querySelector('div[role=textbox][aria-label*=Body], div[role=textbox]'); if(!t)return false; t.focus(); try{document.execCommand('insertText',false,${put});}catch(e){t.textContent=${put};} t.dispatchEvent(new InputEvent('input',{bubbles:true})); return true;})()`);
    await this._sendCtrlEnter(cdp);

    const sent = await this._waitFor(cdp,
      `!document.querySelector('div[role=textbox][aria-label*=Body]')`, 24);
    if (sent) logger.success('gmail', t('gmail.replySent', { tid }));
    else logger.warn('gmail', t('gmail.replyUnconfirmed', { tid }));
    return { ok: !!sent };
  }

  async stop(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst) return;
    try { inst.cdp.close(); } catch (_e) {}
    try { inst.pageCdp && inst.pageCdp.close(); } catch (_e) {}
    try { inst.proc.kill(); } catch (_e) {}
    this.instances.delete(profileId);
    logger.info('cdp', t('cdp.stopped', { id: profileId }));
  }

  async stopAll() {
    for (const id of [...this.instances.keys()]) {
      await this.stop(id);
    }
  }
}

module.exports = { ChromeManager, resolveChrome };
