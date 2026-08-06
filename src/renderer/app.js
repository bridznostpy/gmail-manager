'use strict';
/* Renderer app: navigation + all module views. Vanilla JS, no framework.
   Talks to main only through window.api (see preload.js). */

const api = window.api;
const ICONS = window.ICONS;

const state = {
  route: 'dashboard',
  settings: null,
  profiles: [],
  selectedProfile: null,
  runStatus: { running: false, uptimeSec: 0, queueSize: 0 },
};

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'profiles', label: 'Profiles', icon: 'profiles' },
  { id: 'parser', label: 'Parser', icon: 'parser' },
  { id: 'cdp', label: 'Chrome CDP', icon: 'cdp' },
  { id: 'link', label: 'Link Generator', icon: 'link' },
  { id: 'telegram', label: 'Telegram', icon: 'telegram' },
  { id: 'settings', label: 'System Settings', icon: 'settings' },
];

// ── helpers ────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.className = 'toast show ' + kind;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast ' + kind), 2600);
}

async function saveSection(key, patch) {
  state.settings[key] = await api.settings.setSection(key, patch);
}

const debounce = (fn, ms = 400) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── theme ──────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#themeIcon').innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveSection('theme', next);
  state.settings.theme = next;
}

// ── nav ────────────────────────────────────────────────────────────
function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const item of NAV) {
    const el = h(`<div class="nav-item ${state.route === item.id ? 'active' : ''}" data-route="${item.id}">
      <span class="icon">${ICONS[item.icon]}</span><span>${item.label}</span></div>`);
    el.addEventListener('click', () => go(item.id));
    nav.appendChild(el);
  }
}

function go(route) {
  state.route = route;
  renderNav();
  render();
}

// panel toggler
function wirePanels(root) {
  $$('.panel-head', root).forEach((head) => {
    head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
  });
}

// ── views ──────────────────────────────────────────────────────────
function render() {
  const main = $('#main');
  const view = VIEWS[state.route];
  main.innerHTML = '';
  main.appendChild(view());
  wirePanels(main);
}

const VIEWS = {};

// Dashboard
VIEWS.dashboard = () => {
  const r = state.runStatus;
  const wrap = h(`<div>
    <div class="view-header">
      <div><div class="view-title">Dashboard</div><div class="view-sub">Live status and process logs</div></div>
      <div id="runControls"></div>
    </div>
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="stat"><div class="label">Status</div><div class="value" id="dStatus"></div></div>
      <div class="stat"><div class="label">Uptime</div><div class="value" id="dUptime">0s</div></div>
      <div class="stat"><div class="label">Queue</div><div class="value accent" id="dQueue">0</div></div>
      <div class="stat"><div class="label">Ready accounts</div><div class="value green" id="dReady">0</div></div>
    </div>
    <div class="card"><h3>Live logs</h3><div class="logs" id="logs"></div></div>
  </div>`);

  const controls = wrap.querySelector('#runControls');
  const startBtn = h(`<button class="btn primary big">${ICONS.play}<span>Start</span></button>`);
  const stopBtn = h(`<button class="btn big">${ICONS.stop}<span>Stop</span></button>`);
  startBtn.addEventListener('click', async () => {
    const res = await api.run.start();
    if (!res.ok) toast('Cannot start: ' + (res.reason || 'unknown'), 'error');
    else toast('Run started', 'success');
    refreshRun();
  });
  stopBtn.addEventListener('click', async () => { await api.run.stop(); toast('Run stopped'); refreshRun(); });
  controls.append(startBtn, stopBtn);

  setTimeout(async () => {
    paintRun();
    const recent = await api.logs.recent(200);
    recent.forEach(appendLog);
  }, 0);
  return wrap;
};

function paintRun() {
  const r = state.runStatus;
  const st = $('#dStatus');
  if (st) st.innerHTML = r.running ? '<span class="pill on">● Running</span>' : '<span class="pill off">● Stopped</span>';
  const up = $('#dUptime'); if (up) up.textContent = fmtUptime(r.uptimeSec);
  const q = $('#dQueue'); if (q) q.textContent = r.queueSize;
  const ready = $('#dReady'); if (ready) ready.textContent = state.profiles.filter((p) => p.gmailStatus === 'ready').length;
}

function fmtUptime(sec) {
  if (!sec) return '0s';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
}

function appendLog(entry) {
  const box = $('#logs');
  if (!box) return;
  const time = new Date(entry.ts).toLocaleTimeString();
  const line = h(`<div class="log-line ${entry.level}"><span class="t">${time}</span><span class="s">[${entry.scope}]</span><span class="m">${esc(entry.message)}</span></div>`);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 400) box.removeChild(box.firstChild);
}

// Profiles
VIEWS.profiles = () => {
  const s = state.profileStats || { total: 0, running: 0, gmailReady: 0, portsOpen: 0 };
  const wrap = h(`<div>
    <div class="view-header">
      <div><div class="view-title">Profiles</div><div class="view-sub">One Chrome instance per Gmail account</div></div>
      <button class="btn primary" id="newProfile">${ICONS.plus}<span>New profile</span></button>
    </div>
    <div class="grid cols-4" style="margin-bottom:18px">
      <div class="stat"><div class="label">Total</div><div class="value" id="sTotal">${s.total}</div></div>
      <div class="stat"><div class="label">Running</div><div class="value accent" id="sRun">${s.running}</div></div>
      <div class="stat"><div class="label">Gmail ready</div><div class="value green" id="sReady">${s.gmailReady}</div></div>
      <div class="stat"><div class="label">Ports open</div><div class="value" id="sPorts">${s.portsOpen}</div></div>
    </div>
    <div class="split">
      <div class="grid cols-2" id="cards"></div>
      <div id="detail"></div>
    </div>
  </div>`);

  wrap.querySelector('#newProfile').addEventListener('click', async () => {
    const label = prompt('Profile name:', 'Profile ' + (state.profiles.length + 1));
    if (label === null) return;
    const p = await api.profiles.create(label);
    toast('Profile created — launch it to open Gmail for login', 'success');
    await refreshProfiles();
    state.selectedProfile = p.id;
    // auto-launch with gmail for manual authorization
    launchProfile(p.id, true);
  });

  setTimeout(() => { renderProfileCards(wrap); renderProfileDetail(wrap); }, 0);
  return wrap;
};

function renderProfileCards(root) {
  const cards = root.querySelector('#cards') || $('#cards');
  if (!cards) return;
  cards.innerHTML = '';
  if (!state.profiles.length) {
    cards.appendChild(h(`<div class="empty">No profiles yet. Create one to start.</div>`));
    return;
  }
  for (const p of state.profiles) {
    const card = h(`<div class="profile-card ${state.selectedProfile === p.id ? 'selected' : ''}">
      <div class="pc-head">
        <div><div class="pc-name"><span class="dot ${p.gmailStatus}"></span> ${esc(p.label)}</div>
        <div class="pc-email">${esc(p.email || 'not signed in')}</div></div>
        <span class="badge ${p.gmailStatus}">${p.gmailStatus}</span>
      </div>
      <div class="pc-meta">
        <span>${p.running ? '🟢 running' : '⚪ stopped'}</span>
        <span>port: ${p.port || '—'}</span>
        <span>sent: ${p.sentCount}</span>
      </div>
    </div>`);
    card.addEventListener('click', () => { state.selectedProfile = p.id; render(); });
    cards.appendChild(card);
  }
}

function renderProfileDetail(root) {
  const box = root.querySelector('#detail') || $('#detail');
  if (!box) return;
  const p = state.profiles.find((x) => x.id === state.selectedProfile);
  if (!p) { box.innerHTML = `<div class="card"><div class="empty">Select a profile to see details.</div></div>`; return; }
  const fp = p.fingerprint;
  box.innerHTML = '';
  const card = h(`<div class="card">
    <h3><span class="dot ${p.gmailStatus}"></span> ${esc(p.label)}</h3>
    <div class="kv"><span class="k">Status</span><span class="v"><span class="badge ${p.gmailStatus}">${p.gmailStatus}</span></span></div>
    <div class="kv"><span class="k">Email</span><span class="v">${esc(p.email || '—')}</span></div>
    <div class="kv"><span class="k">Running</span><span class="v">${p.running ? 'yes' : 'no'}</span></div>
    <div class="kv"><span class="k">Port</span><span class="v">${p.port || '—'}</span></div>
    <div class="kv"><span class="k">Sent</span><span class="v">${p.sentCount}</span></div>
    <div class="kv"><span class="k">UA</span><span class="v" style="max-width:200px;text-align:right">${esc(fp.userAgent)}</span></div>
    <div class="kv"><span class="k">Platform</span><span class="v">${esc(fp.platform)}</span></div>
    <div class="kv"><span class="k">Screen</span><span class="v">${fp.screen.width}×${fp.screen.height}</span></div>
    <div class="kv"><span class="k">Timezone</span><span class="v">${esc(fp.timezone)}</span></div>
    <div class="kv"><span class="k">GPU</span><span class="v" style="max-width:200px;text-align:right">${esc(fp.webgl.renderer)}</span></div>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="btn primary" id="dLaunch">${p.running ? 'Reopen Gmail' : ICONS.play + ' Launch'}</button>
      <button class="btn" id="dScan">${ICONS.scan}<span>Scan</span></button>
      ${p.running ? '<button class="btn" id="dStop">' + ICONS.stop + ' Stop</button>' : ''}
      <button class="btn danger" id="dDel">${ICONS.trash}<span>Delete</span></button>
    </div>
  </div>`);
  card.querySelector('#dLaunch').addEventListener('click', () => launchProfile(p.id, true));
  card.querySelector('#dScan').addEventListener('click', async () => {
    toast('Scanning Gmail…');
    try { await api.profiles.scan(p.id); await refreshProfiles(); toast('Scan complete', 'success'); }
    catch (e) { toast('Scan failed: ' + e.message, 'error'); }
  });
  const stopBtn = card.querySelector('#dStop');
  if (stopBtn) stopBtn.addEventListener('click', async () => { await api.profiles.stop(p.id); await refreshProfiles(); });
  card.querySelector('#dDel').addEventListener('click', async () => {
    if (!confirm('Delete this profile? Its Chrome data folder stays on disk.')) return;
    await api.profiles.remove(p.id); state.selectedProfile = null; await refreshProfiles();
  });
  box.appendChild(card);
}

async function launchProfile(id, openGmail) {
  toast('Launching Chrome…');
  try { await api.profiles.launch(id, openGmail); await refreshProfiles(); toast('Chrome launched — sign in to Gmail manually', 'success'); }
  catch (e) { toast('Launch failed: ' + e.message, 'error'); }
}

// Parser
VIEWS.parser = () => {
  const p = state.settings.parser;
  const PLATFORMS = [{ id: 'usa', label: 'USA' }, { id: 'poshmark', label: 'Poshmark' }];
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">Parser</div><div class="view-sub">Lead source and template policy</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.parser} API & source</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>API key</label><input type="password" id="pKey" value="${esc(p.apiKey)}" placeholder="parser api key"/></div>
          <div class="field" style="max-width:180px"><label>Type</label>
            <div class="seg" id="pType">
              <button data-v="xproject" class="${p.apiType === 'xproject' ? 'active' : ''}">xproject</button>
              <button data-v="vvs" class="${p.apiType === 'vvs' ? 'active' : ''}">vvs</button>
            </div>
          </div>
        </div>
        <div class="field"><label>Platforms (filter by country)</label><div class="chips" id="pPlat">
          ${PLATFORMS.map((x) => `<div class="chip ${p.platforms.includes(x.id) ? 'on' : ''}" data-v="${x.id}">${x.label}</div>`).join('')}
        </div></div>
      </div>
    </div>
    <div class="panel open"><div class="panel-head"><h3>Behaviour</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="field"><label class="switch"><input type="checkbox" id="pEnabled" ${p.enabled ? 'checked' : ''}/><span class="track"></span><span class="lbl">Parser enabled</span></label></div>
        <div class="field"><label class="switch"><input type="checkbox" id="pAi" ${p.aiTemplateSwap ? 'checked' : ''}/><span class="track"></span><span class="lbl">Swap templates via AI</span></label></div>
        <div class="field" style="max-width:280px"><label>Rotate API key every N messages (0 = never)</label><input type="number" id="pSwapN" min="0" value="${p.swapKeyEveryN}"/></div>
      </div>
    </div>
  </div>`);

  wrap.querySelector('#pKey').addEventListener('input', debounce((e) => saveSection('parser', { apiKey: e.target.value })));
  $$('#pType button', wrap).forEach((b) => b.addEventListener('click', () => {
    $$('#pType button', wrap).forEach((x) => x.classList.remove('active')); b.classList.add('active');
    saveSection('parser', { apiType: b.dataset.v });
  }));
  $$('#pPlat .chip', wrap).forEach((c) => c.addEventListener('click', () => {
    c.classList.toggle('on');
    const sel = $$('#pPlat .chip.on', wrap).map((x) => x.dataset.v);
    saveSection('parser', { platforms: sel });
  }));
  wrap.querySelector('#pEnabled').addEventListener('change', (e) => saveSection('parser', { enabled: e.target.checked }));
  wrap.querySelector('#pAi').addEventListener('change', (e) => saveSection('parser', { aiTemplateSwap: e.target.checked }));
  wrap.querySelector('#pSwapN').addEventListener('input', debounce((e) => saveSection('parser', { swapKeyEveryN: +e.target.value || 0 })));
  return wrap;
};

// Chrome CDP
VIEWS.cdp = () => {
  const c = state.settings.cdp;
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">Chrome CDP</div><div class="view-sub">DevTools Protocol port range and Chrome binary</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.cdp} Port range</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>Port start</label><input type="number" id="cStart" value="${c.portStart}"/></div>
          <div class="field"><label>Port end</label><input type="number" id="cEnd" value="${c.portEnd}"/></div>
        </div>
        <div class="field"><label>Chrome path (blank = auto-detect)</label><input type="text" id="cPath" value="${esc(c.chromePath)}" placeholder="auto"/></div>
        <button class="btn" id="cDetect">Detect Chrome</button>
        <div class="hint" id="cDetected" style="margin-top:10px"></div>
      </div>
    </div>
  </div>`);
  wrap.querySelector('#cStart').addEventListener('input', debounce((e) => saveSection('cdp', { portStart: +e.target.value || 9222 })));
  wrap.querySelector('#cEnd').addEventListener('input', debounce((e) => saveSection('cdp', { portEnd: +e.target.value || 9322 })));
  wrap.querySelector('#cPath').addEventListener('input', debounce((e) => saveSection('cdp', { chromePath: e.target.value })));
  wrap.querySelector('#cDetect').addEventListener('click', async () => {
    const path = await api.cdp.detectChrome();
    wrap.querySelector('#cDetected').textContent = path ? 'Found: ' + path : 'Chrome not found — set the path manually.';
  });
  return wrap;
};

// Link generator
VIEWS.link = () => {
  const l = state.settings.link;
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">Link Generator</div><div class="view-sub">Order links via team API</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.link} Haron Rent</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>API key</label><input type="password" id="lKey" value="${esc(l.apiKey)}"/></div>
          <div class="field" style="max-width:200px"><label>Team</label>
            <select id="lTeam"><option value="haron_rent" ${l.team === 'haron_rent' ? 'selected' : ''}>Haron Rent</option></select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>Link mode</label><input type="text" id="lMode" value="${esc(l.mode)}" placeholder="mode"/></div>
          <div class="field"><label>Profile ID</label><input type="text" id="lPid" value="${esc(l.profileId)}"/></div>
          <div class="field" style="max-width:140px"><label>Country</label>
            <select id="lCountry"><option value="US" ${l.country === 'US' ? 'selected' : ''}>US</option></select>
          </div>
        </div>
        <div class="hint">Endpoints wire in from the Haron Rent API docs (see src/main/link/haronRent.js).</div>
      </div>
    </div>
  </div>`);
  wrap.querySelector('#lKey').addEventListener('input', debounce((e) => saveSection('link', { apiKey: e.target.value })));
  wrap.querySelector('#lTeam').addEventListener('change', (e) => saveSection('link', { team: e.target.value }));
  wrap.querySelector('#lMode').addEventListener('input', debounce((e) => saveSection('link', { mode: e.target.value })));
  wrap.querySelector('#lPid').addEventListener('input', debounce((e) => saveSection('link', { profileId: e.target.value })));
  wrap.querySelector('#lCountry').addEventListener('change', (e) => saveSection('link', { country: e.target.value }));
  return wrap;
};

// Telegram
VIEWS.telegram = () => {
  const t = state.settings.telegram;
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">Telegram</div><div class="view-sub">Notifications when limits are reached</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.telegram} Bot</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="field"><label>Bot token</label><input type="password" id="tToken" value="${esc(t.botToken)}"/></div>
        <div class="field"><label>Chat / Bot ID</label><input type="text" id="tId" value="${esc(t.botId)}"/></div>
        <button class="btn" id="tTest">Test token</button>
        <div class="hint" id="tResult" style="margin-top:10px"></div>
      </div>
    </div>
  </div>`);
  wrap.querySelector('#tToken').addEventListener('input', debounce((e) => saveSection('telegram', { botToken: e.target.value })));
  wrap.querySelector('#tId').addEventListener('input', debounce((e) => saveSection('telegram', { botId: e.target.value })));
  wrap.querySelector('#tTest').addEventListener('click', async () => {
    const res = await api.telegram.test(wrap.querySelector('#tToken').value);
    wrap.querySelector('#tResult').textContent = res && res.ok
      ? 'OK — @' + (res.result && res.result.username || 'bot')
      : 'Token invalid or no network.';
  });
  return wrap;
};

// System settings
VIEWS.settings = () => {
  const s = state.settings.system;
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">System Settings</div><div class="view-sub">Limits, intervals and parser tuning</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.settings} Limits & intervals</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>Mails per account</label><input type="number" id="mMails" min="1" value="${s.mailsPerAccount}"/></div>
          <div class="field"><label>Max replies per dialog</label><input type="number" id="mReplies" min="0" value="${s.maxRepliesPerDialog}"/></div>
        </div>
        <div class="row">
          <div class="field"><label>Check interval (sec)</label><input type="number" id="mCheck" min="3" value="${s.checkIntervalSec}"/></div>
          <div class="field"><label>Parser batch size</label><input type="number" id="mBatch" min="1" value="${s.parserBatchSize}"/></div>
          <div class="field"><label>Queue refill threshold</label><input type="number" id="mThresh" min="0" value="${s.queueRefillThreshold}"/></div>
        </div>
      </div>
    </div>
    <div class="panel open"><div class="panel-head"><h3>Broadcast texts</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="field"><label>Paste texts JSON (see data/texts.example.json)</label><textarea id="mTexts" placeholder='{ "subjects": [...], "bodies": [...] }'>${state.settings.texts ? esc(JSON.stringify(state.settings.texts, null, 2)) : ''}</textarea></div>
        <button class="btn primary" id="mLoadTexts">Load texts</button>
        <div class="hint" id="mTextsResult" style="margin-top:8px"></div>
      </div>
    </div>
  </div>`);
  const bind = (id, key) => wrap.querySelector(id).addEventListener('input', debounce((e) => saveSection('system', { [key]: +e.target.value || 0 })));
  bind('#mMails', 'mailsPerAccount'); bind('#mReplies', 'maxRepliesPerDialog'); bind('#mCheck', 'checkIntervalSec');
  bind('#mBatch', 'parserBatchSize'); bind('#mThresh', 'queueRefillThreshold');
  wrap.querySelector('#mLoadTexts').addEventListener('click', async () => {
    try {
      const json = JSON.parse(wrap.querySelector('#mTexts').value);
      state.settings.texts = await api.settings.loadTexts(json);
      wrap.querySelector('#mTextsResult').textContent = 'Loaded ✓';
      toast('Texts loaded', 'success');
    } catch (e) { wrap.querySelector('#mTextsResult').textContent = 'Invalid JSON: ' + e.message; }
  });
  return wrap;
};

// ── data refresh ───────────────────────────────────────────────────
async function refreshProfiles() {
  state.profiles = await api.profiles.list();
  state.profileStats = await api.profiles.stats();
  if (state.route === 'profiles') render();
  else if (state.route === 'dashboard') paintRun();
}
async function refreshRun() {
  state.runStatus = await api.run.status();
  if (state.route === 'dashboard') paintRun();
}

// ── boot ───────────────────────────────────────────────────────────
async function boot() {
  state.settings = await api.settings.getAll();
  applyTheme(state.settings.theme || 'dark');
  $('#themeToggle').addEventListener('click', toggleTheme);

  await refreshProfiles();
  await refreshRun();

  api.logs.onEntry((entry) => appendLog(entry));
  setInterval(refreshRun, 1000);
  setInterval(refreshProfiles, 4000);

  renderNav();
  render();
}

boot();
