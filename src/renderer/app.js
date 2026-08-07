'use strict';
/* Renderer app: navigation + all module views. Vanilla JS, no framework.
   Talks to main only through window.api (see preload.js).
   Все пользовательские строки идут через window.I18N (см. i18n.js).

   Wrapped in an IIFE: `window.api` is exposed by contextBridge as a
   non-configurable global property, so a top-level `const api` would throw
   "Identifier 'api' has already been declared". Function scope avoids that. */

(() => {

const api = window.api;
const ICONS = window.ICONS;
const I18N = window.I18N;
const t = (key, params) => I18N.t(key, params);

const state = {
  route: 'dashboard',
  settings: null,
  profiles: [],
  selectedProfile: null,
  runStatus: { running: false, uptimeSec: 0, queueSize: 0 },
};

const NAV = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'dashboard' },
  { id: 'profiles', labelKey: 'nav.profiles', icon: 'profiles' },
  { id: 'parser', labelKey: 'nav.parser', icon: 'parser' },
  { id: 'cdp', labelKey: 'nav.cdp', icon: 'cdp' },
  { id: 'link', labelKey: 'nav.link', icon: 'link' },
  { id: 'telegram', labelKey: 'nav.telegram', icon: 'telegram' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings' },
];

// ── helpers ────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dash = '-'; // прочерк для пустых значений

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.className = 'toast show ' + kind;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast ' + kind), 2600);
}

async function saveSection(key, patch) {
  state.settings[key] = await api.settings.setSection(key, patch);
}

const debounce = (fn, ms = 400) => { let timer; return (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), ms); }; };

// Electron does not support window.prompt() (it throws), so use an in-app modal
// text input. Resolves to the entered string, or null if cancelled.
function askText(title, opts = {}) {
  return new Promise((resolve) => {
    const overlay = h(`<div class="modal-overlay">
      <div class="modal card">
        <h3>${esc(title)}</h3>
        <div class="field"><input type="text" id="askInput" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}"/></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button class="btn" id="askCancel">${esc(t('common.cancel'))}</button>
          <button class="btn primary" id="askOk">${esc(t('common.ok'))}</button>
        </div>
      </div></div>`);
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#askInput');
    input.focus();
    input.select();
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#askOk').addEventListener('click', () => done(input.value));
    overlay.querySelector('#askCancel').addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      else if (e.key === 'Escape') done(null);
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
  });
}

// ── theme ──────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#themeIcon').innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
  $('#themeLabel').textContent = t('app.theme');
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveSection('theme', next);
  state.settings.theme = next;
}

// ── language ───────────────────────────────────────────────────────
async function setLanguage(lang) {
  if (lang === I18N.getLanguage()) return;
  I18N.setLanguage(lang);
  await saveSection('language', lang);
  applyTheme(document.documentElement.getAttribute('data-theme'));
  renderNav();
  render();
}

// ── nav ────────────────────────────────────────────────────────────
function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const item of NAV) {
    const el = h(`<div class="nav-item ${state.route === item.id ? 'active' : ''}" data-route="${item.id}">
      <span class="icon">${ICONS[item.icon]}</span><span>${esc(t(item.labelKey))}</span></div>`);
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
  const wrap = h(`<div>
    <div class="view-header">
      <div><div class="view-title">${esc(t('dash.title'))}</div><div class="view-sub">${esc(t('dash.sub'))}</div></div>
      <div id="runControls" style="display:flex;gap:8px"></div>
    </div>
    <div class="grid cols-4" style="margin-bottom:16px">
      <div class="stat"><div class="label">${esc(t('dash.status'))}</div><div class="value" id="dStatus"></div></div>
      <div class="stat"><div class="label">${esc(t('dash.uptime'))}</div><div class="value" id="dUptime">0s</div></div>
      <div class="stat"><div class="label">${esc(t('dash.queue'))}</div><div class="value accent" id="dQueue">0</div></div>
      <div class="stat"><div class="label">${esc(t('dash.ready'))}</div><div class="value green" id="dReady">0</div></div>
    </div>
    <div class="card"><h3>${esc(t('dash.logs'))}</h3><div class="logs" id="logs"></div></div>
  </div>`);

  const controls = wrap.querySelector('#runControls');
  const startBtn = h(`<button class="btn primary big">${ICONS.play}<span>${esc(t('dash.start'))}</span></button>`);
  const stopBtn = h(`<button class="btn big">${ICONS.stop}<span>${esc(t('dash.stop'))}</span></button>`);
  startBtn.addEventListener('click', async () => {
    const res = await api.run.start();
    if (!res.ok) {
      const reason = res.reason ? t('reason.' + res.reason) : t('dash.startFailedUnknown');
      toast(t('dash.startFailed', { reason }), 'error');
    }
    else toast(t('dash.started'), 'success');
    refreshRun();
  });
  stopBtn.addEventListener('click', async () => { await api.run.stop(); toast(t('dash.stoppedToast')); refreshRun(); });
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
  if (st) {
    st.innerHTML = r.running
      ? `<span class="pill on">● ${esc(t('dash.running'))}</span>`
      : `<span class="pill off">● ${esc(t('dash.stopped'))}</span>`;
  }
  const up = $('#dUptime'); if (up) up.textContent = fmtUptime(r.uptimeSec);
  const q = $('#dQueue'); if (q) q.textContent = r.queueSize;
  const ready = $('#dReady'); if (ready) ready.textContent = state.profiles.filter((p) => p.gmailStatus === 'ready').length;
}

function fmtUptime(sec) {
  if (!sec) return '0s';
  const hrs = Math.floor(sec / 3600), min = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (hrs ? hrs + 'h ' : '') + (min ? min + 'm ' : '') + s + 's';
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
      <div><div class="view-title">${esc(t('prof.title'))}</div><div class="view-sub">${esc(t('prof.sub'))}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="nudgeBtn">${ICONS.send}<span>${esc(t('nudge.btn'))}</span></button>
        <button class="btn primary" id="newProfile">${ICONS.plus}<span>${esc(t('prof.new'))}</span></button>
      </div>
    </div>
    <div class="grid cols-4" style="margin-bottom:18px">
      <div class="stat"><div class="label">${esc(t('prof.total'))}</div><div class="value" id="sTotal">${s.total}</div></div>
      <div class="stat"><div class="label">${esc(t('prof.runningCount'))}</div><div class="value accent" id="sRun">${s.running}</div></div>
      <div class="stat"><div class="label">${esc(t('prof.gmailReady'))}</div><div class="value green" id="sReady">${s.gmailReady}</div></div>
      <div class="stat"><div class="label">${esc(t('prof.portsOpen'))}</div><div class="value" id="sPorts">${s.portsOpen}</div></div>
    </div>
    <div class="split">
      <div class="grid cols-2" id="cards"></div>
      <div id="detail"></div>
    </div>
  </div>`);

  wrap.querySelector('#nudgeBtn').addEventListener('click', async () => {
    const email = await askText(t('nudge.ask'), { placeholder: 'seller@example.com' });
    if (!email) return;
    toast(t('nudge.sending'));
    try {
      const res = await api.contacts.nudge(email.trim());
      if (res && res.ok) { toast(t('nudge.ok'), 'success'); await refreshProfiles(); }
      else toast(t('nudge.fail.' + ((res && res.reason) || 'unknown')), 'error');
    } catch (e) { toast(t('nudge.error', { error: e.message }), 'error'); }
  });

  wrap.querySelector('#newProfile').addEventListener('click', async () => {
    const label = await askText(t('prof.askName'), { value: t('prof.defaultName', { n: state.profiles.length + 1 }) });
    if (label === null) return;
    const p = await api.profiles.create(label);
    toast(t('prof.created'), 'success');
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
    cards.appendChild(h(`<div class="empty">${esc(t('prof.empty'))}</div>`));
    return;
  }
  for (const p of state.profiles) {
    const card = h(`<div class="profile-card ${state.selectedProfile === p.id ? 'selected' : ''}">
      <div class="pc-head">
        <div><div class="pc-name"><span class="dot ${p.gmailStatus}"></span> ${esc(p.label)}</div>
        <div class="pc-email">${esc(p.email || t('prof.notSignedIn'))}</div></div>
        <span class="badge ${p.gmailStatus}">${esc(t('status.' + p.gmailStatus))}</span>
      </div>
      <div class="pc-meta">
        <span>${p.running ? '🟢 ' + esc(t('prof.running')) : '⚪ ' + esc(t('prof.stopped'))}</span>
        <span>${esc(t('prof.port'))}: ${p.port || dash}</span>
        <span>${esc(t('prof.sent'))}: ${p.sentCount}</span>
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
  if (!p) { box.innerHTML = `<div class="card"><div class="empty">${esc(t('prof.selectHint'))}</div></div>`; return; }
  const fp = p.fingerprint;
  box.innerHTML = '';
  const card = h(`<div class="card">
    <h3><span class="dot ${p.gmailStatus}"></span> ${esc(p.label)}</h3>
    <div class="kv"><span class="k">${esc(t('prof.status'))}</span><span class="v"><span class="badge ${p.gmailStatus}">${esc(t('status.' + p.gmailStatus))}</span></span></div>
    <div class="kv"><span class="k">${esc(t('prof.email'))}</span><span class="v">${esc(p.email || dash)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.isRunning'))}</span><span class="v">${p.running ? esc(t('common.yes')) : esc(t('common.no'))}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.port'))}</span><span class="v">${p.port || dash}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.sentCount'))}</span><span class="v">${p.sentCount}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.ua'))}</span><span class="v" style="max-width:210px">${esc(fp.userAgent)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.platform'))}</span><span class="v">${esc(fp.platform)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.screen'))}</span><span class="v">${fp.screen.width}×${fp.screen.height}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.timezone'))}</span><span class="v">${esc(fp.timezone)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.gpu'))}</span><span class="v" style="max-width:210px">${esc(fp.webgl.renderer)}</span></div>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="btn primary" id="dLaunch">${p.running ? esc(t('prof.reopen')) : ICONS.play + '<span>' + esc(t('prof.launch')) + '</span>'}</button>
      <button class="btn" id="dScan">${ICONS.scan}<span>${esc(t('prof.scan'))}</span></button>
      ${p.running ? '<button class="btn" id="dTest">' + ICONS.send + '<span>' + esc(t('prof.testSend')) + '</span></button>' : ''}
      ${p.running ? '<button class="btn" id="dStop">' + ICONS.stop + '<span>' + esc(t('prof.stopBtn')) + '</span></button>' : ''}
      <button class="btn danger" id="dDel">${ICONS.trash}<span>${esc(t('prof.delete'))}</span></button>
    </div>
  </div>`);
  card.querySelector('#dLaunch').addEventListener('click', () => launchProfile(p.id, true));
  card.querySelector('#dScan').addEventListener('click', async () => {
    toast(t('prof.scanning'));
    try { await api.profiles.scan(p.id); await refreshProfiles(); toast(t('prof.scanDone'), 'success'); }
    catch (e) { toast(t('prof.scanFailed', { error: e.message }), 'error'); }
  });
  const testBtn = card.querySelector('#dTest');
  if (testBtn) testBtn.addEventListener('click', async () => {
    const to = await askText(t('prof.askTestTo'), { value: p.email || '', placeholder: 'recipient@example.com' });
    if (!to) return;
    toast(t('prof.testSending'));
    try {
      const res = await api.gmail.testSend(p.id, {
        to,
        subject: t('prof.testSubject'),
        body: t('prof.testBody'),
      });
      const ok = !!(res && res.ok);
      toast(ok ? t('prof.testSent') : t('prof.testUnconfirmed'), ok ? 'success' : 'error');
    } catch (e) { toast(t('prof.testFailed', { error: e.message }), 'error'); }
  });
  const stopBtn = card.querySelector('#dStop');
  if (stopBtn) stopBtn.addEventListener('click', async () => { await api.profiles.stop(p.id); await refreshProfiles(); });
  card.querySelector('#dDel').addEventListener('click', async () => {
    if (!confirm(t('prof.confirmDelete'))) return;
    await api.profiles.remove(p.id); state.selectedProfile = null; await refreshProfiles();
  });
  box.appendChild(card);
}

async function launchProfile(id, openGmail) {
  toast(t('prof.launching'));
  try { await api.profiles.launch(id, openGmail); await refreshProfiles(); toast(t('prof.launched'), 'success'); }
  catch (e) { toast(t('prof.launchFailed', { error: e.message }), 'error'); }
}

// Parser
VIEWS.parser = () => {
  const p = state.settings.parser;
  const PLATFORMS = [{ id: 'usa', label: 'USA' }, { id: 'poshmark', label: 'Poshmark' }];
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">${esc(t('parser.title'))}</div><div class="view-sub">${esc(t('parser.sub'))}</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.parser} ${esc(t('parser.apiSource'))}</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>${esc(t('parser.apiKey'))}</label><input type="password" id="pKey" value="${esc(p.apiKey)}" placeholder="${esc(t('parser.apiKeyPh'))}"/></div>
          <div class="field" style="flex:0 0 190px"><label>${esc(t('parser.type'))}</label>
            <div class="seg" id="pType">
              <button data-v="xproject" class="${p.apiType === 'xproject' ? 'active' : ''}">xproject</button>
              <button data-v="vvs" class="${p.apiType === 'vvs' ? 'active' : ''}">vvs</button>
            </div>
          </div>
        </div>
        <div class="field"><label>${esc(t('parser.platforms'))}</label><div class="chips" id="pPlat">
          ${PLATFORMS.map((x) => `<div class="chip ${p.platforms.includes(x.id) ? 'on' : ''}" data-v="${x.id}">${x.label}</div>`).join('')}
        </div></div>
      </div>
    </div>
    <div class="panel open"><div class="panel-head"><h3>${esc(t('parser.behaviour'))}</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="field"><label class="switch"><input type="checkbox" id="pEnabled" ${p.enabled ? 'checked' : ''}/><span class="track"></span><span class="lbl">${esc(t('parser.enabled'))}</span></label></div>
        <div class="field"><label class="switch"><input type="checkbox" id="pAi" ${p.aiTemplateSwap ? 'checked' : ''}/><span class="track"></span><span class="lbl">${esc(t('parser.aiSwap'))}</span></label></div>
        <div class="field" style="max-width:340px"><label>${esc(t('parser.swapN'))}</label><input type="number" id="pSwapN" min="0" value="${p.swapKeyEveryN}"/></div>
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
    <div class="view-header"><div><div class="view-title">${esc(t('cdp.title'))}</div><div class="view-sub">${esc(t('cdp.sub'))}</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.cdp} ${esc(t('cdp.portRange'))}</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>${esc(t('cdp.portStart'))}</label><input type="number" id="cStart" value="${c.portStart}"/></div>
          <div class="field"><label>${esc(t('cdp.portEnd'))}</label><input type="number" id="cEnd" value="${c.portEnd}"/></div>
        </div>
        <div class="field"><label>${esc(t('cdp.path'))}</label><input type="text" id="cPath" value="${esc(c.chromePath)}" placeholder="${esc(t('cdp.pathPh'))}"/></div>
        <button class="btn" id="cDetect">${esc(t('cdp.detect'))}</button>
        <div class="hint" id="cDetected" style="margin:10px 0 0"></div>
      </div>
    </div>
  </div>`);
  wrap.querySelector('#cStart').addEventListener('input', debounce((e) => saveSection('cdp', { portStart: +e.target.value || 9222 })));
  wrap.querySelector('#cEnd').addEventListener('input', debounce((e) => saveSection('cdp', { portEnd: +e.target.value || 9322 })));
  wrap.querySelector('#cPath').addEventListener('input', debounce((e) => saveSection('cdp', { chromePath: e.target.value })));
  wrap.querySelector('#cDetect').addEventListener('click', async () => {
    const found = await api.cdp.detectChrome();
    wrap.querySelector('#cDetected').textContent = found ? t('cdp.found', { path: found }) : t('cdp.notFound');
  });
  return wrap;
};

// Link generator
VIEWS.link = () => {
  const l = state.settings.link;
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">${esc(t('link.title'))}</div><div class="view-sub">${esc(t('link.sub'))}</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.link} Haron Rent</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>${esc(t('link.apiKey'))}</label><input type="password" id="lKey" value="${esc(l.apiKey)}"/></div>
          <div class="field" style="flex:0 0 210px"><label>${esc(t('link.team'))}</label>
            <select id="lTeam"><option value="haron_rent" ${l.team === 'haron_rent' ? 'selected' : ''}>Haron Rent</option></select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>${esc(t('link.mode'))}</label><input type="text" id="lMode" value="${esc(l.mode)}" placeholder="${esc(t('link.modePh'))}"/></div>
          <div class="field"><label>${esc(t('link.profileId'))}</label><input type="text" id="lPid" value="${esc(l.profileId)}"/></div>
          <div class="field" style="flex:0 0 140px"><label>${esc(t('link.country'))}</label>
            <select id="lCountry"><option value="US" ${l.country === 'US' ? 'selected' : ''}>US</option></select>
          </div>
        </div>
        <div class="hint" style="margin:0">${esc(t('link.hint'))}</div>
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
  const tg = state.settings.telegram;
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">${esc(t('tg.title'))}</div><div class="view-sub">${esc(t('tg.sub'))}</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.telegram} ${esc(t('tg.bot'))}</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="field"><label>${esc(t('tg.token'))}</label><input type="password" id="tToken" value="${esc(tg.botToken)}"/></div>
        <div class="field"><label>${esc(t('tg.chatId'))}</label><input type="text" id="tId" value="${esc(tg.botId)}"/></div>
        <button class="btn" id="tTest">${esc(t('tg.test'))}</button>
        <div class="hint" id="tResult" style="margin:10px 0 0"></div>
      </div>
    </div>
  </div>`);
  wrap.querySelector('#tToken').addEventListener('input', debounce((e) => saveSection('telegram', { botToken: e.target.value })));
  wrap.querySelector('#tId').addEventListener('input', debounce((e) => saveSection('telegram', { botId: e.target.value })));
  wrap.querySelector('#tTest').addEventListener('click', async () => {
    const res = await api.telegram.test(wrap.querySelector('#tToken').value);
    wrap.querySelector('#tResult').textContent = res && res.ok
      ? t('tg.ok', { username: (res.result && res.result.username) || 'bot' })
      : t('tg.fail');
  });
  return wrap;
};

// System settings
VIEWS.settings = () => {
  const s = state.settings.system;
  const lang = I18N.getLanguage();
  const wrap = h(`<div>
    <div class="view-header"><div><div class="view-title">${esc(t('set.title'))}</div><div class="view-sub">${esc(t('set.sub'))}</div></div></div>
    <div class="panel open"><div class="panel-head"><h3>${ICONS.settings} ${esc(t('set.interface'))}</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="field"><label>${esc(t('set.language'))}</label>
          <div class="seg" id="mLang">
            ${I18N.LANGUAGES.map((x) => `<button data-v="${x.id}" class="${lang === x.id ? 'active' : ''}">${esc(x.label)}</button>`).join('')}
          </div>
        </div>
        <div class="hint" style="margin:0">${esc(t('set.langHint'))}</div>
      </div>
    </div>
    <div class="panel open"><div class="panel-head"><h3>${esc(t('set.limits'))}</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="row">
          <div class="field"><label>${esc(t('set.mails'))}</label><input type="number" id="mMails" min="1" value="${s.mailsPerAccount}"/></div>
          <div class="field"><label>${esc(t('set.replies'))}</label><input type="number" id="mReplies" min="0" value="${s.maxRepliesPerDialog}"/></div>
        </div>
        <div class="row">
          <div class="field"><label>${esc(t('set.checkInterval'))}</label><input type="number" id="mCheck" min="3" value="${s.checkIntervalSec}"/></div>
          <div class="field"><label>${esc(t('set.batch'))}</label><input type="number" id="mBatch" min="1" value="${s.parserBatchSize}"/></div>
          <div class="field"><label>${esc(t('set.threshold'))}</label><input type="number" id="mThresh" min="0" value="${s.queueRefillThreshold}"/></div>
        </div>
      </div>
    </div>
    <div class="panel open"><div class="panel-head"><h3>${esc(t('set.texts'))}</h3><span class="chev">${ICONS.chevron}</span></div>
      <div class="panel-body">
        <div class="field"><label>${esc(t('set.textsLabel'))}</label><textarea id="mTexts" placeholder='{ "subjects": [...], "bodies": [...] }'>${state.settings.texts ? esc(JSON.stringify(state.settings.texts, null, 2)) : ''}</textarea></div>
        <button class="btn primary" id="mLoadTexts">${esc(t('set.loadTexts'))}</button>
        <div class="hint" id="mTextsResult" style="margin:10px 0 0"></div>
      </div>
    </div>
  </div>`);

  $$('#mLang button', wrap).forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.v)));
  const bind = (id, key) => wrap.querySelector(id).addEventListener('input', debounce((e) => saveSection('system', { [key]: +e.target.value || 0 })));
  bind('#mMails', 'mailsPerAccount'); bind('#mReplies', 'maxRepliesPerDialog'); bind('#mCheck', 'checkIntervalSec');
  bind('#mBatch', 'parserBatchSize'); bind('#mThresh', 'queueRefillThreshold');
  wrap.querySelector('#mLoadTexts').addEventListener('click', async () => {
    try {
      const json = JSON.parse(wrap.querySelector('#mTexts').value);
      state.settings.texts = await api.settings.loadTexts(json);
      wrap.querySelector('#mTextsResult').textContent = t('set.textsLoaded');
      toast(t('set.textsToast'), 'success');
    } catch (e) { wrap.querySelector('#mTextsResult').textContent = t('set.textsInvalid', { error: e.message }); }
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
  I18N.setLanguage(state.settings.language || 'ru');
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

})();
