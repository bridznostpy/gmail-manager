'use strict';
/**
 * Launches and controls one Chrome instance per profile via the DevTools
 * Protocol (CDP). No puppeteer — we spawn real Chrome with
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
  throw new Error(`DevTools on port ${port} did not come up`);
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
    throw new Error(`No free port in range ${portStart}-${portEnd}`);
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
      throw new Error('Chrome executable not found — set it in CDP settings');
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

    logger.info('cdp', `Launching Chrome for "${profile.label}" on port ${port}`);
    const proc = spawn(chromePath, args, { detached: false, stdio: 'ignore' });
    proc.on('exit', (code) => {
      logger.warn('cdp', `Chrome for "${profile.label}" exited (code ${code})`);
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
      logger.warn('cdp', `Fingerprint install for "${profile.label}" failed: ${e.message}`);
    }

    logger.success('cdp', `Profile "${profile.label}" is live on port ${port}`);
    return inst;
  }

  /**
   * Scan the profile's Gmail tab to determine auth status. Reads the DOM for
   * signals of a logged-in inbox vs a sign-in screen.
   */
  async scanGmail(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.pageCdp) throw new Error('Profile is not running');
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
    logger.info('gmail', `Scan "${profileId}": ${status}${parsed.email ? ' (' + parsed.email + ')' : ''}`);
    return { status, email: parsed.email || '', href: parsed.href || '' };
  }

  async navigate(profileId, url) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.pageCdp) throw new Error('Profile is not running');
    await inst.pageCdp.send('Page.navigate', { url });
  }

  async stop(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst) return;
    try { inst.cdp.close(); } catch (_e) {}
    try { inst.pageCdp && inst.pageCdp.close(); } catch (_e) {}
    try { inst.proc.kill(); } catch (_e) {}
    this.instances.delete(profileId);
    logger.info('cdp', `Stopped profile ${profileId}`);
  }

  async stopAll() {
    for (const id of [...this.instances.keys()]) {
      await this.stop(id);
    }
  }
}

module.exports = { ChromeManager, resolveChrome };
