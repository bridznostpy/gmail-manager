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

class ChromeManager {
  constructor(store, dataDir) {
    this.store = store;
    this.dataDir = dataDir; // base dir for chrome user-data folders
    this.instances = new Map(); // profileId -> { proc, port, cdp, targetWs }
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

    // Attach to the first page target and install the fingerprint script so it
    // runs before any site JS on every navigation.
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

  /**
   * Scan the profile's Gmail tab to determine auth status. Reads the DOM for
   * signals of a logged-in inbox vs a sign-in screen.
   */
  async scanGmail(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.pageCdp) throw new Error(t('err.profileNotRunning'));
    // Ensure we're looking at Gmail.
    const expr = `(function(){
      try {
        var href = location.href;
        var signedIn = !!document.querySelector('[gh="mtb"]') ||
                       !!document.querySelector('div[role="main"]') && /mail\\.google\\.com\\/mail/.test(href);
        var signIn = /accounts\\.google\\.com|ServiceLogin|signin/.test(href) ||
                     !!document.querySelector('input[type="email"]');
        var email = '';
        var el = document.querySelector('a[aria-label*="Google Account"], [aria-label*="@"]');
        if (el) { var m = (el.getAttribute('aria-label')||'').match(/[\\w.+-]+@[\\w.-]+/); if (m) email = m[0]; }
        return JSON.stringify({ href: href, signedIn: signedIn, signIn: signIn, email: email });
      } catch(e){ return JSON.stringify({ error: String(e) }); }
    })()`;
    const res = await inst.pageCdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: false,
    });
    let parsed = {};
    try { parsed = JSON.parse(res.result.value); } catch (_e) {}
    let status = 'unknown';
    if (parsed.signedIn && !parsed.signIn) status = 'ready';
    else if (parsed.signIn) status = 'needs_login';
    logger.info('gmail', t('gmail.scan', {
      id: profileId,
      status: t('gmailStatus.' + status),
      email: parsed.email ? ' (' + parsed.email + ')' : '',
    }));
    return { status, email: parsed.email || '', href: parsed.href || '' };
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
    if (!inst || !inst.pageCdp) throw new Error(t('err.profileNotRunning'));
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
    if (!inst || !inst.pageCdp) throw new Error(t('err.profileNotRunning'));
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
