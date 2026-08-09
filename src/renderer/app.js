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
  route: 'home',
  booted: false,
  settings: null,
  profiles: [],
  profileStats: null,
  selectedProfile: null,
  profileFilter: 'all',
  profileMetrics: null, // id -> { written, dialogs, replies }
  stats: null, // { daily: [...], totals: {...} }
  dialogs: [],
  dialogQuery: '',
  notes: [], // лента уведомлений из потока логов
  notesSeen: 0,
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

// Главный экран - статистика: держать на нём пульт запуска незачем, он нужен
// раз в начале прогона. Управление живёт своим разделом, а состояние прогона
// видно из любого места по пилюле и быстрой кнопке в шапке.
const ROUTES = [
  { id: 'home', labelKey: 'nav.home', icon: 'home', titleKey: 'home.title', subKey: 'home.sub', bare: true },
  { id: 'overview', labelKey: 'nav.overview', icon: 'dashboard', titleKey: 'ov.title', subKey: 'ov.sub' },
  { id: 'run', labelKey: 'nav.run', icon: 'play', titleKey: 'run.title', subKey: 'run.sub' },
  { id: 'dialogs', labelKey: 'nav.dialogs', icon: 'chat', titleKey: 'dlg.title', subKey: 'dlg.sub' },
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

/**
 * Числовое поле настроек с нижней границей.
 *
 * Стирать поле, чтобы вписать новое значение, - нормальный способ ввода, и во
 * время правки там на мгновение пусто. Сохранять этот момент как 0 нельзя:
 * ноль в лимитах тихо ломает прогон. Поэтому в настройки уходит только
 * осмысленное значение, а поле поправляется на blur.
 */
function bindNumber(input, section, key, min) {
  if (!input) return;
  input.setAttribute('min', String(min));
  input.addEventListener('input', debounce(() => {
    const raw = input.value.trim();
    if (raw === '') return;
    const val = Math.max(min, Math.floor(Number(raw)) || min);
    saveSection(section, { [key]: val });
  }));
  input.addEventListener('blur', () => {
    const val = Math.max(min, Math.floor(Number(input.value)) || min);
    input.value = String(val);
    saveSection(section, { [key]: val });
  });
}

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

// ── рельс и шапка панели ───────────────────────────────────────────
function renderChrome() {
  $('#appearanceBtn').innerHTML = ICONS.palette;
  $('#appearanceBtn').dataset.label = t('app.appearance');
  paintThemeBtn();

  $('#btnPalette').innerHTML = ICONS.search + '<kbd>Ctrl K</kbd>';
  $('#btnPalette').title = t('palette.title');
  $('#btnBell').innerHTML = ICONS.bell;
  $('#btnBell').title = t('notes.title');

  $('#winMin').innerHTML = ICONS.winMin;
  $('#winMin').title = t('win.minimize');
  $('#winClose').innerHTML = ICONS.winClose;
  $('#winClose').title = t('win.close');
  paintWindowState(false);
  paintClock();
}

function paintThemeBtn() {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const btn = $('#themeBtn');
  btn.innerHTML = dark ? ICONS.sun : ICONS.moon;
  btn.dataset.label = t(dark ? 'appear.theme.light' : 'appear.theme.dark');
}

/** Часы в шапке - как в референсе. Заодно признак того, что окно живое. */
function paintClock() {
  const el = $('#clock');
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function paintWindowState(maximized) {
  const btn = $('#winMax');
  btn.innerHTML = maximized ? ICONS.winRestore : ICONS.winMax;
  btn.title = maximized ? t('win.restore') : t('win.maximize');
}

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const item of ROUTES) {
    const el = h(`<button class="rail-btn ${state.route === item.id ? 'active' : ''}"
      data-label="${esc(t('navShort.' + item.id))}">${ICONS[item.icon]}</button>`);
    el.addEventListener('click', () => go(item.id));
    nav.appendChild(el);
  }
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
  // У витрины свой крупный заголовок внутри - дублировать его в шапке незачем.
  // Элемент оставляем на месте: он распирает шапку, и без него кнопки окна
  // уехали бы к левому краю.
  $('#pageTitle').textContent = route.bare ? '' : t(route.titleKey);
  $('#pageSub').textContent = route.bare ? '' : t(route.subKey);

  const main = $('#main');
  main.innerHTML = '';
  const view = VIEWS[route.id]();
  view.classList.add('view-enter');
  main.appendChild(view);
  main.scrollTop = 0;

  // Кнопки раздела живут внутри вида, а не в шапке: в шапке уже поиск, часы,
  // колокольчик, быстрый пуск и кнопки окна - ещё две туда не влезают.
  const slot = view.querySelector('#viewActions');
  if (slot && ACTIONS[route.id]) ACTIONS[route.id]().forEach((el) => slot.appendChild(el));

  wirePanels(main);
  wireRipples(main);
  wireSheen(main);
  paintRun();
}

// ── Главная: витрина ───────────────────────────────────────────────
// Стартовый экран, с которого расходятся все разделы. Держим его крупным и
// нерабочим: одно главное действие, живые числа и понятные входы дальше.

/** Плитки-входы. Число берётся живьём, чтобы витрина не была декорацией. */
const HOME_TILES = [
  { route: 'run', icon: 'play', titleKey: 'nav.run', descKey: 'home.tile.run', value: (s) => fmtUptime(s.runStatus.uptimeSec) },
  { route: 'profiles', icon: 'profiles', titleKey: 'nav.profiles', descKey: 'home.tile.profiles', value: (s) => s.profiles.length },
  { route: 'dialogs', icon: 'chat', titleKey: 'nav.dialogs', descKey: 'home.tile.dialogs', value: (s) => (s.dialogs || []).length },
  { route: 'overview', icon: 'dashboard', titleKey: 'nav.overview', descKey: 'home.tile.overview', value: (s) => sumMetric(s, 'written') },
];

function sumMetric(s, key) {
  return Object.values(s.profileMetrics || {}).reduce((n, x) => n + (x[key] || 0), 0);
}

/** Приветствие по часам - мелочь, от которой экран перестаёт быть безликим. */
function greetingKey() {
  const h = new Date().getHours();
  if (h < 5) return 'home.hi.night';
  if (h < 12) return 'home.hi.morning';
  if (h < 18) return 'home.hi.day';
  return 'home.hi.evening';
}

/**
 * Шаги готовности. Каждый проверяется по настоящим данным и ведёт туда, где
 * его закрывают: чек-лист без перехода - просто упрёк.
 */
function readySteps() {
  const s = state.settings;
  const ready = state.profiles.filter((p) => p.gmailStatus === 'ready').length;
  return [
    { key: 'profile', done: state.profiles.length > 0, go: () => go('profiles') },
    { key: 'login', done: ready > 0, go: () => go('profiles') },
    { key: 'texts', done: !!s.texts, go: () => goSettings('texts') },
    { key: 'parser', done: !!(s.parser.apiKey && s.parser.platforms.length), go: () => goSettings('parser') },
    { key: 'link', done: !!s.link.apiKey, go: () => goSettings('link') },
  ];
}

VIEWS.home = () => {
  const wrap = h(`<div class="home">
    <section class="home-hero glass glass-refract glass-sheen">
      <div class="hero-glow"></div>
      <div class="home-hero-in">
        <div class="home-main">
          <div class="home-brand">
            <span class="home-logo">GM</span>
            <span>
              <span class="home-name">Gmail Manager</span>
              <span class="home-ver">v0.1.0</span>
            </span>
          </div>

          <h1 class="home-greet" id="homeGreet"></h1>
          <p class="home-lead" id="homeLead"></p>

          <div class="home-cta" id="homeCta"></div>
        </div>

        <aside class="home-quick glass">
          <div class="section-label">${esc(t('home.quick'))}</div>
          <div id="homeQuick"></div>
        </aside>
      </div>

      <div class="home-facts" id="homeFacts"></div>
    </section>

    <section class="home-tiles" id="homeTiles"></section>

    <section class="card glass home-ready" id="homeReady"></section>
  </div>`);

  setTimeout(() => paintHome(), 0);
  return wrap;
};

function paintHome() {
  const greet = $('#homeGreet');
  if (!greet) return;

  greet.textContent = t(greetingKey());
  const mode = runState();
  $('#homeLead').textContent = mode === 'running' ? t('home.leadRunning')
    : mode === 'paused' ? t('home.leadPaused') : t('home.leadIdle');

  // Главное действие одно. Второй кнопкой - самый уместный сейчас переход.
  const cta = $('#homeCta');
  cta.innerHTML = '';
  const primary = h(`<button class="btn big ${mode === 'idle' ? 'primary' : 'stop'}">
    ${mode === 'idle' ? ICONS.play : ICONS.stop}
    <span>${esc(t(mode === 'idle' ? 'home.ctaStart' : 'dash.stop'))}</span></button>`);
  primary.disabled = state.runBusy;
  primary.addEventListener('click', () => runAction(mode === 'idle' ? 'start' : 'stop'));

  const secondary = h(`<button class="btn ghost big">${ICONS.chevron}
    <span>${esc(t('home.ctaOpen'))}</span></button>`);
  secondary.addEventListener('click', () => go('run'));
  cta.append(primary, secondary);
  wireRipples(cta);

  const today = todayRow();
  $('#homeFacts').innerHTML = [
    [t('home.factSent'), sumMetric(state, 'written')],
    [t('home.factToday'), today.sent],
    [t('home.factReplies'), sumMetric(state, 'replies')],
    [t('dash.ready'), state.profiles.filter((p) => p.gmailStatus === 'ready').length],
  ].map(([cap, val]) => `<span class="fact"><b>${esc(String(val))}</b><span>${esc(cap)}</span></span>`).join('');

  paintHomeQuick();
  paintHomeTiles();
  paintHomeReady();
}

/** Быстрые действия витрины: то, что делают руками и часто. */
function paintHomeQuick() {
  const box = $('#homeQuick');
  if (!box) return;
  const acts = [
    { icon: 'plus', key: 'prof.new', run: () => createProfile() },
    { icon: 'send', key: 'dash.testLead', run: () => testLeadFlow() },
    { icon: 'target', key: 'nudge.btn', run: () => nudgeFlow() },
    { icon: 'palette', key: 'app.appearance', run: () => openAppearanceDrawer() },
  ];
  box.innerHTML = acts.map((a, i) => `<button class="quick-row" data-i="${i}">
    <span class="qi">${ICONS[a.icon]}</span>
    <span class="qt">${esc(t(a.key))}</span>
    <span class="qg">${ICONS.chevron}</span>
  </button>`).join('');
  $$('.quick-row', box).forEach((el) => el.addEventListener('click', () => acts[+el.dataset.i].run()));
}

function paintHomeTiles() {
  const box = $('#homeTiles');
  if (!box) return;
  box.innerHTML = HOME_TILES.map((tile) => `<button class="home-tile glass glass-sheen" data-route="${tile.route}">
    <span class="ht-icon">${ICONS[tile.icon]}</span>
    <span class="ht-val">${esc(String(tile.value(state)))}</span>
    <span class="ht-title">${esc(t(tile.titleKey))}</span>
    <span class="ht-desc">${esc(t(tile.descKey))}</span>
    <span class="ht-go">${ICONS.chevron}</span>
  </button>`).join('');
  $$('.home-tile', box).forEach((el) => el.addEventListener('click', () => go(el.dataset.route)));
  wireSheen(box);
}

function paintHomeReady() {
  const box = $('#homeReady');
  if (!box) return;
  const steps = readySteps();
  const done = steps.filter((s) => s.done).length;
  const all = done === steps.length;

  box.innerHTML = `
    <div class="ready-head">
      <div>
        <h3 style="font-size:15px;margin:0">${all ? ICONS.check : ICONS.alert} ${esc(t(all ? 'home.readyAll' : 'home.readyTitle'))}</h3>
        <div class="hint" style="margin-top:4px">${esc(t(all ? 'home.readyAllSub' : 'home.readySub'))}</div>
      </div>
      <div class="ready-count">${done} / ${steps.length}</div>
    </div>
    <div class="ready-bar"><span style="width:${(done / steps.length * 100).toFixed(0)}%"></span></div>
    <div class="ready-list">
      ${steps.map((s, i) => `<button class="ready-step ${s.done ? 'done' : ''}" data-i="${i}">
        <span class="mark">${s.done ? ICONS.check : ''}</span>
        <span class="txt">${esc(t('home.step.' + s.key))}</span>
        ${s.done ? '' : '<span class="go">' + ICONS.chevron + '</span>'}
      </button>`).join('')}
    </div>`;

  $$('.ready-step', box).forEach((el) => el.addEventListener('click', () => steps[+el.dataset.i].go()));
}

// ── Обзор: статистика ──────────────────────────────────────────────
VIEWS.overview = () => {
  const wrap = h(`<div>
    <div class="stats-strip card glass">
      <div class="stat-cell"><div class="num" id="oWritten">0</div><div class="cap">${esc(t('ov.written'))}</div></div>
      <div class="stat-cell" id="oCellReplies"><div class="num" id="oReplies">0</div><div class="cap">${esc(t('ov.replies'))}</div></div>
      <div class="stat-cell" id="oCellConv"><div class="num" id="oConv">0%</div><div class="cap">${esc(t('ov.conversion'))}</div></div>
      <div class="stat-cell"><div class="num" id="oDialogs">0</div><div class="cap">${esc(t('ov.dialogs'))}</div></div>
      <div class="stat-cell" id="oCellErr"><div class="num" id="oErrors">0</div><div class="cap">${esc(t('ov.errors'))}</div></div>
      <div class="strip-note" id="oNote"></div>
    </div>

    <div class="card glass" style="margin-bottom:14px">
      <div class="chart-head">
        <h3 style="font-size:15px;margin:0">${ICONS.dashboard} ${esc(t('ov.chartTitle'))}</h3>
        <div class="legend">
          <span><i class="sw sent"></i>${esc(t('ov.sent'))}</span>
          <span><i class="sw rep"></i>${esc(t('ov.replies'))}</span>
        </div>
      </div>
      <div class="chart" id="oChart"></div>
    </div>

    <div class="grid cols-2">
      <div class="card glass">
        <h3 style="font-size:15px">${ICONS.profiles} ${esc(t('ov.topProfiles'))}</h3>
        <div id="oTop"></div>
      </div>
      <div class="card glass">
        <h3 style="font-size:15px">${ICONS.alert} ${esc(t('ov.events'))}</h3>
        <div id="oEvents"></div>
      </div>
    </div>
  </div>`);

  setTimeout(() => paintOverview(), 0);
  return wrap;
};

function paintOverview() {
  if (!$('#oChart')) return;
  const m = state.profileMetrics || {};
  const written = Object.values(m).reduce((n, x) => n + x.written, 0);
  const dialogs = Object.values(m).reduce((n, x) => n + x.dialogs, 0);
  const replies = Object.values(m).reduce((n, x) => n + x.replies, 0);
  const errors = (state.stats && state.stats.totals.errors) || 0;
  // Конверсия считается от числа адресатов, а не от числа писем: несколько
  // писем одному человеку - это всё ещё один ответивший или не ответивший.
  const conv = written ? Math.round(replies / written * 100) : 0;

  setNumber($('#oWritten'), written);
  setNumber($('#oReplies'), replies);
  setNumber($('#oDialogs'), dialogs);
  setNumber($('#oErrors'), errors);
  $('#oConv').textContent = conv + '%';

  setTone($('#oCellReplies'), replies > 0 ? 'ok' : '');
  setTone($('#oCellConv'), conv >= 10 ? 'ok' : conv > 0 ? 'accent' : '');
  setTone($('#oCellErr'), errors > 0 ? 'bad' : '');

  const plate = $('#oNote');
  if (plate) {
    const sentToday = todayRow().sent;
    plate.innerHTML = sentToday
      ? `<span class="note-plate ok">${ICONS.send}${esc(t('ov.today', { n: sentToday }))}</span>`
      : '';
  }

  paintChart();
  paintTopProfiles();
  paintEvents();
}

function todayRow() {
  const daily = (state.stats && state.stats.daily) || [];
  return daily[daily.length - 1] || { sent: 0, replies: 0, errors: 0 };
}

/** Столбики за 14 дней. Высота считается от максимума по обеим сериям, чтобы
    отправки и ответы читались в одном масштабе. */
function paintChart() {
  const box = $('#oChart');
  if (!box) return;
  const daily = (state.stats && state.stats.daily) || [];
  const peak = Math.max(0, ...daily.map((d) => Math.max(d.sent, d.replies)));
  // Пустые столбики за две недели выглядят как поломка. Пока цифр нет, честнее
  // сказать это словами.
  if (!daily.length || !peak) { box.innerHTML = `<div class="empty">${ICONS.dashboard}<div>${esc(t('ov.noData'))}</div></div>`; return; }

  const max = Math.max(1, peak);
  box.innerHTML = daily.map((d) => {
    const [, mm, dd] = d.day.split('-');
    const title = `${dd}.${mm} - ${t('ov.sent')}: ${d.sent}, ${t('ov.replies')}: ${d.replies}`;
    return `<div class="bar-col" title="${esc(title)}">
      <div class="bars">
        <span class="b sent" style="height:${(d.sent / max * 100).toFixed(1)}%"></span>
        <span class="b rep" style="height:${(d.replies / max * 100).toFixed(1)}%"></span>
      </div>
      <div class="bar-cap">${dd}</div>
    </div>`;
  }).join('');
}

function paintTopProfiles() {
  const box = $('#oTop');
  if (!box) return;
  const m = state.profileMetrics || {};
  const rows = state.profiles
    .map((p) => ({ p, w: (m[p.id] || {}).written || 0, r: (m[p.id] || {}).replies || 0 }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 6);
  if (!rows.length || !rows[0].w) { box.innerHTML = `<div class="empty">${esc(t('ov.noProfiles'))}</div>`; return; }
  const max = Math.max(1, ...rows.map((x) => x.w));
  box.innerHTML = rows.map((x) => `<div class="acc-row">
    <span class="nm">${esc(x.p.label)}</span>
    <span class="track"><span style="width:${(x.w / max * 100).toFixed(1)}%"></span></span>
    <span class="cnt">${x.w} / ${x.r}</span>
  </div>`).join('');
}

/** Лента важных событий - из того же потока логов, что и живые логи. */
function paintEvents() {
  const box = $('#oEvents');
  if (!box) return;
  const rows = state.logs.filter((e) => e.level === 'error' || e.level === 'warn' || e.level === 'success').slice(-8).reverse();
  if (!rows.length) { box.innerHTML = `<div class="empty">${esc(t('ov.noEvents'))}</div>`; return; }
  box.innerHTML = rows.map((e) => `<div class="event ${e.level}">
    <span class="dot"></span>
    <span class="msg">${esc(e.message)}</span>
    <span class="ts">${esc(new Date(e.ts).toLocaleTimeString())}</span>
  </div>`).join('');
}

// ── Рассылка: центр управления ─────────────────────────────────────
VIEWS.run = () => {
  const wrap = h(`<div>
    <div class="stats-strip card glass" id="dStrip">
      <div class="stat-cell"><div class="num" id="sRunState">${dash}</div><div class="cap">${esc(t('dash.status'))}</div></div>
      <div class="stat-cell" data-tone="ok"><div class="num" id="sSent">0</div>
        <svg class="cell-spark" id="dSpark" viewBox="0 0 100 22" preserveAspectRatio="none">
          <path class="area"/><path vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="cap">${esc(t('dash.sentFoot'))}</div></div>
      <div class="stat-cell" id="cQueue"><div class="num" id="sQueue">0</div><div class="cap">${esc(t('dash.queue'))}</div></div>
      <div class="stat-cell" id="cReady"><div class="num" id="sReadyN">0</div><div class="cap">${esc(t('dash.ready'))}</div></div>
      <div class="stat-cell"><div class="num" id="sUptime">0s</div><div class="cap">${esc(t('dash.uptime'))}</div></div>
      <div class="strip-note" id="dNote"></div>
    </div>

    <div class="control glass glass-refract glass-sheen">
      <div>
        <div class="section-label">${esc(t('dash.kicker'))}</div>
        <h2>${esc(t('dash.heroTitle'))}</h2>
        <div class="sub">${esc(t('dash.heroSub'))}</div>
        <div class="control-actions" id="runControls"></div>
        <div class="control-note" id="runNote"></div>
      </div>
      <div class="gauge">
        <svg viewBox="0 0 120 120">
          <circle class="bg" cx="60" cy="60" r="52"/>
          <circle class="fg" id="gaugeArc" cx="60" cy="60" r="52"
            stroke-dasharray="326.7" stroke-dashoffset="326.7"/>
        </svg>
        <div class="mid"><b id="gaugePct">0%</b><span id="gaugeSub">0 / 0</span></div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card glass">
        <h3 style="font-size:15px">${ICONS.profiles} ${esc(t('dash.accounts'))}</h3>
        <div id="dAccounts"></div>
      </div>
      <div class="card glass">
        <h3 style="font-size:15px">${ICONS.target} ${esc(t('targets.title'))}</h3>
        <div class="hint" style="margin-top:-8px;margin-bottom:14px">${esc(t('targets.sub'))}</div>
        <div class="chips" id="dTargets"></div>
        <div class="hint" id="dTargetsHint" style="margin-top:10px"></div>
      </div>
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

  // Диагностическая кнопка - призрачная: рядом с "Запустить" она не должна
  // читаться как равное по важности действие.
  const leadBtn = h(`<button class="btn ghost big">${ICONS.send}<span>${esc(t('dash.testLead'))}</span></button>`);
  leadBtn.addEventListener('click', () => testLeadFlow());
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

  const note = $('#runNote');
  if (note) {
    note.textContent = mode === 'running' ? t('dash.noteRunning')
      : mode === 'paused' ? t('dash.notePaused') : t('dash.noteIdle');
  }

  const ready = state.profiles.filter((p) => p.gmailStatus === 'ready').length;
  const sent = state.profiles.reduce((n, p) => n + (p.sentCount || 0), 0);
  const plan = sessionPlan();

  const st = $('#sRunState');
  if (st) {
    st.textContent = mode === 'running' ? t('dash.running')
      : mode === 'paused' ? t('dash.pausedState') : t('dash.stopped');
    st.style.fontSize = '19px';
    setTone(st.parentElement, mode === 'running' ? 'ok' : mode === 'paused' ? 'warn' : '');
  }
  const up = $('#sUptime'); if (up) up.textContent = fmtUptime(r.uptimeSec);
  setNumber($('#sQueue'), r.queueSize);
  setNumber($('#sReadyN'), ready);
  setNumber($('#sSent'), sent);

  // Цифры красим по смыслу: ноль готовых аккаунтов - это проблема, а не
  // просто число, и выглядеть оно должно иначе, чем пустая очередь.
  setTone($('#cReady'), ready > 0 ? 'ok' : 'bad');
  setTone($('#cQueue'), r.queueSize > 0 ? 'accent' : (mode === 'running' ? 'warn' : ''));

  // Плашка справа в полосе: одна главная причина, по которой прогон не поедет.
  const plate = $('#dNote');
  if (plate) {
    if (!ready) plate.innerHTML = notePlate('bad', t('dash.plateNoReady'));
    else if (!state.settings.texts) plate.innerHTML = notePlate('warn', t('dash.plateNoTexts'));
    else if (mode === 'paused') plate.innerHTML = notePlate('warn', t('dash.platePaused'));
    else plate.innerHTML = '';
  }

  // Кольцо прогресса сессии.
  const arc = $('#gaugeArc');
  if (arc) {
    const c = 2 * Math.PI * 52;
    const done = plan.total ? clamp(plan.done / plan.total, 0, 1) : 0;
    arc.setAttribute('stroke-dasharray', c.toFixed(1));
    arc.setAttribute('stroke-dashoffset', (c * (1 - done)).toFixed(1));
    $('#gaugePct').textContent = Math.round(done * 100) + '%';
    $('#gaugeSub').textContent = plan.done + ' / ' + plan.total;
  }

  paintAccountRows(plan);
  paintRunControls();
  paintQuickRun();
  paintSpark();
  if (state.route === 'home') paintHome();
}

function notePlate(kind, text) {
  return `<span class="note-plate ${kind === 'warn' ? 'warn' : ''}">${ICONS.alert}${esc(text)}</span>`;
}

/** Мини-строки готовых аккаунтов с прогрессом по лимиту. */
function paintAccountRows(plan) {
  const box = $('#dAccounts');
  if (!box) return;
  const limit = state.settings.system.mailsPerAccount || 0;
  const ready = state.profiles.filter((p) => p.gmailStatus === 'ready');
  if (!ready.length) {
    box.innerHTML = `<div class="empty" style="padding:24px 0">${esc(t('dash.noAccounts'))}</div>`;
    return;
  }
  box.innerHTML = ready.map((p) => {
    const done = limit > 0 ? clamp((p.sentCount || 0) / limit, 0, 1) : 0;
    const live = plan.current && plan.current.id === p.id && state.runStatus.running;
    return `<div class="acc-row">
      <span class="nm">${esc(p.label)}${live ? ' <span class="pc-tag live">' + esc(t('prof.writingNow')) + '</span>' : ''}</span>
      <span class="track"><span style="width:${(done * 100).toFixed(1)}%"></span></span>
      <span class="cnt">${p.sentCount || 0} / ${limit}</span>
    </div>`;
  }).join('');
}

/**
 * План сессии по готовым аккаунтам: сколько писем всего заложено лимитом,
 * сколько уже ушло и кто пишет сейчас. Порядок тот же, что у движка -
 * аккаунты заполняются последовательно (см. _currentAccount в senderEngine).
 */
function sessionPlan() {
  const limit = state.settings.system.mailsPerAccount || 0;
  const ready = state.profiles.filter((p) => p.gmailStatus === 'ready');
  const done = ready.reduce((n, p) => n + Math.min(p.sentCount || 0, limit), 0);
  return {
    total: ready.length * limit,
    done,
    current: ready.find((p) => (p.sentCount || 0) < limit) || null,
  };
}

function setTone(el, tone) {
  if (el) el.dataset.tone = tone;
}

function paintSpark() {
  const svg = $('#dSpark');
  if (!svg) return;
  // Пока истории нет, рисуем ровную линию по низу: пустой спарклайн оставлял
  // в плитке дыру, и подпись съезжала ниже, чем у соседних плиток.
  const values = state.sendSeries.length >= 2 ? state.sendSeries : [0, 0];
  const [area, line] = svg.children;
  const w = 100, hh = 22;
  const max = Math.max(1, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, hh - (v / max) * (hh - 4) - 2]);
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
  nudge.addEventListener('click', () => nudgeFlow());

  const create = h(`<button class="btn primary">${ICONS.plus}<span>${esc(t('prof.new'))}</span></button>`);
  create.addEventListener('click', () => createProfile());
  return [nudge, create];
};

// ── Диалоги ────────────────────────────────────────────────────────
// Показываем то, что действительно знаем: с кем переписка, по какому товару,
// сколько автоответов ушло и когда был последний. Тел писем у приложения нет -
// оно их не хранит, и выдумывать переписку в интерфейсе нечестно.
VIEWS.dialogs = () => {
  const wrap = h(`<div>
    <div class="filter-row">
      <div style="flex:1 1 320px;max-width:420px">
        <input type="text" id="dlgSearch" placeholder="${esc(t('dlg.search'))}" value="${esc(state.dialogQuery)}"/>
      </div>
      <span class="logs-count" id="dlgCount"></span>
      <span class="spacer"></span>
      <span id="viewActions" style="display:flex;gap:8px"></span>
    </div>
    <div id="dlgList"></div>
  </div>`);

  wrap.querySelector('#dlgSearch').addEventListener('input', debounce((e) => {
    state.dialogQuery = e.target.value;
    renderDialogs();
  }, 200));

  setTimeout(() => renderDialogs(), 0);
  return wrap;
};

function renderDialogs() {
  const box = $('#dlgList');
  if (!box) return;
  const q = state.dialogQuery.trim().toLowerCase();
  const rows = (state.dialogs || []).filter((d) => !q
    || d.email.toLowerCase().includes(q)
    || (d.title || '').toLowerCase().includes(q)
    || (d.profileLabel || '').toLowerCase().includes(q));

  const cnt = $('#dlgCount');
  if (cnt) cnt.textContent = t('logs.shown', { shown: rows.length, total: (state.dialogs || []).length });

  if (!rows.length) {
    box.innerHTML = `<div class="card glass"><div class="empty">${ICONS.chat}
      <div>${esc((state.dialogs || []).length ? t('dlg.emptyFiltered') : t('dlg.empty'))}</div></div></div>`;
    return;
  }

  const cap = state.settings.system.maxRepliesPerDialog;
  box.innerHTML = `<div class="cards-grid">` + rows.map((d) => `
    <div class="dlg-card glass">
      <div class="dlg-head">
        <span class="pc-avatar" style="--av:${avatarColor({ email: d.email })}">${esc((d.email || '?').charAt(0).toUpperCase())}</span>
        <span class="pc-id">
          <span class="pc-name">${esc(d.email || dash)}</span>
          <div class="pc-email">${esc(d.title || t('dlg.noTitle'))}</div>
        </span>
        <span class="pc-tag ${d.replies >= cap ? 'done' : 'live'}">${d.replies} / ${cap}</span>
      </div>
      <div class="pc-meta">
        <span>${esc(d.profileLabel || dash)}</span>
        <span class="chip-mini">${esc(d.price ? d.price + ' ' + (d.currency || '') : dash)}</span>
      </div>
      <div class="pc-foot">
        <span>${esc(t('dlg.last'))}: ${esc(fmtDate(d.lastReplyAt))}</span>
        <span class="acts">
          <button class="mini go" data-nudge="${esc(d.email)}" title="${esc(t('nudge.btn'))}">${ICONS.send}</button>
        </span>
      </div>
    </div>`).join('') + `</div>`;

  $$('[data-nudge]', box).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    toast(t('nudge.sending'));
    try {
      const res = await api.contacts.nudge(b.dataset.nudge);
      if (res && res.ok) { toast(t('nudge.ok'), 'success'); await refreshProfiles(); }
      else toast(t('nudge.fail.' + ((res && res.reason) || 'unknown')), 'error');
    } catch (err) { toast(t('nudge.error', { error: err.message }), 'error'); }
  }));
}

// Фильтры карточек профилей. Считаются по тем же полям, что рисует карточка.
const PROFILE_FILTERS = [
  { id: 'all', match: () => true },
  { id: 'ready', match: (p) => p.gmailStatus === 'ready' },
  { id: 'running', match: (p) => p.running },
  { id: 'problems', match: (p) => p.gmailStatus === 'needs_login' || p.gmailStatus === 'error' },
];

VIEWS.profiles = () => {
  const s = state.profileStats || { total: 0, running: 0, gmailReady: 0, portsOpen: 0 };
  const wrap = h(`<div>
    <div class="stats-strip card glass">
      <div class="stat-cell"><div class="num" id="sOnline">0/0</div><div class="cap">${esc(t('prof.runningCount'))}</div></div>
      <div class="stat-cell" id="cWritten"><div class="num" id="sWritten">0</div><div class="cap">${esc(t('prof.written'))}</div></div>
      <div class="stat-cell" id="cDialogs"><div class="num" id="sDialogs">0</div><div class="cap">${esc(t('prof.dialogs'))}</div></div>
      <div class="stat-cell" id="cProblems"><div class="num" id="sProblems">0</div><div class="cap">${esc(t('prof.problems'))}</div></div>
      <div class="strip-note" id="pNote"></div>
    </div>

    <div class="filter-row">
      <div class="seg filters" id="pFilters"></div>
      <span class="spacer"></span>
      <span id="viewActions" style="display:flex;gap:8px"></span>
    </div>

    <div class="cards-grid" id="cards"></div>
  </div>`);

  setTimeout(() => {
    paintProfileStats(s);
    renderProfileFilters(wrap);
    renderProfileCards(wrap);
  }, 0);
  return wrap;
};

function renderProfileFilters(root) {
  const box = root.querySelector('#pFilters') || $('#pFilters');
  if (!box) return;
  box.innerHTML = PROFILE_FILTERS.map((f) => {
    const n = state.profiles.filter(f.match).length;
    return `<button data-v="${f.id}" class="${state.profileFilter === f.id ? 'active' : ''}">
      ${esc(t('prof.filter.' + f.id))}<span class="count">${n}</span></button>`;
  }).join('');
  $$('button', box).forEach((b) => b.addEventListener('click', () => {
    state.profileFilter = b.dataset.v;
    renderProfileFilters(document);
    renderProfileCards(document);
  }));
}

function paintProfileStats(s) {
  const online = $('#sOnline');
  if (online) online.textContent = s.running + '/' + s.total;
  const m = state.profileMetrics || {};
  const written = Object.values(m).reduce((n, x) => n + x.written, 0);
  const dialogs = Object.values(m).reduce((n, x) => n + x.dialogs, 0);
  const problems = state.profiles.filter((p) => p.gmailStatus === 'needs_login' || p.gmailStatus === 'error').length;
  setNumber($('#sWritten'), written);
  setNumber($('#sDialogs'), dialogs);
  setNumber($('#sProblems'), problems);
  // Ноль не подсвечиваем: цвет должен означать "тут есть что смотреть".
  setTone($('#cWritten'), written > 0 ? 'ok' : '');
  setTone($('#cDialogs'), dialogs > 0 ? 'accent' : '');
  setTone($('#cProblems'), problems > 0 ? 'bad' : '');
  const plate = $('#pNote');
  if (plate) plate.innerHTML = problems ? notePlate('warn', t('prof.plateProblems', { n: problems })) : '';
}

function renderProfileCards(root) {
  const cards = root.querySelector('#cards') || $('#cards');
  if (!cards) return;
  const limit = state.settings.system.mailsPerAccount;
  cards.innerHTML = '';
  if (!state.booted) {
    for (let i = 0; i < 3; i++) cards.appendChild(h(`<div class="skeleton tile"></div>`));
    return;
  }
  if (!state.profiles.length) {
    const empty = h(`<div class="empty glass" style="grid-column:1/-1">${ICONS.profiles}
      <div>${esc(t('prof.empty'))}</div>
      <button class="btn primary" id="emptyCreate">${ICONS.plus}<span>${esc(t('prof.emptyAction'))}</span></button></div>`);
    empty.querySelector('#emptyCreate').addEventListener('click', () => createProfile());
    cards.appendChild(empty);
    wireRipples(cards);
    return;
  }
  // Аккаунт, который движок пишет прямо сейчас - его карточку помечаем, чтобы
  // было видно, куда уходят письма.
  const current = sessionPlan().current;
  const filter = PROFILE_FILTERS.find((f) => f.id === state.profileFilter) || PROFILE_FILTERS[0];
  const shown = state.profiles.filter(filter.match);

  if (!shown.length) {
    cards.appendChild(h(`<div class="empty glass" style="grid-column:1/-1">${ICONS.profiles}
      <div>${esc(t('prof.emptyFiltered'))}</div></div>`));
    return;
  }

  for (const p of shown) {
    const done = limit > 0 ? clamp((p.sentCount || 0) / limit, 0, 1) : 0;
    const isCurrent = !!(current && current.id === p.id && state.runStatus.running);
    const m = (state.profileMetrics || {})[p.id] || { written: 0, dialogs: 0, replies: 0 };
    const bad = p.gmailStatus === 'error' || p.gmailStatus === 'needs_login';
    const card = h(`<div class="profile-card glass glass-sheen ${state.selectedProfile === p.id ? 'selected' : ''} ${isCurrent ? 'current' : ''} ${bad ? 'error' : ''}">
      <div class="pc-head">
        <span class="pc-avatar" style="--av:${avatarColor(p)}">${esc(avatarLetter(p))}
          <span class="mark ${p.gmailStatus}"></span></span>
        <span class="pc-id">
          <span class="pc-name">${esc(p.label)}</span>
          <div class="pc-email">${esc(p.email || t('prof.notSignedIn'))}</div>
          <div class="pc-tags">${profileTags(p, m, isCurrent, limit)}</div>
        </span>
        <span class="pc-head-actions">
          <button class="mini go" data-act="${p.running ? 'stop' : 'launch'}"
            title="${esc(p.running ? t('prof.stopBtnFull') : t('prof.launch'))}">${p.running ? ICONS.stop : ICONS.play}</button>
          <button class="mini" data-act="scan" title="${esc(t('prof.scan'))}">${ICONS.reset}</button>
        </span>
      </div>

      <div class="pc-nums">
        <span class="n"><b>${m.written}</b><span>${esc(t('prof.written'))}</span></span>
        <span class="n" ${m.dialogs ? 'data-tone="accent"' : ''}><b>${m.dialogs}</b><span>${esc(t('prof.dialogs'))}</span></span>
        <span class="n" ${m.replies ? 'data-tone="ok"' : ''}><b>${m.replies}</b><span>${esc(t('prof.replies'))}</span></span>
      </div>

      <div class="pc-meta">
        <span><span class="dot ${p.running ? 'running' : 'new'}"></span> ${esc(p.running ? t('prof.running') : t('prof.stopped'))}</span>
        <span>${esc(t('prof.port'))}: ${p.port || dash}</span>
        <span class="chip-mini">${p.sentCount} / ${limit}</span>
      </div>

      <div class="pc-foot">
        <span>${esc(fmtDate(p.createdAt))}</span>
        <span class="acts">
          <button class="mini" data-act="open" title="${esc(t('prof.details'))}">${ICONS.settings}</button>
          <button class="mini" data-act="test" title="${esc(t('prof.testSend'))}">${ICONS.send}</button>
          <button class="mini danger" data-act="del" title="${esc(t('prof.delete'))}">${ICONS.trash}</button>
        </span>
      </div>

      <div class="pc-progress"><span style="width:${(done * 100).toFixed(1)}%"></span></div>
    </div>`);

    card.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) { openProfileDrawer(p.id); return; }
      e.stopPropagation();
      profileAction(btn.dataset.act, p);
    });
    cards.appendChild(card);
  }

  const add = h(`<div class="add-card">
    <span class="plus">${ICONS.plus}</span>
    <span class="cap">${esc(t('prof.new'))}</span>
    <span class="sub">${esc(t('prof.addSub'))}</span></div>`);
  add.addEventListener('click', () => createProfile());
  cards.appendChild(add);

  wireSheen(cards);
}

/**
 * Теги карточки. Только то, что видно по данным: выдуманных ярлыков вроде
 * "надёжный" здесь быть не должно - они ничего не значат.
 */
function profileTags(p, m, isCurrent, limit) {
  const tags = [];
  if (isCurrent) tags.push(['live', t('prof.writingNow')]);
  if (p.gmailStatus !== 'ready') tags.push([p.gmailStatus === 'error' ? 'bad' : 'warn', t('status.' + p.gmailStatus)]);
  if (limit > 0 && (p.sentCount || 0) >= limit) tags.push(['done', t('prof.tagLimit')]);
  if (m.replies > 0) tags.push(['ok', t('prof.tagReplies', { n: m.replies })]);
  if (!tags.length) tags.push(['', t('status.ready')]);
  return tags.map(([cls, text]) => `<span class="pc-tag ${cls}">${esc(text)}</span>`).join('');
}

/** Действия с карточки профиля. Те же, что в панели деталей. */
async function profileAction(act, p) {
  if (act === 'launch') return launchProfile(p.id, true);
  if (act === 'stop') { await api.profiles.stop(p.id); return refreshProfiles(); }
  if (act === 'open') return openProfileDrawer(p.id);
  if (act === 'scan') {
    toast(t('prof.scanning'));
    try { await api.profiles.scan(p.id); await refreshProfiles(); toast(t('prof.scanDone'), 'success'); }
    catch (e) { toast(t('prof.scanFailed', { error: e.message }), 'error'); }
    return undefined;
  }
  if (act === 'test') {
    const to = await askText(t('prof.askTestTo'), { value: p.email || '', placeholder: 'recipient@example.com' });
    if (!to) return undefined;
    toast(t('prof.testSending'));
    try {
      const res = await api.gmail.testSend(p.id, { to, subject: t('prof.testSubject'), body: t('prof.testBody') });
      const ok = !!(res && res.ok);
      toast(ok ? t('prof.testSent') : t('prof.testUnconfirmed'), ok ? 'success' : 'error');
    } catch (e) { toast(t('prof.testFailed', { error: e.message }), 'error'); }
    return undefined;
  }
  if (act === 'del') {
    const ok = await askConfirm(t('prof.confirmDeleteTitle'), t('prof.confirmDeleteText', { label: p.label }),
      { danger: true, okLabel: t('common.delete') });
    if (!ok) return undefined;
    await api.profiles.remove(p.id);
    if (state.selectedProfile === p.id) { state.selectedProfile = null; setDrawerOpen(false); }
    return refreshProfiles();
  }
  return undefined;
}

/** Буква и цвет аватара выводятся из почты или названия - одинаковые для
    одного профиля между запусками, поэтому его узнаёшь по цвету. */
function avatarLetter(p) {
  const src = (p.email || p.label || '?').trim();
  return src.charAt(0).toUpperCase();
}

function avatarColor(p) {
  const src = (p.email || p.label || p.id || '');
  let hash = 0;
  for (let i = 0; i < src.length; i++) hash = (hash * 31 + src.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 52% 42%)`;
}

function fmtDate(ts) {
  if (!ts) return dash;
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function createProfile() {
  const label = await askText(t('prof.askName'), { value: t('prof.defaultName', { n: state.profiles.length + 1 }) });
  if (label === null) return;
  const p = await api.profiles.create(label);
  toast(t('prof.created'), 'success');
  await refreshProfiles();
  state.selectedProfile = p.id;
  // Сразу открываем профиль с Gmail - вход пользователь делает руками.
  launchProfile(p.id, true);
}

/** Открыть детали профиля в выезжающей панели. */
function openProfileDrawer(id) {
  state.selectedProfile = id;
  renderProfileCards(document);
  openDrawer({
    kind: 'profile',
    id,
    title: (state.profiles.find((x) => x.id === id) || {}).label || t('prof.title'),
    build: (body) => {
      const p = state.profiles.find((x) => x.id === id);
      if (!p) { setDrawerOpen(false); return; }
      body.appendChild(profileDetailCard(p));
    },
  });
}

function profileDetailCard(p) {
  const fp = p.fingerprint;
  const card = h(`<div>
    <div class="kv"><span class="k">${esc(t('prof.status'))}</span><span class="v"><span class="badge ${p.gmailStatus}">${esc(t('status.' + p.gmailStatus))}</span></span></div>
    <div class="kv"><span class="k">${esc(t('prof.email'))}</span><span class="v">${esc(p.email || dash)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.isRunning'))}</span><span class="v">${p.running ? esc(t('common.yes')) : esc(t('common.no'))}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.port'))}</span><span class="v">${p.port || dash}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.sentCount'))}</span><span class="v">${p.sentCount} / ${state.settings.system.mailsPerAccount}</span></div>
    <div class="kv stacked"><span class="k">${esc(t('prof.ua'))}</span><span class="v">${esc(fp.userAgent)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.platform'))}</span><span class="v">${esc(fp.platform)}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.screen'))}</span><span class="v">${fp.screen.width}x${fp.screen.height}</span></div>
    <div class="kv"><span class="k">${esc(t('prof.timezone'))}</span><span class="v">${esc(fp.timezone)}</span></div>
    <div class="kv stacked"><span class="k">${esc(t('prof.gpu'))}</span><span class="v">${esc(fp.webgl.renderer)}</span></div>
    <div class="drawer-actions">
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
    setDrawerOpen(false);
    await refreshProfiles();
  });

  return card;
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

/** Шапка карточки настроек. Название группы уже стоит в боковом меню, поэтому
    здесь только поясняющий заголовок - иначе одно и то же трижды на экране. */
function setCard(groupId, bodyHtml) {
  return `<div class="card glass">
    <h3 style="font-size:17px;margin-bottom:16px">${esc(t('set.h.' + groupId))}</h3>
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
  // Минимумы обязательны. Пустое поле или ноль в "Писем на аккаунт" делали
  // прогон бессмысленным: движок не находил ни одного аккаунта под лимитом,
  // ничего не отправлял и писал в лог "все лимиты достигнуты".
  bindNumber($('#mMails', el), 'system', 'mailsPerAccount', 1);
  bindNumber($('#mReplies', el), 'system', 'maxRepliesPerDialog', 0);
  bindNumber($('#mCheck', el), 'system', 'checkIntervalSec', 3);
  bindNumber($('#mBatch', el), 'system', 'parserBatchSize', 1);
  bindNumber($('#mThresh', el), 'system', 'queueRefillThreshold', 1);
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
  bindNumber($('#pSwapN', el), 'parser', 'swapKeyEveryN', 0);
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
  bindNumber($('#cStart', el), 'cdp', 'portStart', 1024);
  bindNumber($('#cEnd', el), 'cdp', 'portEnd', 1024);
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

// ── Выезжающая панель ──────────────────────────────────────────────
// Одна панель на всё: оформление и детали профиля. Что именно в ней
// показано, помнит drawerView - он же умеет перерисовать себя, когда
// данные обновились (например, профиль запустился).
let drawerView = null;

function drawerOpen() { return $('#drawer').classList.contains('open'); }

function setDrawerOpen(open) {
  $('#drawer').classList.toggle('open', open);
  $('#drawerScrim').classList.toggle('open', open);
  if (!open) drawerView = null;
}

function openDrawer(view) {
  drawerView = view;
  renderDrawerView();
  setDrawerOpen(true);
}

function renderDrawerView() {
  if (!drawerView) return;
  const drawer = $('#drawer');
  drawer.innerHTML = `
    <div class="drawer-head">
      <h3>${esc(drawerView.title)}</h3>
      <button class="btn ghost icon-only" id="drawerClose">${ICONS.x}</button>
    </div>
    <div class="drawer-body" id="drawerBody"></div>`;
  $('#drawerClose', drawer).addEventListener('click', () => setDrawerOpen(false));
  drawerView.build($('#drawerBody', drawer), renderDrawerView);
  wireRipples(drawer);
}

function openAppearanceDrawer() {
  openDrawer({
    kind: 'appearance',
    title: t('appear.title'),
    build: (body, rerender) => {
      body.innerHTML = appearanceControlsHtml();
      wireAppearanceControls(body, rerender);
    },
  });
}

function toggleAppearanceDrawer() {
  if (drawerOpen() && drawerView && drawerView.kind === 'appearance') setDrawerOpen(false);
  else openAppearanceDrawer();
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


// ── уведомления ────────────────────────────────────────────────────
// Отдельного источника у ленты нет: важное и так проходит через логгер, так что
// колокольчик просто отбирает из него предупреждения, ошибки и успехи.
const NOTE_LEVELS = ['error', 'warn', 'success'];

function noteFromLog(entry) {
  if (!NOTE_LEVELS.includes(entry.level)) return;
  state.notes.push(entry);
  while (state.notes.length > 60) state.notes.shift();
  paintBell();
}

function paintBell() {
  const dot = $('#bellDot');
  if (!dot) return;
  const unread = Math.max(0, state.notes.length - state.notesSeen);
  dot.textContent = unread > 9 ? '9+' : String(unread);
  dot.classList.toggle('on', unread > 0);
}

function toggleNotes(open) {
  const box = $('#notes');
  const next = open === undefined ? !box.classList.contains('open') : open;
  box.classList.toggle('open', next);
  if (!next) return;
  state.notesSeen = state.notes.length;
  paintBell();
  const rows = state.notes.slice(-25).reverse();
  box.innerHTML = `<div class="notes-head">${esc(t('notes.title'))}</div>` + (rows.length
    ? rows.map((e) => `<div class="event ${e.level}">
        <span class="dot"></span>
        <span class="msg">${esc(e.message)}</span>
        <span class="ts">${esc(new Date(e.ts).toLocaleTimeString())}</span>
      </div>`).join('')
    : `<div class="empty" style="padding:26px 12px">${esc(t('notes.empty'))}</div>`);
}

/** Быстрый пуск в шапке: пульт живёт в своём разделе, но состояние менять
    должно быть можно из любого места. */
function paintQuickRun() {
  const btn = $('#quickRun');
  if (!btn) return;
  const mode = runState();
  const start = mode === 'idle';
  btn.className = 'btn quick ' + (start ? 'primary' : 'stop');
  btn.innerHTML = (start ? ICONS.play : ICONS.stop) + `<span>${esc(t(start ? 'dash.start' : 'dash.stop'))}</span>`;
  btn.disabled = state.runBusy;
  btn.dataset.action = start ? 'start' : 'stop';
}

// ── командная палитра ──────────────────────────────────────────────
// Ctrl+K: один список из разделов, групп настроек и действий. Действия
// собираются от текущего состояния - "Пауза" не появится на остановленном
// прогоне, а "Продолжить" не появится на работающем.
let paletteIndex = 0;
let paletteRows = [];

function paletteOpen() { return $('#paletteScrim').classList.contains('open'); }

function paletteCommands() {
  const rows = [];
  for (const r of ROUTES) {
    rows.push({ group: 'palette.g.sections', icon: r.icon, label: t(r.titleKey), hint: t('palette.go'), run: () => go(r.id) });
  }
  for (const g of SETTINGS_GROUPS) {
    rows.push({ group: 'palette.g.settings', icon: g.icon, label: t('set.g.' + g.id), hint: t('palette.open'), run: () => goSettings(g.id) });
  }

  const mode = runState();
  if (mode === 'idle') rows.push({ group: 'palette.g.actions', icon: 'play', label: t('dash.start'), run: () => runAction('start') });
  else {
    rows.push({ group: 'palette.g.actions', icon: 'stop', label: t('dash.stop'), run: () => runAction('stop') });
    rows.push({ group: 'palette.g.actions', icon: mode === 'paused' ? 'play' : 'pause', label: t(mode === 'paused' ? 'dash.resume' : 'dash.pause'), run: () => runAction(mode === 'paused' ? 'resume' : 'pause') });
  }
  rows.push({ group: 'palette.g.actions', icon: 'plus', label: t('prof.new'), run: () => createProfile() });
  rows.push({ group: 'palette.g.actions', icon: 'send', label: t('nudge.btn'), run: () => nudgeFlow() });
  rows.push({ group: 'palette.g.actions', icon: 'palette', label: t('app.appearance'), run: () => openAppearanceDrawer() });
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  rows.push({ group: 'palette.g.actions', icon: dark ? 'sun' : 'moon', label: t(dark ? 'appear.theme.light' : 'appear.theme.dark'), run: () => setTheme(dark ? 'light' : 'dark') });
  return rows;
}

function togglePalette(open) {
  const scrim = $('#paletteScrim');
  const next = open === undefined ? !paletteOpen() : open;
  scrim.classList.toggle('open', next);
  if (!next) return;
  paletteIndex = 0;
  renderPalette('');
  const input = $('#paletteInput');
  input.value = '';
  input.focus();
}

function renderPalette(query) {
  const q = query.trim().toLowerCase();
  paletteRows = paletteCommands().filter((r) => !q || r.label.toLowerCase().includes(q));
  paletteIndex = clamp(paletteIndex, 0, Math.max(0, paletteRows.length - 1));

  let html = '';
  let lastGroup = null;
  paletteRows.forEach((r, i) => {
    if (r.group !== lastGroup) { html += `<div class="palette-group">${esc(t(r.group))}</div>`; lastGroup = r.group; }
    html += `<div class="palette-item ${i === paletteIndex ? 'on' : ''}" data-i="${i}">
      <span class="icon">${ICONS[r.icon] || ''}</span><span>${esc(r.label)}</span>
      ${r.hint ? '<span class="go">' + esc(r.hint) + '</span>' : ''}</div>`;
  });

  $('#paletteList').innerHTML = paletteRows.length ? html : `<div class="palette-empty">${esc(t('palette.empty'))}</div>`;
  $$('#paletteList .palette-item').forEach((el) => {
    el.addEventListener('mousemove', () => { paletteIndex = +el.dataset.i; markPalette(); });
    el.addEventListener('click', () => runPalette(+el.dataset.i));
  });
  markPalette();
}

function markPalette() {
  $$('#paletteList .palette-item').forEach((el) => {
    const on = +el.dataset.i === paletteIndex;
    el.classList.toggle('on', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
}

function runPalette(i) {
  const row = paletteRows[i];
  if (!row) return;
  togglePalette(false);
  row.run();
}

function buildPalette() {
  $('#palette').innerHTML = `
    <div class="palette-search">
      ${ICONS.search}
      <input type="text" id="paletteInput" class="grow" placeholder="${esc(t('palette.placeholder'))}"/>
      <kbd>esc</kbd>
    </div>
    <div class="palette-list" id="paletteList"></div>
    <div class="palette-foot">
      <span><kbd>↑↓</kbd>${esc(t('palette.nav'))}</span>
      <span><kbd>enter</kbd>${esc(t('palette.pick'))}</span>
    </div>`;

  const input = $('#paletteInput');
  input.addEventListener('input', () => { paletteIndex = 0; renderPalette(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, paletteRows.length - 1); markPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); markPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteIndex); }
  });
  $('#paletteScrim').addEventListener('mousedown', (e) => {
    if (e.target === $('#paletteScrim')) togglePalette(false);
  });
}

/** Тестовый лид: письмо на свой адрес обычным путём рассылки. */
async function testLeadFlow() {
  const email = await askText(t('dash.testLeadAsk'), { placeholder: 'me@gmail.com' });
  if (!email) return;
  const res = await api.run.testLead(email.trim());
  if (res && res.ok) toast(t('dash.testLeadOk', { email: res.lead.email }), 'success');
  else toast(t('dash.testLeadFail'), 'error');
  refreshRun();
}

/** Подталкивание вынесено отдельно - зовётся и с кнопки, и из палитры. */
async function nudgeFlow() {
  const email = await askText(t('nudge.ask'), { placeholder: 'seller@example.com' });
  if (!email) return;
  toast(t('nudge.sending'));
  try {
    const res = await api.contacts.nudge(email.trim());
    if (res && res.ok) { toast(t('nudge.ok'), 'success'); await refreshProfiles(); }
    else toast(t('nudge.fail.' + ((res && res.reason) || 'unknown')), 'error');
  } catch (e) { toast(t('nudge.error', { error: e.message }), 'error'); }
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
      if (paletteOpen()) { togglePalette(false); return; }
      if (drawerOpen()) { setDrawerOpen(false); return; }
      if (typing) e.target.blur();
      return;
    }
    if (modalOpen) return;
    // Палитра сама разбирает стрелки и Enter, пока открыта.
    if (paletteOpen() && e.key !== 'k' && e.key !== 'K') return;
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
      togglePalette();
      return;
    }
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А')) {
      e.preventDefault();
      if (state.route !== 'run') go('run');
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
  state.profileMetrics = await api.profiles.metrics();
  state.stats = await api.stats.overview(14);
  state.dialogs = await api.dialogs.list();

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
    renderProfileFilters(document);
    renderProfileCards(document);
    paintProfileStats(state.profileStats);
  } else if (state.route === 'run') {
    paintRun();
  } else if (state.route === 'overview') {
    paintOverview();
  } else if (state.route === 'dialogs') {
    renderDialogs();
  } else if (state.route === 'home') {
    paintHome();
  }
  // Открытые детали профиля тоже подтягиваем: пользователь мог нажать
  // "Запустить" и ждёт, что кнопка сменится на "Остановить".
  if (drawerView && drawerView.kind === 'profile') renderDrawerView();
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

  buildPalette();
  $('#appearanceBtn').addEventListener('click', () => toggleAppearanceDrawer());
  $('#themeBtn').addEventListener('click', async () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    await setTheme(dark ? 'light' : 'dark');
    paintThemeBtn();
  });
  $('#btnPalette').addEventListener('click', () => togglePalette(true));
  $('#btnBell').addEventListener('click', (e) => { e.stopPropagation(); toggleNotes(); });
  $('#quickRun').addEventListener('click', () => runAction($('#quickRun').dataset.action));
  // Клик мимо ленты закрывает её - отдельной кнопки закрытия там нет.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bell-wrap')) toggleNotes(false);
  });
  $('#drawerScrim').addEventListener('click', () => setDrawerOpen(false));
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

  state.notes = state.logs.filter((e) => NOTE_LEVELS.includes(e.level)).slice(-60);
  state.notesSeen = state.notes.length;
  paintBell();

  api.logs.onEntry((entry) => { appendLog(entry); noteFromLog(entry); });
  setInterval(refreshRun, 1000);
  setInterval(refreshProfiles, 4000);
  setInterval(paintClock, 15000);
  wireHotkeys();
}

boot();

})();
