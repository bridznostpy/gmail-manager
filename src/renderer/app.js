'use strict';
/* Renderer app: навигация + все экраны. Ванильный JS, без фреймворка.
   С main общается ТОЛЬКО через window.api (см. preload.js).
   Все пользовательские строки идут через window.I18N (см. i18n.js).

   Обёрнуто в IIFE: `window.api` выставлен contextBridge как неконфигурируемое
   свойство, и объявление `const api` на верхнем уровне упало бы с
   "Identifier 'api' has already been declared". Область функции это снимает. */

(() => {

const api = window.api;
const ICONS = window.ICONS;
const I18N = window.I18N;
const t = (key, params) => I18N.t(key, params);

const state = {
  route: 'dashboard',
  booted: false,
  settings: null,
  profiles: [],
  profileStats: null,
  selectedProfile: null,
  // Выбранная группа на странице настроек - переживает уход на другой раздел.
  settingsGroup: 'interface',
  runStatus: { running: false, paused: false, uptimeSec: 0, queueSize: 0 },
  // Живые логи держим массивом, а не только в DOM: иначе их нечем фильтровать.
  logs: [],
  logFilter: { level: 'all', query: '' },
  logFollow: true,
  // Активность отправки за сессию для спарклайна: прирост "отправлено" на тик.
  sendSeries: [],
  lastSentTotal: null,
  // Идёт запрос старт/стоп/пауза - второй клик в это время не нужен.
  runBusy: false,
};

// Разделов ровно три: всё настраиваемое живёт в "Настройках" одним местом,
// а не разбросано по верхней панели (см. SETTINGS_GROUPS).
const ROUTES = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: 'dashboard', titleKey: 'dash.title', subKey: 'dash.sub' },
  { id: 'profiles', labelKey: 'nav.profiles', icon: 'profiles', titleKey: 'prof.title', subKey: 'prof.sub' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', titleKey: 'set.title', subKey: 'set.sub' },
];

// Площадки парсера. Значения - те же ключи, что понимает platformMap клиентов
// (src/main/parser/apis/*.js). Новых сюда не добавлять без документации API.
const PLATFORMS = [
  { id: 'usa', label: 'USA', code: 'us' },
  { id: 'poshmark', label: 'Poshmark', code: 'pm' },
];

const ACCENTS = {
  green: { c: '#3ddc84', c2: '#16b364', rgb: '61, 220, 132', on: '#04120a' },
  violet: { c: '#a78bfa', c2: '#7c4dff', rgb: '167, 139, 250', on: '#0d0620' },
  blue: { c: '#57a6ff', c2: '#2b6fe0', rgb: '87, 166, 255', on: '#04121f' },
  amber: { c: '#ffb443', c2: '#f08a00', rgb: '255, 180, 67', on: '#1c1100' },
  pink: { c: '#ff5fa2', c2: '#e02e7b', rgb: '255, 95, 162', on: '#1f0512' },
};

const BG_PRESETS = {
  aurora: {
    a: 'radial-gradient(42% 46% at 26% 30%, #1f7a4d 0%, transparent 70%)',
    b: 'radial-gradient(46% 40% at 74% 66%, #14506e 0%, transparent 72%)',
  },
  ember: {
    a: 'radial-gradient(44% 48% at 22% 28%, #7a2f1f 0%, transparent 70%)',
    b: 'radial-gradient(46% 42% at 76% 70%, #6e3a14 0%, transparent 72%)',
  },
  abyss: {
    a: 'radial-gradient(46% 50% at 30% 24%, #1b2a66 0%, transparent 70%)',
    b: 'radial-gradient(44% 44% at 72% 72%, #10203f 0%, transparent 72%)',
  },
  orchid: {
    a: 'radial-gradient(44% 48% at 24% 30%, #55206e 0%, transparent 70%)',
    b: 'radial-gradient(46% 42% at 76% 68%, #1f3a72 0%, transparent 72%)',
  },
};

const LOG_LEVELS = ['all', 'info', 'success', 'warn', 'error'];

// ── helpers ────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (html) => { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dash = '-'; // прочерк для пустых значений
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const debounce = (fn, ms = 400) => { let timer; return (...a) => { clearTimeout(timer); timer = setTimeout(() => fn(...a), ms); }; };

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.className = 'toast ' + kind;
  el.innerHTML = `<span></span><span class="bar"></span>`;
  el.firstElementChild.textContent = msg;
  // Перезапуск анимации полоски: без перерисовки она не стартует заново.
  void el.offsetWidth;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast ' + kind), 2600);
}

async function saveSection(key, patch) {
  state.settings[key] = await api.settings.setSection(key, patch);
  return state.settings[key];
}

/** Собрать сворачиваемую панель в одном стиле. */
function panelHtml(open, headHtml, bodyHtml) {
  return `<div class="panel glass ${open ? 'open' : ''}">
    <div class="panel-head">${headHtml}<span class="chev">${ICONS.chevron}</span></div>
    <div class="panel-wrap"><div class="panel-body"><div class="panel-inner">${bodyHtml}</div></div></div>
  </div>`;
}

function wirePanels(root) {
  $$('.panel-head', root).forEach((head) => {
    head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
  });
}

/** Волна от точки клика по кнопке - живой отклик вместо мгновенной смены цвета. */
function wireRipples(root) {
  $$('.btn', root).forEach((btn) => {
    if (btn.dataset.rippled) return;
    btn.dataset.rippled = '1';
    btn.addEventListener('pointerdown', (e) => {
      if (btn.disabled) return;
      const r = btn.getBoundingClientRect();
      const wave = document.createElement('span');
      wave.className = 'ripple';
      wave.style.setProperty('--rx', (e.clientX - r.left) + 'px');
      wave.style.setProperty('--ry', (e.clientY - r.top) + 'px');
      btn.appendChild(wave);
      setTimeout(() => wave.remove(), 600);
    });
  });
}

/** Блик стекла, ползущий за курсором. */
function wireSheen(root) {
  $$('.glass-sheen', root).forEach((el) => {
    if (el.dataset.sheened) return;
    el.dataset.sheened = '1';
    let frame = null;
    el.addEventListener('pointermove', (e) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      });
    });
  });
}

/** Плавный перекат числа. Мелкие изменения не анимируем - дёргается зря. */
function setNumber(el, value) {
  if (!el) return;
  const next = Number(value) || 0;
  const prev = Number(el.dataset.val);
  if (!Number.isFinite(prev) || Math.abs(next - prev) < 1 || document.documentElement.classList.contains('reduce-motion')) {
    el.dataset.val = String(next);
    el.textContent = String(next);
    return;
  }
  el.dataset.val = String(next);
  const from = prev;
  const startedAt = performance.now();
  const dur = 420;
  const tick = (now) => {
    const p = clamp((now - startedAt) / dur, 0, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (next - from) * eased));
    if (p < 1 && Number(el.dataset.val) === next) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Electron не поддерживает window.prompt() (бросает исключение), поэтому
// текстовый ввод и подтверждение - свои модалки в стиле приложения.
function modal(bodyHtml, wire) {
  return new Promise((resolve) => {
    const overlay = h(`<div class="modal-overlay"><div class="modal glass glass-refract">${bodyHtml}</div></div>`);
    document.body.appendChild(overlay);
    wireRipples(overlay);
    const done = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    wire(overlay, done);
  });
}

function askText(title, opts = {}) {
  return modal(
    `<h3>${esc(title)}</h3>
     <div class="field"><input type="text" id="askInput" value="${esc(opts.value || '')}" placeholder="${esc(opts.placeholder || '')}"/></div>
     <div class="modal-actions">
       <button class="btn" id="askCancel">${esc(t('common.cancel'))}</button>
       <button class="btn primary" id="askOk">${esc(t('common.ok'))}</button>
     </div>`,
    (overlay, done) => {
      const input = $('#askInput', overlay);
      input.focus();
      input.select();
      $('#askOk', overlay).addEventListener('click', () => done(input.value));
      $('#askCancel', overlay).addEventListener('click', () => done(null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
    },
  );
}

function askConfirm(title, text, opts = {}) {
  return modal(
    `<h3>${esc(title)}</h3>
     <div class="modal-text">${esc(text)}</div>
     <div class="modal-actions">
       <button class="btn" id="cCancel">${esc(t('common.cancel'))}</button>
       <button class="btn ${opts.danger ? 'stop' : 'primary'}" id="cOk">${esc(opts.okLabel || t('common.ok'))}</button>
     </div>`,
    (overlay, done) => {
      const ok = $('#cOk', overlay);
      ok.focus();
      ok.addEventListener('click', () => done(true));
      $('#cCancel', overlay).addEventListener('click', () => done(null));
    },
  ).then((v) => v === true);
}

// ── оформление ─────────────────────────────────────────────────────
function appearance() {
  return (state.settings && state.settings.appearance) || {};
}

function applyAppearance() {
  const ap = appearance();
  const root = document.documentElement;
  const css = root.style;

  const acc = ACCENTS[ap.accent] || ACCENTS.green;
  css.setProperty('--accent', acc.c);
  css.setProperty('--accent-2', acc.c2);
  css.setProperty('--accent-rgb', acc.rgb);
  css.setProperty('--on-accent', acc.on);

  const preset = BG_PRESETS[ap.bgPreset] || BG_PRESETS.aurora;
  css.setProperty('--bg-blob-a', preset.a);
  css.setProperty('--bg-blob-b', preset.b);

  css.setProperty('--bg-dim', String(ap.dim != null ? ap.dim : 0.58));
  css.setProperty('--bg-blur', (ap.blur || 0) + 'px');
  css.setProperty('--bg-saturate', String(ap.saturate != null ? ap.saturate : 1));
  css.setProperty('--glass-alpha', String(ap.glassAlpha != null ? ap.glassAlpha : 0.78));
  css.setProperty('--bg-size', ap.fit === 'tile' ? 'auto' : (ap.fit || 'cover'));
  css.setProperty('--bg-repeat', ap.fit === 'tile' ? 'repeat' : 'no-repeat');

  const layer = $('#bgLayer');
  if (ap.bgType === 'image' && ap.bgFile) {
    // Имя файла со меткой времени само ломает кеш при смене картинки.
    css.setProperty('--bg-image', `url("appbg://bg/${encodeURIComponent(ap.bgFile)}")`);
    if (layer) layer.classList.remove('gradient');
  } else {
    css.setProperty('--bg-image', 'none');
    if (layer) layer.classList.add('gradient');
  }

  root.classList.toggle('reduce-motion', !!ap.reduceMotion);
}

async function saveAppearance(patch) {
  state.settings.appearance = await api.appearance.set(patch);
  applyAppearance();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

async function setTheme(theme) {
  applyTheme(theme);
  state.settings.theme = await api.settings.setSection('theme', theme);
}

// ── язык ───────────────────────────────────────────────────────────
async function setLanguage(lang) {
  if (lang === I18N.getLanguage()) return;
  I18N.setLanguage(lang);
  await saveSection('language', lang);
  renderChrome();
  renderNav();
  render();
}

// ── шапка и навигация ──────────────────────────────────────────────
function renderChrome() {
  $('.brand .tag').textContent = t('app.brandTag');
  const appearBtn = $('#appearanceBtn');
  appearBtn.innerHTML = ICONS.palette + '<span>' + esc(t('app.appearance')) + '</span>';
  $('#winMin').innerHTML = ICONS.winMin;
  $('#winMin').title = t('win.minimize');
  $('#winClose').innerHTML = ICONS.winClose;
  $('#winClose').title = t('win.close');
  paintWindowState(false);
}

function paintWindowState(maximized) {
  const btn = $('#winMax');
  btn.innerHTML = maximized ? ICONS.winRestore : ICONS.winMax;
  btn.title = maximized ? t('win.restore') : t('win.maximize');
}

function renderNav() {
  const nav = $('#nav');
  $$('.nav-item', nav).forEach((el) => el.remove());
  for (const item of ROUTES) {
    const el = h(`<div class="nav-item ${state.route === item.id ? 'active' : ''}" data-route="${item.id}">
      <span class="icon">${ICONS[item.icon]}</span><span>${esc(t('navShort.' + item.id))}</span></div>`);
    el.title = t(item.labelKey);
    el.addEventListener('click', () => go(item.id));
    nav.appendChild(el);
  }
  moveNavPill();
}

/** Пилюля активного пункта едет по замеренным координатам, а не по CSS-классу:
    ширина у пунктов разная, и переход между ними должен быть плавным. */
function moveNavPill() {
  const pill = $('#navPill');
  const active = $('.nav-item.active');
  if (!pill || !active) return;
  const navBox = $('#nav').getBoundingClientRect();
  const box = active.getBoundingClientRect();
  pill.style.width = box.width + 'px';
  pill.style.transform = `translate(${box.left - navBox.left}px, -50%)`;
  pill.style.opacity = '1';
}

function go(route) {
  if (state.route === route) return;
  state.route = route;
  renderNav();
  render();
}

// ── статус системы ─────────────────────────────────────────────────
function runState() {
  const r = state.runStatus;
  if (!r.running) return 'idle';
  return r.paused ? 'paused' : 'running';
}

function pillHtml(mode) {
  const map = {
    running: { cls: 'on', key: 'sys.pill.running' },
    paused: { cls: 'paused', key: 'sys.pill.paused' },
    idle: { cls: 'off', key: 'sys.pill.idle' },
  };
  const m = map[mode];
  return `<span class="pill ${m.cls}"><span class="dot"></span>${esc(t(m.key))}</span>`;
}

// ── экраны ─────────────────────────────────────────────────────────
const VIEWS = {};
const ACTIONS = {};

function render() {
  const route = ROUTES.find((r) => r.id === state.route) || ROUTES[0];
  $('#crumbs').textContent = t('crumbs.root') + ' / ' + t(route.labelKey).toUpperCase();
  $('#pageTitle').textContent = t(route.titleKey);
  $('#pageSub').textContent = t(route.subKey);

  const actions = $('#pageActions');
  actions.innerHTML = '';
  if (ACTIONS[route.id]) ACTIONS[route.id]().forEach((el) => actions.appendChild(el));

  const main = $('#main');
  main.innerHTML = '';
  const view = VIEWS[route.id]();
  view.classList.add('view-enter');
  main.appendChild(view);
  main.scrollTop = 0;

  wirePanels(main);
  wireRipples(main);
  wireRipples(actions);
  wireSheen(main);
  paintRun();
}

// ── Дашборд ────────────────────────────────────────────────────────
VIEWS.dashboard = () => {
  const wrap = h(`<div>
    <div class="hero glass glass-refract glass-sheen">
      <div>
        <div class="section-label">${esc(t('dash.kicker'))}</div>
        <h1>${esc(t('dash.heroTitle'))}</h1>
        <div class="hero-sub">${esc(t('dash.heroSub'))}</div>
        <div class="hero-actions" id="runControls"></div>
        <div class="hero-note" id="runNote"></div>
      </div>
      <div class="hero-side">
        <div class="hero-status glass">
          <div class="section-label">${esc(t('dash.currentStatus'))}</div>
          <div class="value" id="hStatus">${dash}</div>
        </div>
        <div class="hero-facts glass">
          <div class="kv"><span class="k">${esc(t('dash.totalSent'))}</span><span class="v" id="hSent">0</span></div>
          <div class="kv"><span class="k">${esc(t('dash.queue'))}</span><span class="v" id="hQueue">0</span></div>
          <div class="kv"><span class="k">${esc(t('dash.ready'))}</span><span class="v" id="hReady">0</span></div>
        </div>
      </div>
    </div>

    <div class="grid cols-4 stagger" style="margin-bottom:16px">
      <div class="stat glass"><div class="label">${esc(t('dash.uptime'))}</div>
        <div class="value" id="dUptime">0s</div><div class="foot">${esc(t('dash.uptimeFoot'))}</div></div>
      <div class="stat glass"><div class="label">${esc(t('dash.queue'))}</div>
        <div class="value accent" id="dQueue">0</div><div class="foot">${esc(t('dash.queueFoot'))}</div></div>
      <div class="stat glass"><div class="label">${esc(t('dash.ready'))}</div>
        <div class="value green" id="dReady">0</div><div class="foot">${esc(t('dash.readyFoot'))}</div></div>
      <div class="stat glass"><div class="label">${esc(t('dash.totalSent'))}</div>
        <div class="value" id="dSent">0</div>
        <svg class="spark" id="dSpark" viewBox="0 0 100 26" preserveAspectRatio="none">
          <path class="area"/><path vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="foot">${esc(t('dash.sentFoot'))}</div></div>
    </div>

    <div class="card glass" style="margin-bottom:16px">
      <div class="section-label">${esc(t('targets.title'))}</div>
      <h3 style="margin:8px 0 6px;font-size:16px">${ICONS.target} ${esc(t('targets.sub'))}</h3>
      <div class="chips" id="dTargets"></div>
      <div class="hint" id="dTargetsHint" style="margin-top:10px"></div>
    </div>

    <div class="card glass">
      <div class="logs-head">
        <h3 style="margin:0">${esc(t('dash.logs'))}</h3>
        <div class="seg" id="logLevels">
          ${LOG_LEVELS.map((lv) => `<button data-v="${lv}" class="${state.logFilter.level === lv ? 'active' : ''}">${esc(lv === 'all' ? t('logs.all') : lv)}</button>`).join('')}
        </div>
        <div class="grow"><input type="text" id="logSearch" placeholder="${esc(t('logs.searchPh'))}" value="${esc(state.logFilter.query)}"/></div>
        <button class="btn ghost" id="logFollow"></button>
        <button class="btn ghost" id="logClear">${esc(t('logs.clear'))}</button>
        <span class="logs-count" id="logCount"></span>
      </div>
      <div class="logs" id="logs"></div>
    </div>
  </div>`);

  const controls = wrap.querySelector('#runControls');
  const primary = h(`<button class="btn primary big" data-action="start"></button>`);
  const secondary = h(`<button class="btn big" data-action="pause"></button>`);
  primary.addEventListener('click', () => runAction(primary.dataset.action));
  secondary.addEventListener('click', () => runAction(secondary.dataset.action));

  const leadBtn = h(`<button class="btn big">${ICONS.send}<span>${esc(t('dash.testLead'))}</span></button>`);
  leadBtn.addEventListener('click', async () => {
    const email = await askText(t('dash.testLeadAsk'), { placeholder: 'me@gmail.com' });
    if (!email) return;
    const res = await api.run.testLead(email.trim());
    if (res && res.ok) toast(t('dash.testLeadOk', { email: res.lead.email }), 'success');
    else toast(t('dash.testLeadFail'), 'error');
    refreshRun();
  });
  controls.append(primary, secondary, leadBtn);

  wireTargetChips(wrap.querySelector('#dTargets'), wrap.querySelector('#dTargetsHint'));

  // Логи
  $$('#logLevels button', wrap).forEach((b) => b.addEventListener('click', () => {
    state.logFilter.level = b.dataset.v;
    $$('#logLevels button', wrap).forEach((x) => x.classList.toggle('active', x === b));
    renderLogs();
  }));
  wrap.querySelector('#logSearch').addEventListener('input', debounce((e) => {
    state.logFilter.query = e.target.value;
    renderLogs();
  }, 220));
  wrap.querySelector('#logFollow').addEventListener('click', () => {
    state.logFollow = !state.logFollow;
    if (state.logFollow) scrollLogsToEnd();
    paintLogFollow();
  });
  wrap.querySelector('#logClear').addEventListener('click', () => {
    state.logs = [];
    renderLogs();
    toast(t('logs.cleared'));
  });
  const box = wrap.querySelector('#logs');
  // Пользователь отскроллил вверх - перестаём тащить его вниз каждой записью.
  box.addEventListener('scroll', () => {
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 26;
    if (atEnd !== state.logFollow) { state.logFollow = atEnd; paintLogFollow(); }
  });

  setTimeout(() => { renderLogs(); paintRun(); }, 0);
  return wrap;
};

/** Чипы площадок. Один код на два места: блок на дашборде и группу настроек -
    настройка одна и та же, разъезжаться ей нельзя. */
function wireTargetChips(box, hint) {
  if (!box) return;
  const selected = (state.settings.parser.platforms || []);
  box.innerHTML = PLATFORMS.map((p) => `<div class="chip ${selected.includes(p.id) ? 'on' : ''}" data-v="${p.id}">
    <span class="code">${esc(p.code)}</span>${esc(p.label)}</div>`).join('');
  if (hint) hint.textContent = selected.length ? '' : t('targets.empty');
  $$('.chip', box).forEach((c) => c.addEventListener('click', async () => {
    c.classList.toggle('on');
    const sel = $$('.chip.on', box).map((x) => x.dataset.v);
    await saveSection('parser', { platforms: sel });
    if (hint) hint.textContent = sel.length ? '' : t('targets.empty');
    toast(t('targets.saved'), 'success');
  }));
}

/** Одна точка входа для старт/стоп/пауза - и одна защита от двойного клика. */
async function runAction(kind) {
  if (state.runBusy || !kind) return;
  state.runBusy = true;
  paintRunControls();
  try {
    if (kind === 'start') {
      const res = await api.run.start();
      if (res && res.ok) toast(t('dash.started'), 'success');
      else {
        const reason = res && res.reason ? t('reason.' + res.reason) : t('dash.startFailedUnknown');
        toast(t('dash.startFailed', { reason }), 'error');
      }
    } else if (kind === 'stop') {
      await api.run.stop();
      toast(t('dash.stoppedToast'));
    } else if (kind === 'pause') {
      const res = await api.run.pause();
      if (res && res.ok) toast(t('dash.pausedToast'));
    } else if (kind === 'resume') {
      const res = await api.run.resume();
      if (res && res.ok) toast(t('dash.resumedToast'), 'success');
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.runBusy = false;
    await refreshRun();
  }
}

/** Кнопки НЕ пересобираем - меняем содержимое тех же узлов, иначе рвётся
    анимация и теряется фокус клавиатуры. */
function paintRunControls() {
  const controls = $('#runControls');
  if (!controls) return;
  const [primary, secondary] = controls.children;
  const mode = runState();

  const primaryStart = mode === 'idle';
  primary.dataset.action = primaryStart ? 'start' : 'stop';
  primary.className = 'btn big ' + (primaryStart ? 'primary' : 'stop');
  primary.innerHTML = state.runBusy
    ? `<span class="spinner"></span><span>${esc(t(primaryStart ? 'dash.start' : 'dash.stop'))}</span>`
    : (primaryStart ? ICONS.play : ICONS.stop) + `<span>${esc(t(primaryStart ? 'dash.start' : 'dash.stop'))}</span>`;
  primary.disabled = state.runBusy;

  const canPause = mode !== 'idle';
  const resuming = mode === 'paused';
  secondary.dataset.action = resuming ? 'resume' : 'pause';
  secondary.innerHTML = (resuming ? ICONS.play : ICONS.pause) +
    `<span>${esc(t(resuming ? 'dash.resume' : 'dash.pause'))}</span>`;
  secondary.disabled = !canPause || state.runBusy;
}

function paintRun() {
  const r = state.runStatus;
  const mode = runState();

  const sysPill = $('#sysPill');
  if (sysPill) sysPill.innerHTML = pillHtml(mode);

  const hStatus = $('#hStatus');
  if (hStatus) {
    hStatus.textContent = mode === 'running' ? t('dash.running')
      : mode === 'paused' ? t('dash.pausedState') : t('dash.stopped');
  }
  const note = $('#runNote');
  if (note) {
    note.textContent = mode === 'running' ? t('dash.noteRunning')
      : mode === 'paused' ? t('dash.notePaused') : t('dash.noteIdle');
  }

  const ready = state.profiles.filter((p) => p.gmailStatus === 'ready').length;
  const sent = state.profiles.reduce((n, p) => n + (p.sentCount || 0), 0);

  const up = $('#dUptime'); if (up) up.textContent = fmtUptime(r.uptimeSec);
  setNumber($('#dQueue'), r.queueSize);
  setNumber($('#dReady'), ready);
  setNumber($('#dSent'), sent);
  setNumber($('#hSent'), sent);
  setNumber($('#hQueue'), r.queueSize);
  setNumber($('#hReady'), ready);

  paintRunControls();
  paintSpark();
}

function paintSpark() {
  const svg = $('#dSpark');
  if (!svg) return;
  const values = state.sendSeries;
  const [area, line] = svg.children;
  if (values.length < 2) { area.removeAttribute('d'); line.removeAttribute('d'); return; }
  const w = 100, hh = 26;
  const max = Math.max(1, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, hh - (v / max) * (hh - 3) - 1.5]);
  const d = 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
  line.setAttribute('d', d);
  area.setAttribute('d', d + ` L${w},${hh} L0,${hh} Z`);
}

function fmtUptime(sec) {
  if (!sec) return '0s';
  const hrs = Math.floor(sec / 3600), min = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (hrs ? hrs + 'h ' : '') + (min ? min + 'm ' : '') + s + 's';
}

// ── живые логи ─────────────────────────────────────────────────────
function logPasses(entry) {
  const f = state.logFilter;
  if (f.level !== 'all' && entry.level !== f.level) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return (entry.message + ' ' + entry.scope).toLowerCase().includes(q);
}

/** Подсветка совпадений. Экранируем СНАЧАЛА, потом вставляем разметку - иначе
    текст письма с угловыми скобками уехал бы в HTML. */
function highlight(text, query) {
  const safe = esc(text);
  const q = query.trim();
  if (!q) return safe;
  const needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(needle, 'gi'), (m) => `<mark>${m}</mark>`);
}

function logLineEl(entry) {
  const time = new Date(entry.ts).toLocaleTimeString();
  return h(`<div class="log-line ${entry.level}"><span class="t">${esc(time)}</span><span class="s">[${esc(entry.scope)}]</span><span class="m">${highlight(entry.message, state.logFilter.query)}</span></div>`);
}

function renderLogs() {
  const box = $('#logs');
  if (!box) return;
  const shown = state.logs.filter(logPasses);
  box.innerHTML = '';
  if (!shown.length) {
    box.appendChild(h(`<div class="empty">${esc(state.logs.length ? t('logs.emptyFiltered') : t('logs.empty'))}</div>`));
  } else {
    const frag = document.createDocumentFragment();
    shown.forEach((e) => frag.appendChild(logLineEl(e)));
    box.appendChild(frag);
  }
  paintLogCount(shown.length);
  paintLogFollow();
  if (state.logFollow) scrollLogsToEnd();
}

function paintLogCount(shown) {
  const el = $('#logCount');
  if (el) el.textContent = t('logs.shown', { shown, total: state.logs.length });
}

function paintLogFollow() {
  const btn = $('#logFollow');
  if (!btn) return;
  btn.innerHTML = ICONS.chevron + '<span>' + esc(state.logFollow ? t('logs.follow') : t('logs.paused')) + '</span>';
  btn.style.color = state.logFollow ? 'var(--accent)' : '';
  btn.querySelector('svg').style.transform = 'rotate(90deg)';
}

function scrollLogsToEnd() {
  const box = $('#logs');
  if (box) box.scrollTop = box.scrollHeight;
}

function appendLog(entry) {
  state.logs.push(entry);
  while (state.logs.length > 500) state.logs.shift();
  const box = $('#logs');
  if (!box) return;
  if (!logPasses(entry)) { paintLogCount($$('.log-line', box).length); return; }
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  box.appendChild(logLineEl(entry));
  while (box.children.length > 500) box.removeChild(box.firstChild);
  paintLogCount($$('.log-line', box).length);
  if (state.logFollow) scrollLogsToEnd();
}

// ── Профили ────────────────────────────────────────────────────────
ACTIONS.profiles = () => {
  const nudge = h(`<button class="btn">${ICONS.send}<span>${esc(t('nudge.btn'))}</span></button>`);
  nudge.addEventListener('click', async () => {
    const email = await askText(t('nudge.ask'), { placeholder: 'seller@example.com' });
    if (!email) return;
    toast(t('nudge.sending'));
    try {
      const res = await api.contacts.nudge(email.trim());
      if (res && res.ok) { toast(t('nudge.ok'), 'success'); await refreshProfiles(); }
      else toast(t('nudge.fail.' + ((res && res.reason) || 'unknown')), 'error');
    } catch (e) { toast(t('nudge.error', { error: e.message }), 'error'); }
  });

  const create = h(`<button class="btn primary">${ICONS.plus}<span>${esc(t('prof.new'))}</span></button>`);
  create.addEventListener('click', async () => {
    const label = await askText(t('prof.askName'), { value: t('prof.defaultName', { n: state.profiles.length + 1 }) });
    if (label === null) return;
    const p = await api.profiles.create(label);
    toast(t('prof.created'), 'success');
    await refreshProfiles();
    state.selectedProfile = p.id;
    // Сразу открываем профиль с Gmail - вход пользователь делает руками.
    launchProfile(p.id, true);
  });
  return [nudge, create];
};

VIEWS.profiles = () => {
  const s = state.profileStats || { total: 0, running: 0, gmailReady: 0, portsOpen: 0 };
  const wrap = h(`<div>
    <div class="grid cols-4 stagger" style="margin-bottom:18px">
      <div class="stat glass"><div class="label">${esc(t('prof.total'))}</div><div class="value" id="sTotal">0</div></div>
      <div class="stat glass"><div class="label">${esc(t('prof.runningCount'))}</div><div class="value accent" id="sRun">0</div></div>
      <div class="stat glass"><div class="label">${esc(t('prof.gmailReady'))}</div><div class="value green" id="sReady">0</div></div>
      <div class="stat glass"><div class="label">${esc(t('prof.portsOpen'))}</div><div class="value" id="sPorts">0</div></div>
    </div>
    <div class="split">
      <div class="grid cols-2" id="cards"></div>
      <div id="detail"></div>
    </div>
  </div>`);

  setTimeout(() => {
    setNumber(wrap.querySelector('#sTotal'), s.total);
    setNumber(wrap.querySelector('#sRun'), s.running);
    setNumber(wrap.querySelector('#sReady'), s.gmailReady);
    setNumber(wrap.querySelector('#sPorts'), s.portsOpen);
    renderProfileCards(wrap);
    renderProfileDetail(wrap);
  }, 0);
  return wrap;
};

/** Кольцо "сколько из лимита уже отправлено". */
function ringHtml(sent, limit) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const done = limit > 0 ? clamp(sent / limit, 0, 1) : 0;
  return `<span class="ring-wrap" title="${esc(t('prof.limit'))}: ${sent} / ${limit}">
    <svg class="ring" viewBox="0 0 34 34">
      <circle class="bg" cx="17" cy="17" r="${r}"/>
      <circle class="fg" cx="17" cy="17" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - done)).toFixed(1)}"/>
    </svg><span class="ring-txt">${Math.round(done * 100)}</span></span>`;
}

function renderProfileCards(root) {
  const cards = root.querySelector('#cards') || $('#cards');
  if (!cards) return;
  const limit = state.settings.system.mailsPerAccount;
  cards.innerHTML = '';
  if (!state.booted) {
    for (let i = 0; i < 2; i++) cards.appendChild(h(`<div class="skeleton tile"></div>`));
    return;
  }
  if (!state.profiles.length) {
    cards.appendChild(h(`<div class="empty glass" style="grid-column:1/-1">${ICONS.profiles}<div>${esc(t('prof.empty'))}</div></div>`));
    return;
  }
  for (const p of state.profiles) {
    const card = h(`<div class="profile-card glass glass-sheen ${state.selectedProfile === p.id ? 'selected' : ''}">
      <div class="pc-head">
        <div><div class="pc-name"><span class="dot ${p.gmailStatus}"></span> ${esc(p.label)}</div>
        <div class="pc-email">${esc(p.email || t('prof.notSignedIn'))}</div></div>
        <span class="badge ${p.gmailStatus}">${esc(t('status.' + p.gmailStatus))}</span>
      </div>
      <div class="pc-meta">
        ${ringHtml(p.sentCount || 0, limit)}
        <span><span class="dot ${p.running ? 'running' : 'new'}"></span> ${esc(p.running ? t('prof.running') : t('prof.stopped'))}</span>
        <span>${esc(t('prof.port'))}: ${p.port || dash}</span>
        <span>${esc(t('prof.sent'))}: ${p.sentCount}</span>
      </div>
    </div>`);
    card.addEventListener('click', () => { state.selectedProfile = p.id; render(); });
    cards.appendChild(card);
  }
  wireSheen(cards);
}

function renderProfileDetail(root) {
  const box = root.querySelector('#detail') || $('#detail');
  if (!box) return;
  const p = state.profiles.find((x) => x.id === state.selectedProfile);
  if (!p) {
    box.innerHTML = `<div class="card glass"><div class="empty">${ICONS.scan}<div>${esc(t('prof.selectHint'))}</div></div></div>`;
    return;
  }
  const fp = p.fingerprint;
  box.innerHTML = '';
  const card = h(`<div class="card glass">
    <h3><span class="dot ${p.gmailStatus}"></span> ${esc(p.label)}</h3>
    <div class="kv"><span class="k">${esc(t('prof.status'))}</span><span class="v"><span class="badge ${p.gmailStatus}">${esc(t('status.' + p.gmailStatus))}</span></span></div>
    <div class="kv"><span class="k">${esc(t('prof.email'))}</span><span class="v">${esc(p.email || dash)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.isRunning'))}</span><span class="v">${p.running ? esc(t('common.yes')) : esc(t('common.no'))}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.port'))}</span><span class="v">${p.port || dash}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.sentCount'))}</span><span class="v">${p.sentCount} / ${state.settings.system.mailsPerAccount}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.ua'))}</span><span class="v" style="max-width:210px">${esc(fp.userAgent)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.platform'))}</span><span class="v">${esc(fp.platform)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.screen'))}</span><span class="v">${fp.screen.width}x${fp.screen.height}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.timezone'))}</span><span class="v">${esc(fp.timezone)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.gpu'))}</span><span class="v" style="max-width:210px">${esc(fp.webgl.renderer)}</span></div>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      ${p.running
        ? '<button class="btn stop" id="dStop">' + ICONS.stop + '<span>' + esc(t('prof.stopBtnFull')) + '</span></button>'
        : '<button class="btn primary" id="dLaunch">' + ICONS.play + '<span>' + esc(t('prof.launch')) + '</span></button>'}
      <button class="btn" id="dScan">${ICONS.scan}<span>${esc(t('prof.scan'))}</span></button>
      ${p.running ? '<button class="btn" id="dTest">' + ICONS.send + '<span>' + esc(t('prof.testSend')) + '</span></button>' : ''}
      ${p.running ? '<button class="btn" id="dDry">' + ICONS.inbox + '<span>' + esc(t('prof.dryRun')) + '</span></button>' : ''}
      ${p.running ? '<button class="btn" id="dReopen">' + ICONS.reset + '<span>' + esc(t('prof.reopen')) + '</span></button>' : ''}
      <button class="btn danger" id="dDel">${ICONS.trash}<span>${esc(t('prof.delete'))}</span></button>
    </div>
  </div>`);

  const launch = card.querySelector('#dLaunch');
  if (launch) launch.addEventListener('click', () => launchProfile(p.id, true));
  const reopen = card.querySelector('#dReopen');
  if (reopen) reopen.addEventListener('click', () => launchProfile(p.id, true));
  const stop = card.querySelector('#dStop');
  if (stop) stop.addEventListener('click', async () => { await api.profiles.stop(p.id); await refreshProfiles(); });

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
      const res = await api.gmail.testSend(p.id, { to, subject: t('prof.testSubject'), body: t('prof.testBody') });
      const ok = !!(res && res.ok);
      toast(ok ? t('prof.testSent') : t('prof.testUnconfirmed'), ok ? 'success' : 'error');
    } catch (e) { toast(t('prof.testFailed', { error: e.message }), 'error'); }
  });

  // Сухой прогон автоответа: показывает, кого видит сканер, ничего не отправляя.
  const dryBtn = card.querySelector('#dDry');
  if (dryBtn) dryBtn.addEventListener('click', async () => {
    toast(t('prof.dryRunning'));
    try {
      const res = await api.gmail.dryRun(p.id);
      if (res && res.ok) toast(t('prof.dryDone', { count: res.rows.length, known: res.known }), 'success');
      else toast(t('prof.dryFail.' + ((res && res.reason) || 'unknown')), 'error');
    } catch (e) { toast(t('prof.dryError', { error: e.message }), 'error'); }
  });

  card.querySelector('#dDel').addEventListener('click', async () => {
    const ok = await askConfirm(
      t('prof.confirmDeleteTitle'),
      t('prof.confirmDeleteText', { label: p.label }),
      { danger: true, okLabel: t('common.delete') },
    );
    if (!ok) return;
    await api.profiles.remove(p.id);
    state.selectedProfile = null;
    await refreshProfiles();
  });

  box.appendChild(card);
  wireRipples(box);
  wireSheen(box);
}

async function launchProfile(id, openGmail) {
  toast(t('prof.launching'));
  try { await api.profiles.launch(id, openGmail); await refreshProfiles(); toast(t('prof.launched'), 'success'); }
  catch (e) { toast(t('prof.launchFailed', { error: e.message }), 'error'); }
}

// ── Настройки: одна страница, группы слева ─────────────────────────
// Всё настраиваемое собрано здесь. Отдельных разделов под парсер, CDP,
// ссылки и Telegram в верхней панели больше нет: одно место правды.

const SETTINGS_GROUPS = [
  { id: 'interface', icon: 'settings', build: buildSetInterface },
  { id: 'appearance', icon: 'palette', build: buildSetAppearance },
  { id: 'limits', icon: 'dashboard', build: buildSetLimits },
  { id: 'parser', icon: 'parser', build: buildSetParser },
  { id: 'targets', icon: 'target', build: buildSetTargets },
  { id: 'cdp', icon: 'cdp', build: buildSetCdp },
  { id: 'link', icon: 'link', build: buildSetLink },
  { id: 'telegram', icon: 'telegram', build: buildSetTelegram },
  { id: 'texts', icon: 'inbox', build: buildSetTexts },
];

VIEWS.settings = () => {
  const wrap = h(`<div class="settings">
    <aside class="set-menu glass">
      ${SETTINGS_GROUPS.map((g) => `<button class="set-tab" data-g="${g.id}">
        <span class="icon">${ICONS[g.icon]}</span><span>${esc(t('set.g.' + g.id))}</span></button>`).join('')}
    </aside>
    <div class="set-panel" id="setPanel"></div>
  </div>`);

  $$('.set-tab', wrap).forEach((b) => b.addEventListener('click', () => {
    state.settingsGroup = b.dataset.g;
    renderSettingsGroup(wrap);
  }));

  setTimeout(() => renderSettingsGroup(wrap), 0);
  return wrap;
};

function renderSettingsGroup(root) {
  const group = SETTINGS_GROUPS.find((g) => g.id === state.settingsGroup) || SETTINGS_GROUPS[0];
  $$('.set-tab', root).forEach((b) => b.classList.toggle('active', b.dataset.g === group.id));

  const panel = root.querySelector('#setPanel');
  if (!panel) return;
  panel.innerHTML = '';
  const el = group.build();
  el.classList.add('view-enter');
  panel.appendChild(el);
  wireRipples(panel);
  wireSheen(panel);
}

/** Открыть настройки сразу на нужной группе (например, из подсказки). */
function goSettings(groupId) {
  state.settingsGroup = groupId;
  if (state.route === 'settings') {
    const root = $('.settings');
    if (root) { renderSettingsGroup(root); return; }
  }
  go('settings');
}

/** Заголовок группы: одинаковая шапка у каждой карточки настроек. */
function setCard(groupId, bodyHtml) {
  return `<div class="card glass">
    <div class="section-label">${esc(t('set.g.' + groupId))}</div>
    <h3 style="margin:8px 0 14px;font-size:16px">${esc(t('set.h.' + groupId))}</h3>
    ${bodyHtml}
  </div>`;
}

function buildSetInterface() {
  const lang = I18N.getLanguage();
  const el = h(setCard('interface', `
    <div class="field"><label>${esc(t('set.language'))}</label>
      <div class="seg" id="mLang">
        ${I18N.LANGUAGES.map((x) => `<button data-v="${x.id}" class="${lang === x.id ? 'active' : ''}">${esc(x.label)}</button>`).join('')}
      </div>
    </div>
    <div class="hint">${esc(t('set.langHint'))}</div>`));
  $$('#mLang button', el).forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.v)));
  return el;
}

function buildSetAppearance() {
  const el = h(setCard('appearance', `<div class="opt-list">${appearanceControlsHtml()}</div>`));
  wireAppearanceControls(el, () => renderSettingsGroup($('.settings')));
  return el;
}

function buildSetLimits() {
  const s = state.settings.system;
  const el = h(setCard('limits', `
    <div class="row">
      <div class="field"><label>${esc(t('set.mails'))}</label><input type="number" id="mMails" min="1" value="${s.mailsPerAccount}"/></div>
      <div class="field"><label>${esc(t('set.replies'))}</label><input type="number" id="mReplies" min="0" value="${s.maxRepliesPerDialog}"/></div>
    </div>
    <div class="row">
      <div class="field"><label>${esc(t('set.checkInterval'))}</label><input type="number" id="mCheck" min="3" value="${s.checkIntervalSec}"/></div>
      <div class="field"><label>${esc(t('set.batch'))}</label><input type="number" id="mBatch" min="1" value="${s.parserBatchSize}"/></div>
      <div class="field"><label>${esc(t('set.threshold'))}</label><input type="number" id="mThresh" min="0" value="${s.queueRefillThreshold}"/></div>
    </div>
    <div class="hint">${esc(t('set.limitsHint'))}</div>`));
  const bind = (id, key) => $(id, el).addEventListener('input', debounce((e) => saveSection('system', { [key]: +e.target.value || 0 })));
  bind('#mMails', 'mailsPerAccount'); bind('#mReplies', 'maxRepliesPerDialog'); bind('#mCheck', 'checkIntervalSec');
  bind('#mBatch', 'parserBatchSize'); bind('#mThresh', 'queueRefillThreshold');
  return el;
}

function buildSetParser() {
  const p = state.settings.parser;
  const el = h(setCard('parser', `
    <div class="row">
      <div class="field"><label>${esc(t('parser.apiKey'))}</label><input type="password" id="pKey" value="${esc(p.apiKey)}" placeholder="${esc(t('parser.apiKeyPh'))}"/></div>
      <div class="field" style="flex:0 0 190px"><label>${esc(t('parser.type'))}</label>
        <div class="seg" id="pType">
          <button data-v="xproject" class="${p.apiType === 'xproject' ? 'active' : ''}">xproject</button>
          <button data-v="vvs" class="${p.apiType === 'vvs' ? 'active' : ''}">vvs</button>
        </div>
      </div>
    </div>
    <div class="field"><label class="switch"><input type="checkbox" id="pEnabled" ${p.enabled ? 'checked' : ''}/><span class="track"></span><span class="lbl">${esc(t('parser.enabled'))}</span></label></div>
    <div class="field"><label class="switch"><input type="checkbox" id="pAi" ${p.aiTemplateSwap ? 'checked' : ''}/><span class="track"></span><span class="lbl">${esc(t('parser.aiSwap'))}</span></label></div>
    <div class="field" style="max-width:340px"><label>${esc(t('parser.swapN'))}</label><input type="number" id="pSwapN" min="0" value="${p.swapKeyEveryN}"/></div>
    <div class="hint">${esc(t('parser.platformsHint'))} <a href="#" id="pToTargets">${esc(t('set.g.targets'))}</a>.</div>`));

  $('#pKey', el).addEventListener('input', debounce((e) => saveSection('parser', { apiKey: e.target.value })));
  $$('#pType button', el).forEach((b) => b.addEventListener('click', () => {
    $$('#pType button', el).forEach((x) => x.classList.toggle('active', x === b));
    saveSection('parser', { apiType: b.dataset.v });
  }));
  $('#pEnabled', el).addEventListener('change', (e) => saveSection('parser', { enabled: e.target.checked }));
  $('#pAi', el).addEventListener('change', (e) => saveSection('parser', { aiTemplateSwap: e.target.checked }));
  $('#pSwapN', el).addEventListener('input', debounce((e) => saveSection('parser', { swapKeyEveryN: +e.target.value || 0 })));
  $('#pToTargets', el).addEventListener('click', (e) => { e.preventDefault(); goSettings('targets'); });
  return el;
}

function buildSetTargets() {
  const el = h(setCard('targets', `
    <div class="chips" id="setTargets"></div>
    <div class="hint" id="setTargetsHint" style="margin-top:12px"></div>`));
  wireTargetChips($('#setTargets', el), $('#setTargetsHint', el));
  return el;
}

function buildSetCdp() {
  const c = state.settings.cdp;
  const el = h(setCard('cdp', `
    <div class="row">
      <div class="field"><label>${esc(t('cdp.portStart'))}</label><input type="number" id="cStart" value="${c.portStart}"/></div>
      <div class="field"><label>${esc(t('cdp.portEnd'))}</label><input type="number" id="cEnd" value="${c.portEnd}"/></div>
    </div>
    <div class="field"><label>${esc(t('cdp.path'))}</label><input type="text" id="cPath" value="${esc(c.chromePath)}" placeholder="${esc(t('cdp.pathPh'))}"/></div>
    <button class="btn" id="cDetect">${ICONS.search}<span>${esc(t('cdp.detect'))}</span></button>
    <div class="hint" id="cDetected" style="margin-top:12px"></div>`));
  $('#cStart', el).addEventListener('input', debounce((e) => saveSection('cdp', { portStart: +e.target.value || 9222 })));
  $('#cEnd', el).addEventListener('input', debounce((e) => saveSection('cdp', { portEnd: +e.target.value || 9322 })));
  $('#cPath', el).addEventListener('input', debounce((e) => saveSection('cdp', { chromePath: e.target.value })));
  $('#cDetect', el).addEventListener('click', async () => {
    const found = await api.cdp.detectChrome();
    $('#cDetected', el).textContent = found ? t('cdp.found', { path: found }) : t('cdp.notFound');
  });
  return el;
}

function buildSetLink() {
  const l = state.settings.link;
  const el = h(setCard('link', `
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
    <div class="hint">${esc(t('link.hint'))}</div>`));
  $('#lKey', el).addEventListener('input', debounce((e) => saveSection('link', { apiKey: e.target.value })));
  $('#lTeam', el).addEventListener('change', (e) => saveSection('link', { team: e.target.value }));
  $('#lMode', el).addEventListener('input', debounce((e) => saveSection('link', { mode: e.target.value })));
  $('#lPid', el).addEventListener('input', debounce((e) => saveSection('link', { profileId: e.target.value })));
  $('#lCountry', el).addEventListener('change', (e) => saveSection('link', { country: e.target.value }));
  return el;
}

function buildSetTelegram() {
  const tg = state.settings.telegram;
  const el = h(setCard('telegram', `
    <div class="field"><label>${esc(t('tg.token'))}</label><input type="password" id="tToken" value="${esc(tg.botToken)}"/></div>
    <div class="field"><label>${esc(t('tg.chatId'))}</label><input type="text" id="tId" value="${esc(tg.botId)}"/></div>
    <button class="btn" id="tTest">${ICONS.send}<span>${esc(t('tg.test'))}</span></button>
    <div class="hint" id="tResult" style="margin-top:12px"></div>`));
  $('#tToken', el).addEventListener('input', debounce((e) => saveSection('telegram', { botToken: e.target.value })));
  $('#tId', el).addEventListener('input', debounce((e) => saveSection('telegram', { botId: e.target.value })));
  $('#tTest', el).addEventListener('click', async () => {
    const res = await api.telegram.test($('#tToken', el).value);
    $('#tResult', el).textContent = res && res.ok
      ? t('tg.ok', { username: (res.result && res.result.username) || 'bot' })
      : t('tg.fail');
  });
  return el;
}

function buildSetTexts() {
  const el = h(setCard('texts', `
    <div class="field"><label>${esc(t('set.textsLabel'))}</label><textarea id="mTexts" placeholder='{ "subjects": [...], "bodies": [...] }'>${state.settings.texts ? esc(JSON.stringify(state.settings.texts, null, 2)) : ''}</textarea></div>
    <button class="btn primary" id="mLoadTexts">${esc(t('set.loadTexts'))}</button>
    <div class="hint" id="mTextsResult" style="margin-top:12px"></div>`));
  $('#mLoadTexts', el).addEventListener('click', async () => {
    try {
      const json = JSON.parse($('#mTexts', el).value);
      state.settings.texts = await api.settings.loadTexts(json);
      $('#mTextsResult', el).textContent = t('set.textsLoaded');
      toast(t('set.textsToast'), 'success');
    } catch (e) { $('#mTextsResult', el).textContent = t('set.textsInvalid', { error: e.message }); }
  });
  return el;
}

// ── Панель "Оформление" ────────────────────────────────────────────
function drawerOpen() { return $('#drawer').classList.contains('open'); }

function toggleDrawer(open) {
  const drawer = $('#drawer');
  const scrim = $('#drawerScrim');
  const next = open === undefined ? !drawerOpen() : open;
  if (next) renderDrawer();
  drawer.classList.toggle('open', next);
  scrim.classList.toggle('open', next);
}

/**
 * Разметка контролов оформления. Живёт в двух местах сразу - в выезжающей
 * панели и в группе "Оформление" на странице настроек, - поэтому собирается
 * одной функцией: разъехаться двум копиям нельзя.
 */
function appearanceControlsHtml() {
  const ap = appearance();
  const theme = document.documentElement.getAttribute('data-theme');
  return `
      <div class="opt-group">
        <span class="section-label">${esc(t('appear.background'))}</span>
        <div class="bg-preview ${ap.bgType === 'image' && ap.bgFile ? '' : 'gradient'}"></div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="bgPick">${ICONS.image}<span>${esc(t('appear.pick'))}</span></button>
          <button class="btn ghost" id="bgReset">${ICONS.reset}<span>${esc(t('appear.reset'))}</span></button>
        </div>
      </div>

      <div class="opt-group">
        <span class="section-label">${esc(t('appear.presets'))}</span>
        <div class="preset-grid" id="bgPresets">
          ${Object.keys(BG_PRESETS).map((id) => `<div class="preset ${ap.bgPreset === id ? 'on' : ''}" data-v="${id}"
            title="${esc(t('preset.' + id))}"
            style="background-image:${BG_PRESETS[id].a},${BG_PRESETS[id].b};background-color:var(--bg-base)"></div>`).join('')}
        </div>
      </div>

      <div class="opt-group">
        <span class="section-label">${esc(t('appear.fit'))}</span>
        <div class="seg" id="bgFit">
          ${['cover', 'contain', 'tile'].map((f) => `<button data-v="${f}" class="${ap.fit === f ? 'active' : ''}">${esc(t('appear.fit.' + f))}</button>`).join('')}
        </div>
        <div style="height:14px"></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.dim'))}</span>
          <input type="range" id="apDim" min="0" max="0.92" step="0.02" value="${ap.dim}"/>
          <span class="num" id="apDimNum">${Math.round(ap.dim * 100)}%</span></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.blur'))}</span>
          <input type="range" id="apBlur" min="0" max="26" step="1" value="${ap.blur}"/>
          <span class="num" id="apBlurNum">${ap.blur}px</span></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.saturate'))}</span>
          <input type="range" id="apSat" min="0" max="2" step="0.05" value="${ap.saturate}"/>
          <span class="num" id="apSatNum">${Number(ap.saturate).toFixed(2)}</span></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.glass'))}</span>
          <input type="range" id="apGlass" min="0.3" max="1" step="0.02" value="${ap.glassAlpha}"/>
          <span class="num" id="apGlassNum">${Math.round(ap.glassAlpha * 100)}%</span></div>
        <div class="hint">${esc(t('appear.glassHint'))}</div>
      </div>

      <div class="opt-group">
        <span class="section-label">${esc(t('appear.accent'))}</span>
        <div class="accent-grid" id="apAccents">
          ${Object.keys(ACCENTS).map((id) => `<div class="accent-dot ${ap.accent === id ? 'on' : ''}" data-v="${id}"
            title="${esc(t('accent.' + id))}"
            style="background:linear-gradient(135deg, ${ACCENTS[id].c}, ${ACCENTS[id].c2})"></div>`).join('')}
        </div>
      </div>

      <div class="opt-group">
        <span class="section-label">${esc(t('appear.theme'))}</span>
        <div class="seg" id="apTheme">
          <button data-v="dark" class="${theme === 'dark' ? 'active' : ''}">${esc(t('appear.theme.dark'))}</button>
          <button data-v="light" class="${theme === 'light' ? 'active' : ''}">${esc(t('appear.theme.light'))}</button>
        </div>
      </div>

      <div class="opt-group">
        <span class="section-label">${esc(t('appear.motion'))}</span>
        <label class="switch"><input type="checkbox" id="apMotion" ${ap.reduceMotion ? 'checked' : ''}/>
          <span class="track"></span><span class="lbl">${esc(t('appear.reduceMotion'))}</span></label>
      </div>

      <div class="opt-group">
        <span class="section-label">${esc(t('appear.keys'))}</span>
        <div class="keys">
          <div class="k-row"><span>${esc(t('appear.keys.nav'))}</span><span><kbd>1</kbd> - <kbd>${ROUTES.length}</kbd></span></div>
          <div class="k-row"><span>${esc(t('appear.keys.run'))}</span><kbd>Ctrl + Enter</kbd></div>
          <div class="k-row"><span>${esc(t('appear.keys.pause'))}</span><kbd>Ctrl + P</kbd></div>
          <div class="k-row"><span>${esc(t('appear.keys.search'))}</span><kbd>Ctrl + K</kbd></div>
          <div class="k-row"><span>${esc(t('appear.keys.esc'))}</span><kbd>Esc</kbd></div>
        </div>
      </div>`;
}

/**
 * Обработчики контролов оформления. `rerender` перерисовывает того, кто их
 * приютил: смена картинки или пресета меняет и превью, и подсветку выбора.
 */
function wireAppearanceControls(root, rerender) {
  $('#bgPick', root).addEventListener('click', async () => {
    const res = await api.appearance.pick();
    if (res && res.ok) { state.settings.appearance = res.appearance; applyAppearance(); rerender(); }
    else if (res && res.reason !== 'cancelled') toast(t('appear.pickFail'), 'error');
  });
  $('#bgReset', root).addEventListener('click', async () => {
    const res = await api.appearance.clear();
    if (res && res.ok) { state.settings.appearance = res.appearance; applyAppearance(); rerender(); }
  });

  $$('#bgPresets .preset', root).forEach((el) => el.addEventListener('click', async () => {
    $$('#bgPresets .preset', root).forEach((x) => x.classList.toggle('on', x === el));
    await saveAppearance({ bgPreset: el.dataset.v });
  }));
  $$('#bgFit button', root).forEach((b) => b.addEventListener('click', async () => {
    $$('#bgFit button', root).forEach((x) => x.classList.toggle('active', x === b));
    await saveAppearance({ fit: b.dataset.v });
  }));
  $$('#apAccents .accent-dot', root).forEach((el) => el.addEventListener('click', async () => {
    $$('#apAccents .accent-dot', root).forEach((x) => x.classList.toggle('on', x === el));
    await saveAppearance({ accent: el.dataset.v });
  }));
  $$('#apTheme button', root).forEach((b) => b.addEventListener('click', () => {
    $$('#apTheme button', root).forEach((x) => x.classList.toggle('active', x === b));
    setTheme(b.dataset.v);
  }));
  $('#apMotion', root).addEventListener('change', (e) => saveAppearance({ reduceMotion: e.target.checked }));

  // Ползунки применяем сразу, а в файл настроек пишем с задержкой: иначе на
  // каждое движение мыши уходил бы отдельный сброс на диск.
  const slider = (id, numId, key, fmt, parse) => {
    const input = $(id, root);
    const num = $(numId, root);
    const save = debounce((v) => saveAppearance({ [key]: v }), 260);
    input.addEventListener('input', () => {
      const v = parse(input.value);
      num.textContent = fmt(v);
      state.settings.appearance[key] = v;
      applyAppearance();
      save(v);
    });
  };
  slider('#apDim', '#apDimNum', 'dim', (v) => Math.round(v * 100) + '%', Number);
  slider('#apBlur', '#apBlurNum', 'blur', (v) => v + 'px', Number);
  slider('#apSat', '#apSatNum', 'saturate', (v) => v.toFixed(2), Number);
  slider('#apGlass', '#apGlassNum', 'glassAlpha', (v) => Math.round(v * 100) + '%', Number);

  wireRipples(root);
}

function renderDrawer() {
  const drawer = $('#drawer');
  drawer.innerHTML = `
    <div class="drawer-head">
      <h3>${esc(t('appear.title'))}</h3>
      <button class="btn ghost icon-only" id="drawerClose">${ICONS.x}</button>
    </div>
    <div class="drawer-body">${appearanceControlsHtml()}</div>`;
  $('#drawerClose', drawer).addEventListener('click', () => toggleDrawer(false));
  wireAppearanceControls(drawer, renderDrawer);
}

// ── горячие клавиши ────────────────────────────────────────────────
function wireHotkeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    // Пока открыта модалка, она сама разбирает Esc и Enter, а уводить из-под
    // неё навигацию цифрами нельзя.
    const modalOpen = !!$('.modal-overlay');

    if (e.key === 'Escape') {
      if (drawerOpen()) { toggleDrawer(false); return; }
      if (typing) e.target.blur();
      return;
    }
    if (modalOpen) return;
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      runAction(runState() === 'idle' ? 'start' : 'stop');
      return;
    }
    if (e.ctrlKey && (e.key === 'p' || e.key === 'P' || e.key === 'з' || e.key === 'З')) {
      e.preventDefault();
      if (runState() !== 'idle') runAction(runState() === 'paused' ? 'resume' : 'pause');
      return;
    }
    if (e.ctrlKey && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л')) {
      e.preventDefault();
      if (state.route !== 'dashboard') go('dashboard');
      setTimeout(() => { const s = $('#logSearch'); if (s) s.focus(); }, 60);
      return;
    }
    if (typing || modalOpen || e.ctrlKey || e.altKey || e.metaKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= ROUTES.length) go(ROUTES[n - 1].id);
  });
}

// ── обновление данных ──────────────────────────────────────────────
async function refreshProfiles() {
  state.profiles = await api.profiles.list();
  state.profileStats = await api.profiles.stats();

  // Спарклайн: прирост отправленного за тик. Первый замер только задаёт точку
  // отсчёта, иначе весь накопленный за прошлые запуски счёт нарисовался бы
  // одним всплеском.
  const total = state.profiles.reduce((n, p) => n + (p.sentCount || 0), 0);
  if (state.lastSentTotal !== null) {
    state.sendSeries.push(Math.max(0, total - state.lastSentTotal));
    while (state.sendSeries.length > 40) state.sendSeries.shift();
  }
  state.lastSentTotal = total;

  if (state.route === 'profiles') {
    renderProfileCards(document);
    renderProfileDetail(document);
    const s = state.profileStats;
    setNumber($('#sTotal'), s.total);
    setNumber($('#sRun'), s.running);
    setNumber($('#sReady'), s.gmailReady);
    setNumber($('#sPorts'), s.portsOpen);
  } else if (state.route === 'dashboard') {
    paintRun();
  }
}

async function refreshRun() {
  state.runStatus = await api.run.status();
  paintRun();
}

// ── запуск ─────────────────────────────────────────────────────────
async function boot() {
  state.settings = await api.settings.getAll();
  I18N.setLanguage(state.settings.language || 'ru');
  applyTheme(state.settings.theme || 'dark');
  applyAppearance();
  renderChrome();

  $('#appearanceBtn').addEventListener('click', () => toggleDrawer());
  $('#drawerScrim').addEventListener('click', () => toggleDrawer(false));
  $('#winMin').addEventListener('click', () => api.win.minimize());
  $('#winMax').addEventListener('click', async () => {
    const res = await api.win.maximize();
    paintWindowState(!!(res && res.maximized));
  });
  $('#winClose').addEventListener('click', () => api.win.close());
  api.win.onState((s) => paintWindowState(!!s.maximized));
  api.win.isMaximized().then((s) => paintWindowState(!!(s && s.maximized)));

  renderNav();
  render();

  state.logs = await api.logs.recent(200);
  await refreshProfiles();
  await refreshRun();
  state.booted = true;
  render();

  api.logs.onEntry((entry) => appendLog(entry));
  setInterval(refreshRun, 1000);
  setInterval(refreshProfiles, 4000);
  window.addEventListener('resize', debounce(moveNavPill, 120));
  // Гротеск подгружается с font-display: swap - ширина пунктов навигации после
  // подмены шрифта меняется, и пилюля без пересчёта съезжает.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveNavPill);
  wireHotkeys();
}

boot();

})();
