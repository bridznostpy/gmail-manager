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

// TODO(gmail-dom): селекторы мини-окна письма. Сняты с живого DOM Gmail,
// проверять при изменениях вёрстки (Rules 4). Везде, где можно, опираемся на
// атрибуты, не зависящие от языка интерфейса: gh="cm", name="subjectbox",
// name="to", data-compose-id, а не на подписи кнопок.
const SEL = {
  composeBtn: 'div[gh="cm"]',
  to: '[name="to"] input[type="text"], input[peoplekit-id="BbVjBd"], input[aria-label^="To"]',
  subject: 'input[name="subjectbox"]',
  body: 'div[role="textbox"][g_editable="true"], div[role="textbox"][contenteditable="true"]',
  send: 'div[role="button"].aoO, div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"]',
  close: 'button.Ha, button[aria-label^="Save"]',
  refreshBtn: '[data-tooltip="Refresh"], [aria-label="Refresh"], .T-I.J-J5-Ji.nu.T-I-ax7.L3',
  replyBtn: 'span.ams.bkH[role="link"], div[role="button"][aria-label^="Reply"], div.amn',
  row: 'tr.zA',
  unreadRow: 'tr.zA.zE',
};

/**
 * Строки списка писем с отправителем. Логика выбора адреса перенесена из
 * расширения: в треде участников несколько, и нужен тот, кто ответил последним,
 * - первый span[email] строки часто сам аккаунт ("me"). Берём последний
 * span.zF, запасной путь - span.yP, письма от mailer-daemon отбрасываем.
 */
const ROWS_FN = `function __gmRows(unreadOnly, max){
  var bad = /mailer-daemon@/i;
  function pickEmail(row){
    var zf = row.querySelectorAll('span.zF[email]');
    for (var i = zf.length - 1; i >= 0; i--) {
      var e = zf[i].getAttribute('email');
      if (e && !bad.test(e)) return e;
    }
    var yp = row.querySelector('span.yP[email]');
    var y = yp ? yp.getAttribute('email') : '';
    return (y && !bad.test(y)) ? y : '';
  }
  var rows = document.querySelectorAll(unreadOnly ? '${SEL.unreadRow}' : '${SEL.row}');
  var out = [];
  for (var i = 0; i < rows.length && out.length < max; i++) {
    var r = rows[i];
    // id треда и id строки - разные вещи. Первый годится для адреса, второй
    // живёт только в текущем рендере списка и нужен, чтобы кликнуть строку.
    var holder = r.querySelector('[data-legacy-thread-id]');
    var tid = r.getAttribute('data-legacy-thread-id')
      || (holder ? holder.getAttribute('data-legacy-thread-id') : '') || '';
    var rid = r.getAttribute('id') || '';
    var s = r.querySelector('.bog, .y6 span');
    out.push({
      threadId: tid || rid, legacyId: tid, rowId: rid,
      from: pickEmail(r), subject: s ? s.textContent : '',
    });
  }
  return JSON.stringify(out);
}`;

/**
 * Мини-окно письма по его data-compose-id. Поднимаемся до диалога: шапка с
 * кнопками "свернуть/закрыть" лежит выше блока с полями, а нажатий по чужому
 * окну быть не должно - их на странице может висеть несколько.
 */
const WIDGET_FN = `function __gmWidget(cid){
  var r = document.querySelector('[data-compose-id="' + cid + '"]');
  if (!r) return null;
  return (r.closest && r.closest('div[role="dialog"]')) || r;
}`;

/** Выражение, работающее внутри одного мини-окна. */
function inWidget(cid, bodyExpr) {
  return `(function(){ ${WIDGET_FN}
    var w = __gmWidget(${JSON.stringify(String(cid))});
    if (!w) return false;
    ${bodyExpr}
  })()`;
}

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

    const inst = {
      proc, port, cdp, profileId: profile.id,
      // Профиль с mac-фингерпринтом: Gmail в нём ждёт Cmd+Enter вместо Ctrl+Enter.
      mac: /Mac OS X|Macintosh/.test(profile.fingerprint.userAgent || ''),
      // Цепочка задач по вкладке почты, см. _serial.
      queue: Promise.resolve(),
    };
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

  /**
   * Провести задачу через очередь профиля. Рассылка и автоответ работают на
   * ОДНОЙ вкладке почты: пока идёт отправка, у профиля открыто мини-окно
   * письма, а автоответ в это же время уводит вкладку на тред через
   * Page.navigate - письмо теряется, а текст ответа улетает не в то поле.
   * Поэтому все действия по Gmail выстраиваем в цепочку, как в расширении.
   */
  _serial(profileId, fn) {
    const inst = this.instances.get(profileId);
    if (!inst) return fn();
    const next = inst.queue.then(fn, fn);
    // Хвост цепочки не должен нести отказ дальше, иначе одна ошибка положит
    // все следующие задачи профиля.
    inst.queue = next.then(() => {}, () => {});
    return next;
  }

  /**
   * Нажать "Обновить" в списке писем. Без этого сканируем то, что осело во
   * вкладке: она может висеть открытой часами, и новый ответ в DOM не появится.
   */
  async _refreshInbox(cdp) {
    const clicked = await this._eval(cdp,
      `(function(){ var b = document.querySelector('${SEL.refreshBtn}');`
      + ` if (!b) return false; b.click(); return true; })()`).catch(() => false);
    if (!clicked) {
      logger.debug('gmail', t('gmail.refreshMissing'));
      return false;
    }
    // Список перерисовывается не мгновенно; ждём появления строк.
    await this._waitFor(cdp, `!!document.querySelector('${SEL.row}')`, 12);
    return true;
  }

  /**
   * Горячая клавиша отправки. У профилей с mac-фингерпринтом Gmail ждёт
   * Cmd+Enter, а не Ctrl+Enter - подпись на кнопке в таком профиле так и
   * выглядит ("Send (⌘Enter)"). Модификатор: 2 = Ctrl, 4 = Meta.
   */
  async _sendShortcut(cdp, inst, scope) {
    await this._eval(cdp, scope || `(function(){var t=document.querySelector('div[role=textbox][aria-label*=Body], div[role=textbox]'); if(t)t.focus(); return true;})()`);
    const key = {
      key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      modifiers: inst && inst.mac ? 4 : 2,
    };
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, key));
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
  }

  /** data-compose-id всех открытых мини-окон письма. */
  async _composeIds(cdp) {
    const raw = await this._eval(cdp,
      `JSON.stringify(Array.prototype.map.call(document.querySelectorAll('[data-compose-id]'),`
      + ` function(n){ return n.getAttribute('data-compose-id'); }))`);
    try { return JSON.parse(raw || '[]'); } catch (_e) { return []; }
  }

  /**
   * Нажать "Написать" и дождаться СВОЕГО мини-окна. Каждое нажатие открывает
   * ещё одно окно, поэтому запоминаем уже открытые и берём появившееся.
   */
  async _openCompose(cdp) {
    const before = await this._composeIds(cdp);
    const clicked = await this._eval(cdp,
      `(function(){ var b = document.querySelector('${SEL.composeBtn}');`
      + ` if (!b) return false; b.click(); return true; })()`);
    if (!clicked) return null;
    const known = JSON.stringify(before);
    const appeared = await this._waitFor(cdp,
      `(function(){ var k = ${known}, n = document.querySelectorAll('[data-compose-id]');`
      + ` for (var i = 0; i < n.length; i++) { if (k.indexOf(n[i].getAttribute('data-compose-id')) < 0) return true; }`
      + ` return false; })()`, 40);
    if (!appeared) return null;
    const fresh = (await this._composeIds(cdp)).filter((id) => before.indexOf(id) < 0);
    return fresh.length ? fresh[fresh.length - 1] : null;
  }

  /** Прочитать значение поля внутри своего мини-окна. */
  async _readField(cdp, cid, selector) {
    const v = await this._eval(cdp, inWidget(cid,
      `var el = w.querySelector(${JSON.stringify(selector)});
       return el ? String(el.value == null ? (el.innerText || '') : el.value) : null;`));
    return v === false ? null : v;
  }

  /**
   * Навести фокус на поле внутри своего мини-окна и напечатать текст.
   * Печатаем через Input.insertText: поле адресата - виджет Google, который
   * слушает настоящие события ввода, а не подстановку value. Результат
   * проверяем и при осечке подставляем значение напрямую.
   */
  async _typeInto(cdp, cid, selector, text) {
    const value = String(text == null ? '' : text);
    const focused = await this._eval(cdp, inWidget(cid,
      `var el = w.querySelector(${JSON.stringify(selector)});
       if (!el) return false;
       el.focus();
       if (el.select) { try { el.select(); } catch (e) {} }
       return true;`));
    if (!focused) return false;
    await cdp.send('Input.insertText', { text: value });

    if ((await this._readField(cdp, cid, selector)) === value) return true;
    // Запасной путь: значение напрямую плюс события, на которые виджет подписан.
    const put = JSON.stringify(value);
    await this._eval(cdp, inWidget(cid,
      `var el = w.querySelector(${JSON.stringify(selector)});
       if (!el) return false;
       el.focus();
       if ('value' in el) el.value = ${put}; else el.textContent = ${put};
       el.dispatchEvent(new InputEvent('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`));
    return (await this._readField(cdp, cid, selector)) === value;
  }

  /** Нажать клавишу в странице (Tab закрепляет адрес в поле получателя). */
  async _pressKey(cdp, key, code, vk) {
    const k = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, k));
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k));
  }

  /**
   * Получатель есть только тогда, когда адрес закреплён плашкой. Набранный в
   * поле текст не считаем: именно его Gmail и не признаёт получателем. Текст
   * блока получателей значение input не включает, так что попадание в него -
   * это уже плашка. Плашка известного контакта показывает имя, а не адрес,
   * поэтому дополнительно смотрим атрибуты.
   */
  async _hasRecipient(cdp, cid, address) {
    const needle = JSON.stringify(String(address || '').toLowerCase());
    return this._eval(cdp, inWidget(cid,
      `var box = w.querySelector('[name="to"]');
       if (!box) return false;
       if ((box.innerText || box.textContent || '').toLowerCase().indexOf(${needle}) >= 0) return true;
       var nodes = box.querySelectorAll('[data-hovercard-id],[email],[title],[aria-label]');
       for (var i = 0; i < nodes.length; i++) {
         var n = nodes[i];
         if (n.tagName === 'INPUT') continue;
         var s = ((n.getAttribute('data-hovercard-id') || '') + ' ' + (n.getAttribute('email') || '')
               + ' ' + (n.getAttribute('title') || '') + ' ' + (n.getAttribute('aria-label') || '')).toLowerCase();
         if (s.indexOf(${needle}) >= 0) return true;
       }
       return false;`));
  }

  /**
   * Вписать получателя и закрепить его. Просто набранный текст Gmail за
   * получателя не считает - при отправке он отвечает, что адрес не указан.
   * Закрепляем Tab, при осечке повторяем с запятой; Enter не годится - он
   * выберет подсказку из списка контактов, а это может быть чужой адрес.
   */
  async _setRecipient(cdp, cid, to) {
    const commits = [
      () => this._pressKey(cdp, 'Tab', 'Tab', 9),
      () => cdp.send('Input.insertText', { text: ',' }),
    ];
    for (const commit of commits) {
      const typed = await this._typeInto(cdp, cid, SEL.to, to);
      if (typed) {
        await commit();
        if (await this._hasRecipient(cdp, cid, to)) return true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /** Тело письма - contenteditable, перевод строки нужен настоящий. */
  async _fillBody(cdp, cid, text) {
    const put = JSON.stringify(String(text == null ? '' : text));
    return this._eval(cdp, inWidget(cid,
      `var el = w.querySelector(${JSON.stringify(SEL.body)});
       if (!el) return false;
       el.focus();
       try { document.execCommand('insertText', false, ${put}); }
       catch (e) { el.textContent = ${put}; }
       el.dispatchEvent(new InputEvent('input', { bubbles: true }));
       return true;`));
  }

  /**
   * Отправить первое письмо из запущенного профиля через мини-окно на самой
   * вкладке почты: нажимаем "Написать" (gh="cm"), заполняем поля своего окна и
   * жмём "Отправить". Отдельное окно ?view=cm остаётся запасным путём.
   */
  async gmailCompose(profileId, { to, subject, body } = {}) {
    return this._serial(profileId, () => this._gmailCompose(profileId, { to, subject, body }));
  }

  async _gmailCompose(profileId, { to, subject, body } = {}) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    if (!to) throw new Error(t('err.noRecipient'));

    await this._resolveGmailPage(profileId).catch(() => {});
    const cdp = inst.pageCdp;
    if (!cdp) throw new Error(t('err.profileNotRunning'));

    const href = await this._eval(cdp, 'location.href').catch(() => '');
    if (!/mail\.google\.com/.test(String(href || ''))) {
      await cdp.send('Page.navigate', { url: 'https://mail.google.com/mail/u/0/#inbox' });
      await this._waitFor(cdp, `/mail\\.google\\.com/.test(location.href)`, 24);
    }

    const btnReady = await this._waitFor(cdp,
      `!!document.querySelector('${SEL.composeBtn}')`, 40);
    if (!btnReady) {
      logger.warn('gmail', t('gmail.composeBtnMissing'));
      return this._composeViaWindow(inst, { to, subject, body });
    }

    const cid = await this._openCompose(cdp);
    if (!cid) throw new Error(t('err.composeNotOpened'));

    let sent = false;
    try {
      // Не жмём "Отправить" вслепую: без закреплённого получателя Gmail выдаёт
      // свой алерт, окно остаётся висеть, а в логе - невнятное "не подтверждено".
      if (!(await this._setRecipient(cdp, cid, to))) {
        throw new Error(t('err.recipientNotSet', { to }));
      }
      if (subject) await this._typeInto(cdp, cid, SEL.subject, subject);
      if (body) await this._fillBody(cdp, cid, body);

      const clicked = await this._eval(cdp, inWidget(cid,
        `var b = w.querySelector(${JSON.stringify(SEL.send)});
         if (!b) return false; b.click(); return true;`));
      if (!clicked) {
        await this._sendShortcut(cdp, inst, inWidget(cid,
          `var el = w.querySelector(${JSON.stringify(SEL.body)}); if (el) el.focus(); return true;`));
      }

      // Отправленное окно закрывается само. Отдельно ловим подтверждение Gmail
      // со ссылкой отмены - её id не зависит от языка интерфейса.
      sent = await this._waitFor(cdp,
        `(function(){ ${WIDGET_FN}
          if (!__gmWidget(${JSON.stringify(String(cid))})) return true;
          return !!document.getElementById('link_undo'); })()`, 24);
      if (sent) logger.success('gmail', t('gmail.sent', { to }));
      else logger.warn('gmail', t('gmail.sendUnconfirmed', { to }));
      return { ok: !!sent };
    } finally {
      // Своё окно за собой закрываем, иначе неудачные попытки копятся на
      // странице стопкой черновиков.
      if (!sent) {
        await this._eval(cdp, inWidget(cid,
          `var b = w.querySelector(${JSON.stringify(SEL.close)});
           if (b) { b.click(); return true; } return false;`)).catch(() => {});
      }
    }
  }

  /** Запасной путь: отдельное окно ?view=cm, если кнопки "Написать" нет. */
  async _composeViaWindow(inst, { to, subject, body } = {}) {
    const q = (s) => encodeURIComponent(String(s == null ? '' : s));
    const url = 'https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1'
      + `&to=${q(to)}&su=${q(subject)}&body=${q(body)}`;

    const { targetId } = await inst.cdp.send('Target.createTarget', { url });
    let pageCdp = null;
    try {
      pageCdp = await this._attachTarget(inst.port, targetId);
      await pageCdp.send('Page.enable');
      await pageCdp.send('Runtime.enable');

      const ready = await this._waitFor(pageCdp, `!!document.querySelector('${SEL.send}')`, 40);
      if (!ready) throw new Error(t('err.composeNotRendered'));

      const clicked = await this._eval(pageCdp,
        `(function(){ var b = document.querySelector('${SEL.send}');`
        + ` if (b) { b.click(); return true; } return false; })()`);
      if (!clicked) await this._sendShortcut(pageCdp, inst);

      const sent = await this._waitFor(pageCdp,
        `(function(){ if (!document.querySelector('${SEL.send}')) return true;`
        + ` return !!document.getElementById('link_undo'); })()`, 24);
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
    return this._serial(profileId, () => this._listRows(profileId, { unreadOnly: true, max }));
  }

  /** Прочитать строки списка писем на вкладке почты профиля. */
  async _listRows(profileId, { unreadOnly = true, max = 25 } = {}) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    // Привязаться к вкладке, где пользователь реально залогинен.
    try { await this._resolveGmailPage(profileId); } catch (_e) {}
    if (!inst.pageCdp) throw new Error(t('err.profileNotRunning'));
    const cdp = inst.pageCdp;
    await this._ensureInbox(cdp);
    await this._refreshInbox(cdp);
    const expr = `(function(){try{ ${ROWS_FN}`
      + ` return __gmRows(${unreadOnly ? 'true' : 'false'}, ${Number(max) || 25});`
      + `}catch(e){return '[]';}})()`;
    let list = [];
    try { list = JSON.parse((await this._eval(cdp, expr)) || '[]'); } catch (_e) {}
    return list.filter((x) => x && x.threadId);
  }

  /**
   * Вернуть вкладку в список писем. Признак списка - строки tr.zA: они есть и в
   * инбоксе, и в ярлыке, где пользователь мог остаться сам. Уводим на инбокс
   * только когда строк нет (открытый тред, другой сайт, окно письма).
   */
  async _ensureInbox(cdp) {
    const href = String((await this._eval(cdp, 'location.href').catch(() => '')) || '');
    if (/mail\.google\.com/.test(href)) {
      const listed = await this._eval(cdp, `!!document.querySelector('${SEL.row}')`).catch(() => false);
      if (listed) return true;
    }
    await cdp.send('Page.navigate', { url: 'https://mail.google.com/mail/u/0/#inbox' });
    return this._waitFor(cdp, `!!document.querySelector('${SEL.row}')`, 24);
  }

  /**
   * Open a thread on the inbox tab and send `text` as a reply. Used by the
   * auto-responder. Best-effort DOM automation - see TODO(gmail-dom) above.
   */
  async gmailReply(profileId, thread, text) {
    return this._serial(profileId, () => this._gmailReply(profileId, thread, text));
  }

  /**
   * Открыть переписку. Основной путь - клик по строке списка, как в расширении:
   * у строки инбокса есть только её собственный id вида ":15o", он живёт в
   * текущем рендере и адресом треда не является - переход на #inbox/:15o
   * никуда не ведёт. Строку ищем по id, при промахе (список перерисовался) - по
   * адресу отправителя. Настоящий data-legacy-thread-id, если он есть, остаётся
   * запасным путём через адрес.
   */
  async _openThread(cdp, item) {
    await this._ensureInbox(cdp);
    const rid = JSON.stringify(String(item.rowId || ''));
    const from = JSON.stringify(String(item.from || '').toLowerCase());
    const clicked = await this._eval(cdp, `(function(){
      var r = ${rid} ? document.getElementById(${rid}) : null;
      if (r && !(r.matches && r.matches('${SEL.row}'))) r = null;
      if (!r && ${from}) {
        var rows = document.querySelectorAll('${SEL.row}');
        for (var i = 0; i < rows.length && !r; i++) {
          var s = rows[i].querySelectorAll('span[email]');
          for (var j = 0; j < s.length; j++) {
            if ((s[j].getAttribute('email') || '').toLowerCase() === ${from}) { r = rows[i]; break; }
          }
        }
      }
      if (!r) return false;
      r.click();
      return true;
    })()`).catch(() => false);

    if (clicked) {
      const shown = await this._waitFor(cdp, `!!document.querySelector('div.adn, div[role=listitem]')`, 40);
      if (shown) return true;
    }
    // Запасной путь - адрес треда, но только если это настоящий id, а не id
    // строки: иначе получится заведомо мёртвая ссылка.
    if (!item.legacyId) return false;
    await cdp.send('Page.navigate', {
      url: 'https://mail.google.com/mail/u/0/#inbox/' + encodeURIComponent(item.legacyId),
    });
    return this._waitFor(cdp, `!!document.querySelector('div.adn, div[role=listitem]')`, 40);
  }

  async _gmailReply(profileId, thread, text) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.cdp) throw new Error(t('err.profileNotRunning'));
    try { await this._resolveGmailPage(profileId); } catch (_e) {}
    if (!inst.pageCdp) throw new Error(t('err.profileNotRunning'));
    const cdp = inst.pageCdp;
    const item = typeof thread === 'string' ? { threadId: thread } : (thread || {});
    const tid = item.threadId;
    if (!tid) throw new Error(t('err.noThreadId'));

    const opened = await this._openThread(cdp, item);
    if (!opened) {
      // Вкладку оставлять на треде нельзя: без списка писем следующий скан
      // ничего не найдёт, а отправка не найдёт кнопку "Написать".
      await this._ensureInbox(cdp).catch(() => {});
      throw new Error(t('err.threadNotOpened'));
    }

    try {
      await this._eval(cdp,
        `(function(){var b=document.querySelector('${SEL.replyBtn}'); if(b)b.click(); return true;})()`);
      const boxReady = await this._waitFor(cdp,
        `!!document.querySelector('div[role=textbox][aria-label*=Body], div[role=textbox]')`, 40);
      if (!boxReady) throw new Error(t('err.replyBoxNotOpened'));

      const put = JSON.stringify(String(text == null ? '' : text));
      await this._eval(cdp,
        `(function(){var t=document.querySelector('div[role=textbox][aria-label*=Body], div[role=textbox]'); if(!t)return false; t.focus(); try{document.execCommand('insertText',false,${put});}catch(e){t.textContent=${put};} t.dispatchEvent(new InputEvent('input',{bubbles:true})); return true;})()`);
      // Кнопки "Отправить" в окне ответа может не быть на виду - шлём горячей
      // клавишей, с поправкой на mac-фингерпринт профиля.
      await this._sendShortcut(cdp, inst);

      const sent = await this._waitFor(cdp,
        `!document.querySelector('div[role=textbox][aria-label*=Body]')`, 24);
      if (sent) logger.success('gmail', t('gmail.replySent', { tid }));
      else logger.warn('gmail', t('gmail.replyUnconfirmed', { tid }));
      return { ok: !!sent };
    } finally {
      // Возврат в список писем обязателен и при осечке - иначе вкладка так и
      // останется на треде и автоответ заглохнет до перезапуска.
      await this._ensureInbox(cdp).catch(() => {});
    }
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
