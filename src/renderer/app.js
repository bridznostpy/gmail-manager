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
  slowFetchedAt: 0, // когда последний раз тянули журнал и диалоги
  // Экран чатов: список, открытая переписка и её лента.
  chats: [],
  chatQuery: '',
  chatFilter: 'all',
  chatProfile: '', // выбранный профиль в колонке слева, пусто = все
  openChat: '',
  chatMessages: [],
  notes: [], // лента уведомлений из потока логов
  notesSeen: 0,
  // Выбранная группа на странице настроек - переживает уход на другой раздел.
  settingsGroup: 'limits',
  settingsQuery: '', // поиск по настройкам, тоже переживает уход со страницы
  profileQuery: '', // поиск по профилям: имя, почта профиля и почты внутри него
  // Отмеченные карточки. Массив, а не Set: список попадает в подпись
  // JSON.stringify, по которой решается, пересобирать ли сетку.
  selectedProfiles: [],
  // Идёт массовое действие: { kind, total, done, cancel }.
  bulk: null,
  // Прирост отправленного по каждому профилю за тик опроса - для спарклайна и
  // прогноза. Общий ряд sendSeries суммарный, и по нему не видно, какой
  // аккаунт встал.
  profileSeries: {},
  // Значения по умолчанию из main - по ним видно, какие разделы человек трогал.
  // Тянем один раз при первом заходе в настройки, они не меняются.
  settingsDefaults: null,
  textsLang: 'en', // язык, открытый на экране текстов рассылки
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
  { id: 'chats', labelKey: 'nav.chats', icon: 'chat', titleKey: 'chat.title', subKey: 'chat.sub', fullHeight: true },
  { id: 'profiles', labelKey: 'nav.profiles', icon: 'profiles', titleKey: 'prof.title', subKey: 'prof.sub' },
  { id: 'settings', labelKey: 'nav.settings', icon: 'settings', titleKey: 'set.title', subKey: 'set.sub' },
];

/**
 * Каталог площадок.
 *
 * id - это значение platform в обоих API (XProject: enum Platform,
 * VVS: сегмент пути /ads/{platform}). Придумывать сюда новые нельзя, площадки
 * берутся из документации - см. CONFIG клиентов в src/main/parser/apis/.
 *
 * countries - страны, доступные площадке, кодами нижнего регистра. У площадки
 * одной страны список из одного кода: выбирать там нечего, страна ставится
 * сама. Логотип подставляется файлом platforms/<id>.svg, если он положен;
 * пока файла нет, рисуется монограмма в цвете площадки.
 */
const PLATFORMS = [
  { id: 'depop', label: 'Depop', group: 'us', color: '#ff2300', countries: ['us'] },
  { id: 'poshmark', label: 'Poshmark', group: 'us', color: '#8b1a4f', countries: ['us'] },
  {
    id: 'vinted',
    label: 'Vinted',
    group: 'world',
    color: '#007782',
    countries: ['us', 'at', 'au', 'be', 'cz', 'de', 'dk', 'es', 'fr', 'gr',
      'it', 'lv', 'nl', 'pl', 'pt', 'ro', 'se', 'gb'],
  },
];

const PLATFORM_GROUPS = ['us', 'world'];

function platformById(id) {
  return PLATFORMS.find((p) => p.id === id) || PLATFORMS[1];
}

/**
 * Выбранная цель в разобранном виде. Страны фильтруем по площадке: список мог
 * остаться от прошлого выбора, когда площадка была другой, и показывать страну,
 * которой у неё нет, значило бы врать.
 */
function currentTarget() {
  const p = state.settings.parser || {};
  const platform = platformById(p.platform);
  const countries = (p.countries || []).filter((c) => platform.countries.includes(c));
  return { platform, countries };
}

const ACCENTS = {
  green: { c: '#3ddc84', c2: '#16b364', rgb: '61, 220, 132', on: '#04120a' },
  violet: { c: '#a78bfa', c2: '#7c4dff', rgb: '167, 139, 250', on: '#0d0620' },
  blue: { c: '#57a6ff', c2: '#2b6fe0', rgb: '87, 166, 255', on: '#04121f' },
  amber: { c: '#ffb443', c2: '#f08a00', rgb: '255, 180, 67', on: '#1c1100' },
  pink: { c: '#ff5fa2', c2: '#e02e7b', rgb: '255, 95, 162', on: '#1f0512' },
};

// Готовые сочетания плотности: подобрать три ползунка на глаз тяжело, а
// разница между "видно фото" и "читается текст" - именно в их сочетании.
const DENSITY_PRESETS = [
  { id: 'photo', glass: 0.44, scrim: 0.1, dim: 0.34 },
  { id: 'balanced', glass: 0.72, scrim: 0.3, dim: 0.5 },
  { id: 'solid', glass: 0.9, scrim: 0.55, dim: 0.62 },
];

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

// Ступени "терпения" при ожидании элементов Gmail: множитель бюджетов в
// chromeManager. Ступенями, а не полем ввода - значение влияет на все ожидания
// сразу, и промах в нём виден только по сорванному прогону.
const WAIT_SCALES = [1, 2, 3];

const LOG_LEVELS = ['all', 'info', 'success', 'warn', 'error'];
// Сколько строк держим в разметке. Буфер state.logs больше - он нужен фильтру
// и поиску, но рисовать всю историю разом незачем.
const LOG_DOM_MAX = 200;

// ── helpers ────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (html) => { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dash = '-'; // прочерк для пустых значений

/**
 * Текст с подсвеченным совпадением поискового запроса. Экранируем сначала, а
 * теги дописываем уже поверх экранированного: иначе адрес продавца с угловыми
 * скобками уехал бы в разметку. Ищем подстрокой, без RegExp - запрос вводит
 * человек, и звёздочка в нём не должна ронять поиск.
 */
function markMatch(text, q) {
  const s = String(text == null ? '' : text);
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return esc(s);
  const at = s.toLowerCase().indexOf(needle);
  if (at < 0) return esc(s);
  return esc(s.slice(0, at)) + '<mark>' + esc(s.slice(at, at + needle.length)) + '</mark>'
    + esc(s.slice(at + needle.length));
}
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
  input.addEventListener('input', debounce(async () => {
    const raw = input.value.trim();
    if (raw === '') return;
    const val = Math.max(min, Math.floor(Number(raw)) || min);
    await saveSection(section, { [key]: val });
    markSaved(input);
  }));
  input.addEventListener('blur', async () => {
    const val = Math.max(min, Math.floor(Number(input.value)) || min);
    input.value = String(val);
    await saveSection(section, { [key]: val });
    markSaved(input);
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
  // Пометки "раздел изменён" считаются от текущих значений, поэтому обновляем
  // их сразу после записи, а не только при переключении групп.
  if (state.route === 'settings') paintSettingsDots();
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

/**
 * Блик стекла, ползущий за курсором.
 *
 * Координаты пишем только пока курсор внутри элемента, и берём их из события,
 * а не из getBoundingClientRect на каждое движение: замер геометрии заставляет
 * браузер пересчитать раскладку, и на карточке со стеклом это давало рывки.
 * Размеры перечитываем на входе курсора - за время наведения они не меняются.
 */
function wireSheen(root) {
  $$('.glass-sheen', root).forEach((el) => {
    if (el.dataset.sheened) return;
    el.dataset.sheened = '1';
    let box = null;
    let frame = null;
    el.addEventListener('pointerenter', () => { box = el.getBoundingClientRect(); });
    el.addEventListener('pointerleave', () => {
      box = null;
      if (frame) { cancelAnimationFrame(frame); frame = null; }
    });
    el.addEventListener('pointermove', (e) => {
      if (!box || frame) return;
      const x = e.clientX, y = e.clientY;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!box) return;
        el.style.setProperty('--mx', ((x - box.left) / box.width * 100).toFixed(1) + '%');
        el.style.setProperty('--my', ((y - box.top) / box.height * 100).toFixed(1) + '%');
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

/**
 * Значение настройки оформления с запасным вариантом.
 *
 * Нужен, потому что поля добавляются со временем: пока нового поля нет в
 * сохранённом файле, в разметку уходило `value="undefined"`, браузер молча
 * приводил ползунок к минимуму, и первое же движение соседнего ползунка
 * записывало этот минимум в настройки. Так у фона обнулялись насыщенность и
 * затемнение разом.
 */
function apVal(key, fallback) {
  const v = appearance()[key];
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
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

  css.setProperty('--bg-dim', String(apVal('dim', 0.5)));
  css.setProperty('--bg-blur', apVal('blur', 0) + 'px');
  css.setProperty('--bg-saturate', String(apVal('saturate', 1)));
  css.setProperty('--glass-alpha', String(apVal('glassAlpha', 0.72)));
  css.setProperty('--scrim-alpha', String(apVal('scrimAlpha', 0.3)));
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
  root.classList.toggle('refract', !!ap.refract);
  if (ap.parallax === false || ap.reduceMotion) {
    const layer = $('#bgLayer');
    if (layer) layer.style.transform = 'scale(1.03)';
  }
}

/**
 * Параллакс фона. Слой едет за курсором на несколько пикселей - этого хватает,
 * чтобы картинка перестала быть плоской заливкой, и мало, чтобы отвлекать.
 *
 * Трансформацию пишем ПРЯМО в стиль слоя, а не через переменную на :root.
 * Замер показал разницу в полсотни раз: правка переменной в корне заставляет
 * браузер пересчитать стили всего документа (около 16 мс - больше бюджета
 * кадра), тогда как прямой transform одному элементу стоит доли миллисекунды.
 *
 * Считаем в requestAnimationFrame: mousemove сыплется чаще, чем кадры.
 */
function wireParallax() {
  const layer = $('#bgLayer');
  if (!layer) return;
  let frame = null;
  document.addEventListener('mousemove', (e) => {
    const ap = appearance();
    if (ap.parallax === false || ap.reduceMotion) return;
    if (frame) return;
    // Координаты снимаем сразу: к моменту кадра событие уже "протухнет".
    const x = e.clientX, y = e.clientY;
    frame = requestAnimationFrame(() => {
      frame = null;
      const dx = (x / window.innerWidth - 0.5) * -26;
      const dy = (y / window.innerHeight - 0.5) * -18;
      layer.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(1.03)`;
    });
  });
}

/** Подсмотреть фон: панели уходят в прозрачность, пока держат Alt. */
function setPeek(on) {
  document.documentElement.classList.toggle('peek', on);
  const btn = $('#btnPeek');
  if (btn) btn.classList.toggle('on', on);
}

function wirePeek() {
  const btn = $('#btnPeek');
  btn.innerHTML = ICONS.eye;
  btn.title = t('appear.peek');
  btn.addEventListener('click', () => setPeek(!document.documentElement.classList.contains('peek')));
  // Alt удобнее кнопки: посмотрел и отпустил, не теряя место в интерфейсе.
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') { e.preventDefault(); setPeek(true); } });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') setPeek(false); });
  window.addEventListener('blur', () => setPeek(false));
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

  // Панель превью письма живёт при редакторе в настройках: уходя с экрана,
  // убираем её вместе с ним.
  dropArPreview();

  const main = $('#main');
  main.innerHTML = '';
  // Чаты занимают всю рабочую область и прокручиваются внутри колонок, а не
  // страницей: иначе шапка переписки уплывала бы за край при листании ленты.
  main.classList.toggle('no-scroll', !!route.fullHeight);
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
  wireCascade(main);
  paintRun();
}

/**
 * Каскад появления: нумеруем детей, CSS считает задержку от --i.
 *
 * Класс снимаем, как только каскад отыграл. Списки перерисовываются по таймеру
 * раз в несколько секунд, и без этого карточки мигали бы въездом заново на
 * каждом обновлении данных.
 */
function wireCascade(root) {
  $$('.cascade', root).forEach((box) => {
    const kids = [...box.children];
    kids.forEach((el, i) => el.style.setProperty('--i', String(i)));
    const total = kids.length * 55 + 460;
    setTimeout(() => box.classList.remove('cascade'), total);
  });
}

// ── Главная: витрина ───────────────────────────────────────────────
// Стартовый экран, с которого расходятся все разделы. Держим его крупным и
// нерабочим: одно главное действие, живые числа и понятные входы дальше.

/** Плитки-входы. Число берётся живьём, чтобы витрина не была декорацией. */
const HOME_TILES = [
  { route: 'run', icon: 'play', titleKey: 'nav.run', descKey: 'home.tile.run', value: (s) => fmtUptime(s.runStatus.uptimeSec) },
  { route: 'profiles', icon: 'profiles', titleKey: 'nav.profiles', descKey: 'home.tile.profiles', value: (s) => s.profiles.length },
  { route: 'chats', icon: 'chat', titleKey: 'nav.chats', descKey: 'home.tile.chats', value: (s) => (s.chats || []).length },
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
    { key: 'parser', done: !!(s.parser.apiKey && currentTarget().countries.length), go: () => goSettings('parser') },
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

    <section class="home-tiles cascade" id="homeTiles"></section>

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

  // Кнопки не пересобираем: витрина перерисовывается раз в секунду по тику
  // статуса, а замена узлов рвёт наведение, фокус и волну от клика.
  const cta = $('#homeCta');
  if (!cta.children.length) {
    const primary = h(`<button class="btn big" data-role="primary"></button>`);
    primary.addEventListener('click', () => runAction(primary.dataset.action));
    const secondary = h(`<button class="btn ghost big">${ICONS.chevron}
      <span>${esc(t('home.ctaOpen'))}</span></button>`);
    secondary.addEventListener('click', () => go('run'));
    cta.append(primary, secondary);
    wireRipples(cta);
  }
  const primary = cta.firstElementChild;
  const start = mode === 'idle';
  const wantHtml = (start ? ICONS.play : ICONS.stop) + `<span>${esc(t(start ? 'home.ctaStart' : 'dash.stop'))}</span>`;
  if (primary.dataset.mode !== mode) {
    primary.dataset.mode = mode;
    primary.dataset.action = start ? 'start' : 'stop';
    primary.className = 'btn big ' + (start ? 'primary' : 'stop');
    primary.innerHTML = wantHtml;
  }
  primary.disabled = state.runBusy;

  const today = todayRow();
  setFacts($('#homeFacts'), [
    [t('home.factSent'), sumMetric(state, 'written')],
    [t('home.factToday'), today.sent],
    [t('home.factReplies'), sumMetric(state, 'replies')],
    [t('dash.ready'), state.profiles.filter((p) => p.gmailStatus === 'ready').length],
  ]);

  paintHomeQuick();
  paintHomeTiles();
  paintHomeReady();
}

/**
 * Полоса чисел: разметку строим один раз, дальше меняем только сами значения.
 * Раньше здесь был innerHTML на каждом тике - выбрасывать и создавать узлы
 * секунду за секундой ради четырёх цифр незачем.
 */
function setFacts(box, rows) {
  if (!box) return;
  if (box.children.length !== rows.length) {
    box.innerHTML = rows.map(([cap]) => `<span class="fact"><b></b><span>${esc(cap)}</span></span>`).join('');
  }
  rows.forEach(([, val], i) => {
    const b = box.children[i].firstElementChild;
    const next = String(val);
    if (b.textContent !== next) b.textContent = next;
  });
}

/** Быстрые действия витрины: то, что делают руками и часто. */
function paintHomeQuick() {
  const box = $('#homeQuick');
  // Список действий не зависит от данных - собираем его один раз.
  if (!box || box.children.length) return;
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
  // Плитки строим один раз, потом обновляем только число: пересборка узлов по
  // таймеру заново запускала бы каскад появления и рвала наведение.
  if (!box.children.length) {
    box.innerHTML = HOME_TILES.map((tile) => `<button class="home-tile glass glass-sheen" data-route="${tile.route}">
      <span class="ht-icon">${ICONS[tile.icon]}</span>
      <span class="ht-val"></span>
      <span class="ht-title">${esc(t(tile.titleKey))}</span>
      <span class="ht-desc">${esc(t(tile.descKey))}</span>
      <span class="ht-go">${ICONS.chevron}</span>
    </button>`).join('');
    $$('.home-tile', box).forEach((el) => el.addEventListener('click', () => go(el.dataset.route)));
    wireSheen(box);
    wireCascade(box.parentElement || document);
  }
  HOME_TILES.forEach((tile, i) => {
    const el = box.children[i] && box.children[i].querySelector('.ht-val');
    const next = String(tile.value(state));
    if (el && el.textContent !== next) el.textContent = next;
  });
}

function paintHomeReady() {
  const box = $('#homeReady');
  if (!box) return;
  const steps = readySteps();
  const done = steps.filter((s) => s.done).length;
  const all = done === steps.length;

  // Чек-лист меняется редко - перерисовываем, только когда набор галочек стал
  // другим. Иначе он пересобирался бы каждую секунду вместе со статусом.
  const sign = steps.map((s) => (s.done ? '1' : '0')).join('');
  if (box.dataset.sign === sign) return;
  box.dataset.sign = sign;

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
    setOnce(plate, sentToday
      ? `<span class="note-plate ok">${ICONS.send}${esc(t('ov.today', { n: sentToday }))}</span>`
      : '');
  }

  paintChart();
  paintTopProfiles();
  paintEvents();
}

/**
 * Заменить разметку, только если она отличается.
 *
 * Экраны обновляются по таймеру раз в секунду, и большинство блоков при этом
 * не меняется. Сравнение строки дешевле, чем снос и постройка поддерева, а
 * заодно не рвёт наведение мышью и не перезапускает анимации.
 */
function setOnce(el, html) {
  if (!el || el.dataset.html === html) return false;
  el.dataset.html = html;
  el.innerHTML = html;
  return true;
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
  if (!daily.length || !peak) { setOnce(box, `<div class="empty">${ICONS.dashboard}<div>${esc(t('ov.noData'))}</div></div>`); return; }

  const max = Math.max(1, peak);
  const html = daily.map((d) => {
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
  setOnce(box, html);
}

function paintTopProfiles() {
  const box = $('#oTop');
  if (!box) return;
  const m = state.profileMetrics || {};
  const rows = state.profiles
    .map((p) => ({ p, w: (m[p.id] || {}).written || 0, r: (m[p.id] || {}).replies || 0 }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 6);
  if (!rows.length || !rows[0].w) { setOnce(box, `<div class="empty">${esc(t('ov.noProfiles'))}</div>`); return; }
  const max = Math.max(1, ...rows.map((x) => x.w));
  setOnce(box, rows.map((x) => `<div class="acc-row">
    <span class="nm">${esc(x.p.label)}</span>
    <span class="track"><span style="width:${(x.w / max * 100).toFixed(1)}%"></span></span>
    <span class="cnt">${x.w} / ${x.r}</span>
  </div>`).join(''));
}

/** Лента важных событий - из того же потока логов, что и живые логи. */
function paintEvents() {
  const box = $('#oEvents');
  if (!box) return;
  const rows = state.logs.filter((e) => e.level === 'error' || e.level === 'warn' || e.level === 'success').slice(-8).reverse();
  if (!rows.length) { setOnce(box, `<div class="empty">${esc(t('ov.noEvents'))}</div>`); return; }
  setOnce(box, rows.map((e) => `<div class="event ${e.level}">
    <span class="dot"></span>
    <span class="msg">${esc(e.message)}</span>
    <span class="ts">${esc(new Date(e.ts).toLocaleTimeString())}</span>
  </div>`).join(''));
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
        <div class="ready-list" id="dReady"></div>
      </div>
      <div class="control-side">
        <div class="gauge">
          <svg viewBox="0 0 120 120">
            <circle class="bg" cx="60" cy="60" r="52"/>
            <circle class="fg" id="gaugeArc" cx="60" cy="60" r="52"
              stroke-dasharray="326.7" stroke-dashoffset="326.7"/>
          </svg>
          <div class="mid"><b id="gaugePct">0%</b><span id="gaugeSub">0 / 0</span></div>
        </div>
        <div class="pace">
          <div class="pace-row">
            <span class="k">${esc(t('dash.pace'))}</span>
            <b id="paceRate">${dash}</b>
          </div>
          <div class="pace-row">
            <span class="k">${esc(t('dash.eta'))}</span>
            <b id="paceEta">${dash}</b>
          </div>
        </div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-bottom:14px">
      <div class="card glass">
        <h3 style="font-size:15px">${ICONS.profiles} ${esc(t('dash.accounts'))}</h3>
        <div id="dAccounts"></div>
      </div>
      <div class="card glass">
        <h3 style="font-size:15px">${ICONS.target} ${esc(t('dash.target'))}</h3>
        <div class="hint" style="margin-top:-8px;margin-bottom:14px">${esc(t('dash.targetSub'))}</div>
        <div class="tg-current" id="dTarget"></div>
      </div>
    </div>

    <div class="card glass sess-card">
      <div class="sess-head">
        <h3 style="margin:0">${esc(t('dash.session'))}</h3>
        <span class="hint" id="sessHint"></span>
      </div>
      <div class="sess-wrap">
        <svg class="sess-chart" id="sessChart" viewBox="0 0 100 46" preserveAspectRatio="none">
          <path class="area"/><path vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="sess-empty" id="sessEmpty">${esc(t('dash.sessEmpty'))}</div>
      </div>
      <div class="hint sess-sub">${esc(t('dash.sessSub'))}</div>
    </div>

    <div class="card glass">
      <div class="logs-head">
        <h3 style="margin:0">${esc(t('dash.logs'))}</h3>
        <div class="seg filters" id="logLevels">
          ${LOG_LEVELS.map((lv) => `<button data-v="${lv}" class="${state.logFilter.level === lv ? 'active' : ''}">${esc(lv === 'all' ? t('logs.all') : lv)}</button>`).join('')}
        </div>
        <div class="grow"><input type="text" id="logSearch" placeholder="${esc(t('logs.searchPh'))}" value="${esc(state.logFilter.query)}"/></div>
        <button class="btn ghost" id="logPause"></button>
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
  // Пауза потока - не то же самое, что "Следить за концом": там автопрокрутка,
  // здесь список вообще перестаёт меняться. На бегущем прогоне строку, за
  // которую зацепился глаз, иначе не прочитать.
  wrap.querySelector('#logPause').addEventListener('click', async () => {
    const on = !(state.settings.ui || {}).logsPaused;
    await saveSection('ui', { logsPaused: on });
    if (!on) { logsHeld = 0; renderLogs(); }
    paintLogPause();
  });
  wrap.querySelector('#logClear').addEventListener('click', () => {
    state.logs = [];
    logsHeld = 0;
    renderLogs();
    toast(t('logs.cleared'));
  });
  const box = wrap.querySelector('#logs');
  // Копирование строки - делегированием: строк в списке до пяти сотен, вешать
  // на каждую свой слушатель незачем.
  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('.log-copy');
    if (!btn) return;
    const line = btn.closest('.log-line');
    try {
      await navigator.clipboard.writeText(line.dataset.raw || '');
      toast(t('logs.copied'), 'success');
    } catch (err) { toast(t('logs.copyFailed'), 'error'); }
  });
  // Пользователь отскроллил вверх - перестаём тащить его вниз каждой записью.
  box.addEventListener('scroll', () => {
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 26;
    if (atEnd !== state.logFollow) { state.logFollow = atEnd; paintLogFollow(); }
  });

  setTimeout(() => { renderLogs(); paintRun(); }, 0);
  return wrap;
};

/** Одна точка входа для старт/стоп/пауза - и одна защита от двойного клика. */
async function runAction(kind) {
  if (state.runBusy || !kind) return;
  state.runBusy = true;
  paintRunControls();
  try {
    if (kind === 'start') {
      const res = await api.run.start();
      if (res && res.ok) {
        toast(t('dash.started'), 'success');
        // Почты без вкладки в рассылке не участвуют. Говорим об этом сразу, а не
        // оставляем человека ждать писем с аккаунта, до которого не доберёмся.
        const skipped = (res.withoutTab || []).map((m) => m.email || m.profileLabel);
        if (skipped.length) {
          setTimeout(() => toast(t('dash.startedNoTab', { list: skipped.join(', ') }), 'error'), 2800);
        }
      } else {
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
  // Пока прогон идёт, по полосам прогресса бежит блик - видно, что не замерло.
  document.documentElement.classList.toggle('running', mode === 'running');

  const note = $('#runNote');
  if (note) {
    note.textContent = mode === 'running' ? t('dash.noteRunning')
      : mode === 'paused' ? t('dash.notePaused') : t('dash.noteIdle');
  }

  // Готовыми считаем ПОЧТЫ с открытой вкладкой: именно они и есть аккаунты, с
  // которых уходят письма.
  const slots = mailboxSlots();
  const ready = slots.filter((s) => s.hasTab).length;
  const noTab = slots.filter((s) => !s.hasTab).length;
  const sent = slots.reduce((n, s) => n + s.sentCount, 0);
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
    // Почта, в которую вошли, но вкладку не открыли, в рассылке не участвует.
    // Молчать об этом нельзя: человек ждёт писем и с неё.
    else if (noTab) plate.innerHTML = notePlate('warn', t('dash.plateNoTab', { n: noTab }));
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

  paintPace(plan);
  paintReadyList(ready, noTab);
  // В центре управления цель только показывается: менять её можно в настройках,
  // чтобы одна настройка не жила в двух местах.
  paintTargetSummary($('#dTarget'));
  paintAccountRows(plan);
  paintRunControls();
  paintQuickRun();
  paintSpark();
  if (state.route === 'home') paintHome();
}

/**
 * Темп и прогноз рядом с кольцом.
 *
 * Считаем по сессионному счётчику из движка: sentCount профиля накопительный и
 * переживает перезапуски, темп по нему получился бы бессмысленным. Пока прогон
 * идёт меньше минуты или ушло меньше двух писем, показываем прочерк - на таких
 * данных любое число будет выдумкой.
 */
function paintPace(plan) {
  const rateEl = $('#paceRate');
  const etaEl = $('#paceEta');
  if (!rateEl || !etaEl) return;
  const r = state.runStatus;
  const sent = r.sentThisSession || 0;
  const perHour = (r.uptimeSec >= 60 && sent >= 2) ? (sent / r.uptimeSec) * 3600 : 0;
  rateEl.textContent = perHour ? t('dash.perHour', { n: Math.round(perHour) }) : dash;

  const left = Math.max(0, plan.total - plan.done);
  etaEl.textContent = perHour && left
    ? fmtUptime(Math.round(left / (perHour / 3600)))
    : dash;
}

/**
 * Чеклист готовности.
 *
 * Раньше о причине, по которой прогон не поедет, говорила одна плашка - и
 * только о самой первой. Причин обычно несколько, и до каждой надо было
 * догадаться самому. Здесь они все и с переходом туда, где закрываются.
 */
function paintReadyList(ready, noTab) {
  const box = $('#dReady');
  if (!box) return;
  const s = state.settings;
  const rows = [
    { ok: ready > 0, key: 'dash.chk.ready', go: () => go('profiles') },
    { ok: !noTab, key: 'dash.chk.tabs', go: () => go('profiles') },
    { ok: !!s.texts, key: 'dash.chk.texts', go: () => goSettings('texts') },
    { ok: !!currentTarget().countries.length, key: 'dash.chk.targets', go: () => goSettings('targets') },
    { ok: !!s.parser.apiKey, key: 'dash.chk.parser', go: () => goSettings('parser') },
    { ok: !!s.link.apiKey, key: 'dash.chk.link', go: () => goSettings('link') },
  ];
  // Подпись меняется реже, чем идёт опрос: пересобираем, только если что-то
  // из шести пунктов перещёлкнулось.
  const sign = rows.map((x) => (x.ok ? 1 : 0)).join('');
  if (box.dataset.sign === sign) return;
  box.dataset.sign = sign;

  box.innerHTML = rows.map((x, i) => `<div class="chk ${x.ok ? 'ok' : 'bad'}" data-i="${i}">
    <span class="chk-mark">${x.ok ? ICONS.check : ICONS.alert}</span>
    <span class="chk-text">${esc(t(x.key))}</span>
    ${x.ok ? '' : `<span class="chk-go">${esc(t('dash.chkGo'))}${ICONS.chevron}</span>`}
  </div>`).join('');

  $$('.chk', box).forEach((el) => el.addEventListener('click', () => {
    const row = rows[Number(el.dataset.i)];
    if (row && !row.ok) row.go();
  }));
}

function notePlate(kind, text) {
  return `<span class="note-plate ${kind === 'warn' ? 'warn' : ''}">${ICONS.alert}${esc(text)}</span>`;
}

/**
 * Мини-строки ПОЧТ с прогрессом по лимиту. Лимит считается по каждой почте
 * отдельно, поэтому строка на профиль показывала бы неправду: в профиле их
 * может быть несколько.
 */
function paintAccountRows(plan) {
  const box = $('#dAccounts');
  if (!box) return;
  const limit = state.settings.system.mailsPerAccount || 0;
  const slots = mailboxSlots();
  if (!slots.length) {
    setOnce(box, `<div class="empty" style="padding:24px 0">${esc(t('dash.noAccounts'))}</div>`);
    return;
  }
  setOnce(box, slots.map((s) => {
    const done = limit > 0 ? clamp(s.sentCount / limit, 0, 1) : 0;
    const live = plan.current && plan.current.key === s.key && state.runStatus.running;
    const tags = [];
    if (live) tags.push(['live', t('prof.writingNow')]);
    if (!s.hasTab) tags.push(['warn', t('prof.noTab')]);
    return `<div class="acc-row ${s.hasTab ? '' : 'off'}">
      <span class="nm">${esc(s.email || s.profileLabel)}
        ${tags.map(([cls, text]) => `<span class="pc-tag ${cls}">${esc(text)}</span>`).join('')}
        <span class="acc-prof">${esc(s.profileLabel)}</span></span>
      <span class="track"><span style="width:${(done * 100).toFixed(1)}%"></span></span>
      <span class="cnt">${s.sentCount} / ${limit}</span>
    </div>`;
  }).join(''));
}

/**
 * Плоский список почт всех профилей - та же единица работы, что и в движке
 * (см. _mailboxes в senderEngine). Профиль без найденных почт показываем одной
 * строкой: иначе запущенный профиль, где ещё не открыли вкладку, исчезал бы с
 * экрана совсем.
 */
function mailboxSlots() {
  const out = [];
  for (const p of state.profiles) {
    const boxes = p.mailboxes || [];
    if (!boxes.length) {
      if (p.gmailStatus !== 'ready' && !p.running) continue;
      out.push({
        key: p.id + '#', profileId: p.id, profileLabel: p.label,
        email: '', hasTab: false, sentCount: 0,
      });
      continue;
    }
    for (const m of boxes) {
      out.push({
        key: p.id + '#' + (m.email || ''),
        profileId: p.id,
        profileLabel: p.label,
        email: m.email || '',
        hasTab: !!m.hasTab,
        sentCount: m.sentCount || 0,
      });
    }
  }
  return out;
}

/**
 * План сессии по ПОЧТАМ: сколько писем всего заложено лимитом, сколько уже ушло
 * и с какой почты пишем сейчас. Лимит применяется к каждой почте отдельно, а
 * движок обходит их по кругу (см. _nextMailbox в senderEngine) - "текущей"
 * считаем первую, не добравшую лимит.
 */
function sessionPlan() {
  const limit = state.settings.system.mailsPerAccount || 0;
  const slots = mailboxSlots().filter((s) => s.hasTab);
  const done = slots.reduce((n, s) => n + Math.min(s.sentCount, limit), 0);
  return {
    total: slots.length * limit,
    done,
    current: slots.find((s) => s.sentCount < limit) || null,
  };
}

function setTone(el, tone) {
  if (el) el.dataset.tone = tone;
}

/**
 * Пути спарклайна по ряду значений. Один код на искру в полосе статов, на
 * карточку профиля и на график сессии - иначе три одинаковых графика рисовались
 * бы тремя разными формулами и выглядели по-разному.
 *
 * Пока истории нет, получается ровная линия по низу: пустой спарклайн оставлял
 * в плитке дыру, и подпись съезжала ниже, чем у соседних плиток.
 */
function sparkPath(values, w, hh) {
  const vals = values && values.length >= 2 ? values : [0, 0];
  const max = Math.max(1, ...vals);
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => [i * step, hh - (v / max) * (hh - 4) - 2]);
  const line = 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
  return { line, area: line + ` L${w},${hh} L0,${hh} Z` };
}

function paintSpark() {
  const svg = $('#dSpark');
  if (svg) {
    const [area, line] = svg.children;
    const d = sparkPath(state.sendSeries, 100, 22);
    line.setAttribute('d', d.line);
    area.setAttribute('d', d.area);
  }
  paintSessionChart();
}

/**
 * График прогона над логами. Тот же ряд, что и у искры в полосе статов, но
 * крупно: по последней строке лога виден только текущий момент, а по графику -
 * ритм. Провал в нём означает, что аккаунты встали, и это заметно раньше, чем
 * об этом скажет счётчик.
 */
function paintSessionChart() {
  const svg = $('#sessChart');
  if (!svg) return;
  // Ровная линия по низу на пустом ряду читалась как сломанный график, поэтому
  // до первых замеров вместо него стоит подпись.
  const has = state.sendSeries.length >= 2;
  svg.hidden = !has;
  const empty = $('#sessEmpty');
  if (empty) empty.hidden = has;
  const hint = $('#sessHint');
  if (hint) {
    const n = state.sendSeries.reduce((a, b) => a + b, 0);
    hint.textContent = has ? t('dash.sessTotal', { n }) : '';
  }
  if (!has) return;
  const [area, line] = svg.children;
  const d = sparkPath(state.sendSeries, 100, 46);
  line.setAttribute('d', d.line);
  area.setAttribute('d', d.area);
}

function fmtUptime(sec) {
  if (!sec) return '0s';
  const hrs = Math.floor(sec / 3600), min = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (hrs ? hrs + 'h ' : '') + (min ? min + 'm ' : '') + s + 's';
}

/** "5 мин назад". Точное время здесь не нужно - важен порядок величины. */
function fmtAgo(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return t('time.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minAgo', { n: min });
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return t('time.hrAgo', { n: hrs });
  return t('time.dayAgo', { n: Math.floor(hrs / 24) });
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

function logLineEl(entry, fresh) {
  const time = new Date(entry.ts).toLocaleTimeString();
  // Исходный текст держим в data-raw: из разметки его пришлось бы собирать
  // обратно, а подсветка поиска добавляет в неё лишние теги.
  const raw = time + ' [' + entry.scope + '] ' + entry.message;
  return h(`<div class="log-line ${entry.level}${fresh ? ' fresh' : ''}" data-raw="${esc(raw)}"><span class="t">${esc(time)}</span><span class="s">[${esc(entry.scope)}]</span><span class="m">${highlight(entry.message, state.logFilter.query)}</span><button class="log-copy" title="${esc(t('logs.copy'))}">${ICONS.copy}</button></div>`);
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
    // Показываем хвост: старые записи в списке всё равно не читают, а каждая
    // лишняя строка - это работа при каждой прокрутке.
    shown.slice(-LOG_DOM_MAX).forEach((e) => frag.appendChild(logLineEl(e, false)));
    box.appendChild(frag);
  }
  paintLogCount(shown.length);
  paintLogLevels();
  paintLogFollow();
  paintLogPause();
  if (state.logFollow) scrollLogsToEnd();
}

function paintLogCount(shown) {
  const el = $('#logCount');
  if (el) el.textContent = t('logs.shown', { shown, total: state.logs.length });
}

/**
 * Счётчики по уровням прямо на кнопках фильтра. Без них узнать, есть ли в
 * журнале ошибки, можно было только переключившись на "error" и обратно.
 */
function paintLogLevels() {
  const box = $('#logLevels');
  if (!box) return;
  for (const btn of $$('button', box)) {
    const lv = btn.dataset.v;
    const n = lv === 'all' ? state.logs.length : state.logs.filter((e) => e.level === lv).length;
    let c = btn.querySelector('.count');
    if (!c) { c = h('<span class="count"></span>'); btn.appendChild(c); }
    c.textContent = String(n);
  }
}

// Сколько записей пришло, пока поток на паузе.
let logsHeld = 0;

function paintLogPause() {
  const btn = $('#logPause');
  if (!btn) return;
  const on = !!(state.settings.ui || {}).logsPaused;
  const label = on ? (logsHeld ? t('logs.resumeN', { n: logsHeld }) : t('logs.resume')) : t('logs.pause');
  btn.innerHTML = (on ? ICONS.play : ICONS.pause) + '<span>' + esc(label) + '</span>';
  btn.style.color = on ? 'var(--amber)' : '';
}

function paintLogFollow() {
  const btn = $('#logFollow');
  if (!btn) return;
  btn.innerHTML = ICONS.chevron + '<span>' + esc(state.logFollow ? t('logs.follow') : t('logs.paused')) + '</span>';
  btn.style.color = state.logFollow ? 'var(--accent)' : '';
  btn.querySelector('svg').style.transform = 'rotate(90deg)';
}

let logScrollFrame = null;
function scrollLogsToEnd() {
  if (logScrollFrame) return;
  logScrollFrame = requestAnimationFrame(() => {
    logScrollFrame = null;
    const box = $('#logs');
    if (box) box.scrollTop = box.scrollHeight;
  });
}

function appendLog(entry) {
  state.logs.push(entry);
  while (state.logs.length > 500) state.logs.shift();
  const box = $('#logs');
  if (!box) return;
  // Поток на паузе: в журнал запись идёт, но список не трогаем. Иначе строку,
  // за которую зацепился глаз, на бегущем прогоне не прочитать.
  if ((state.settings.ui || {}).logsPaused) { logsHeld++; paintLogPause(); return; }
  paintLogLevels();
  if (!logPasses(entry)) { paintLogCount(box.children.length); return; }
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  box.appendChild(logLineEl(entry, true));
  while (box.children.length > LOG_DOM_MAX) box.removeChild(box.firstChild);
  paintLogCount(box.children.length);
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


// ── Чаты ───────────────────────────────────────────────────────────
// Четыре колонки: слева список профилей, рядом переписки выбранного, посередине
// лента писем, справа карточка объявления. Всё показанное - настоящие данные:
// исходящие письма приложение пишет само, ответ продавца приходит из скана
// почты, карточка собрана из сохранённого контакта парсера.

/** Открытый чат и загруженная лента живут в state - перерисовка их не теряет. */
function chatById(key) {
  return (state.chats || []).find((c) => c.chatKey === key) || null;
}

VIEWS.chats = () => {
  const wrap = h(`<div class="chats">
    <aside class="chat-rail glass" id="chatRail"></aside>

    <aside class="chat-list glass">
      <div class="cl-head">
        <div class="seg filters" id="chatFilters">
          <button data-v="all" class="${state.chatFilter === 'all' ? 'active' : ''}">${esc(t('chat.f.all'))}<span class="count" id="cntAll">0</span></button>
          <button data-v="answered" class="${state.chatFilter === 'answered' ? 'active' : ''}">${esc(t('chat.f.answered'))}<span class="count" id="cntAns">0</span></button>
        </div>
        <button class="mini" id="chatRefresh" title="${esc(t('chat.refresh'))}">${ICONS.reset}</button>
      </div>
      <div class="cl-search">
        ${ICONS.search}
        <input type="text" id="chatSearch" placeholder="${esc(t('chat.search'))}" value="${esc(state.chatQuery)}"/>
      </div>
      <div class="cl-body" id="chatGroups"></div>
    </aside>

    <section class="chat-main glass" id="chatMain"></section>

    <aside class="chat-side glass" id="chatSide"></aside>
  </div>`);

  $$('#chatFilters button', wrap).forEach((b) => b.addEventListener('click', () => {
    state.chatFilter = b.dataset.v;
    $$('#chatFilters button', wrap).forEach((x) => x.classList.toggle('active', x === b));
    renderChatGroups();
  }));
  wrap.querySelector('#chatSearch').addEventListener('input', debounce((e) => {
    state.chatQuery = e.target.value;
    renderChatGroups();
  }, 200));
  wrap.querySelector('#chatRefresh').addEventListener('click', () => refreshChats(true));

  setTimeout(() => {
    renderChatRail();
    renderChatGroups();
    renderChatMain();
  }, 0);
  return wrap;
};

/**
 * Почты, у которых есть хоть одна переписка, плюс их счётчики.
 *
 * Группируем по почте, а не по профилю: в профиле их несколько, и переписки
 * разных ящиков в одном списке путались бы - непонятно, из какого адреса шёл
 * разговор.
 */
function chatProfiles() {
  const byId = new Map();
  for (const c of (state.chats || [])) {
    const id = c.accountKey || c.profileId;
    const row = byId.get(id) || {
      id,
      label: c.mailbox || c.profileEmail || c.profileLabel || t('chat.unknownProfile'),
      sub: c.profileLabel || '',
      email: c.mailbox || c.profileEmail || '',
      running: c.profileRunning,
      status: c.profileStatus || 'unknown',
      chats: 0,
      waiting: 0,
    };
    row.chats++;
    // Последним писал продавец - переписка ждёт нас. Это и есть повод открыть
    // именно эту почту, поэтому число выносим в список.
    if (c.lastDir === 'in') row.waiting++;
    byId.set(id, row);
  }
  // Запущенные выше: с ними идёт работа прямо сейчас.
  return [...byId.values()].sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0));
}

/** Сколько переписок ждут ответа во всех профилях сразу. */
function chatsWaiting() {
  return (state.chats || []).filter((c) => c.lastDir === 'in').length;
}

/**
 * Колонка выбора профиля. Раньше профили были заголовками групп в одном длинном
 * списке - при нескольких аккаунтах приходилось прокручивать чужие переписки,
 * чтобы добраться до нужных. Список держим на виду, а не прячем в выпадающее
 * меню: оно закрывало бы сами переписки и стоило лишнего клика на каждый
 * переход между аккаунтами.
 */
function renderChatRail() {
  const box = $('#chatRail');
  if (!box) return;
  const profiles = chatProfiles();
  const total = (state.chats || []).length;
  const waiting = chatsWaiting();

  setOnce(box, `
    <div class="cr-head">
      <span class="section-label">${esc(t('chat.profiles'))}</span>
      <span class="cr-count">${profiles.length}</span>
    </div>
    <div class="cr-body">
      <button class="cr-item ${!state.chatProfile ? 'on' : ''}" data-p=""
        title="${esc(t('chat.allProfiles'))}">
        <span class="cr-all">${ICONS.profiles}</span>
        <span class="cr-id">
          <span class="cr-name">${esc(t('chat.allProfiles'))}</span>
          ${waiting ? `<span class="cr-wait">${esc(t('chat.waiting', { n: waiting }))}</span>` : ''}
        </span>
        <span class="cr-n">${total}</span>
      </button>
      ${profiles.map((p) => `<button class="cr-item ${p.id === state.chatProfile ? 'on' : ''} ${p.running ? 'live' : ''}"
        data-p="${esc(p.id)}"
        title="${esc(p.label + ' · ' + (p.sub || t('status.' + p.status)) + ' · ' + (p.running ? t('chat.online') : t('chat.offline')))}">
        <span class="pc-avatar" style="--av:${avatarColor({ email: p.email || p.label })}">${esc(p.label.charAt(0).toUpperCase())}
          <span class="mark ${esc(p.status)}"></span></span>
        <span class="cr-id">
          <span class="cr-name">${esc(p.label)}</span>
          <span class="cr-sub">${esc(p.sub ? p.sub + ' · ' : '')}${esc(p.running ? t('chat.online') : t('chat.offline'))}</span>
          ${p.waiting ? `<span class="cr-wait">${esc(t('chat.waiting', { n: p.waiting }))}</span>` : ''}
        </span>
        <span class="cr-n">${p.chats}</span>
      </button>`).join('')}
    </div>`);

  $$('.cr-item', box).forEach((el) => el.addEventListener('click', () => pickChatProfile(el.dataset.p)));
}

/** Переключение профиля: список переписок и середина пересобираются. */
function pickChatProfile(id) {
  if (state.chatProfile === id) return;
  state.chatProfile = id;
  // Открытая переписка чужого профиля при смене выбора закрывается: держать
  // её открытой, когда её нет в списке, - врать пользователю о том, где он.
  if (state.openChat && !chatMatches(chatById(state.openChat))) {
    state.openChat = '';
    state.chatMessages = [];
  }
  // Подсветку выбранного ставим классом, а не пересборкой списка профилей.
  $$('.cr-item').forEach((el) => el.classList.toggle('on', el.dataset.p === id));
  renderChatGroups();
  renderChatMain();
}

function chatMatches(c) {
  if (!c) return false;
  // Выбор в колонке - это почта (accountKey), а у старых записей его нет: там
  // сравниваем по профилю.
  if (state.chatProfile && (c.accountKey || c.profileId) !== state.chatProfile) return false;
  if (state.chatFilter === 'answered' && !c.replies) return false;
  const q = state.chatQuery.trim().toLowerCase();
  if (!q) return true;
  const title = (c.contact && c.contact.title) || '';
  return c.email.toLowerCase().includes(q)
    || title.toLowerCase().includes(q)
    || (c.mailbox || '').toLowerCase().includes(q)
    || (c.profileLabel || '').toLowerCase().includes(q);
}

/** Список переписок выбранного профиля. */
function renderChatGroups() {
  const box = $('#chatGroups');
  if (!box) return;
  const all = state.chats || [];
  const scope = state.chatProfile
    ? all.filter((c) => (c.accountKey || c.profileId) === state.chatProfile)
    : all;
  const rows = all.filter(chatMatches);

  // Счётчики фильтров считаем в рамках выбранного профиля: иначе "Все 14" при
  // одном видимом чате выглядит как поломка.
  const cAll = $('#cntAll'); if (cAll) cAll.textContent = scope.length;
  const cAns = $('#cntAns'); if (cAns) cAns.textContent = scope.filter((c) => c.replies > 0).length;

  if (!rows.length) {
    setOnce(box, `<div class="empty" style="padding:36px 16px">${ICONS.chat}
      <div>${esc(all.length ? t('chat.emptyFiltered') : t('chat.empty'))}</div></div>`);
    return;
  }

  // Внутри выбранного профиля группировать незачем, но в режиме "Все профили"
  // подпись нужна: иначе непонятно, чей это адрес.
  const showProfile = !state.chatProfile;
  setOnce(box, rows.map((c) => chatRowHtml(c, showProfile)).join(''));
  if (!box.dataset.wired) {
    // Клики ловим на контейнере: строк много, и они пересобираются на каждый
    // ввод в поиске - вешать по обработчику на строку значит платить за это
    // каждый раз.
    box.dataset.wired = '1';
    box.addEventListener('click', onChatListClick);
    // Осечку загрузки фото ловим на контейнере в фазе перехвата: событие error
    // у картинки не всплывает, а вешать обработчик на каждую строку значит
    // платить за это на каждый ввод в поиске.
    box.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      const holder = img.closest('[data-photo]');
      if (!holder) return;
      holder.classList.add('empty-photo');
      holder.removeAttribute('data-photo');
      holder.innerHTML = ICONS.image;
    }, true);
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      // Нажатие на кнопке действия внутри строки - её дело, переписку не
      // открываем: клик по кнопке придёт отдельным событием.
      if (e.target.closest('[data-act]')) return;
      const row = e.target.closest('.cl-row');
      if (!row) return;
      e.preventDefault();
      openChat(row.dataset.key);
    });
  }
  markActiveChatRow();
}

/** Действия в строке идут раньше открытия переписки: они на ней же и лежат. */
function onChatListClick(e) {
  const act = e.target.closest('[data-act]');
  if (act) {
    e.stopPropagation();
    if (act.dataset.act === 'nudge') nudgeChat(act.dataset.email);
    // Ссылку на объявление открываем во внешнем браузере, а не в окне
    // приложения - этого пока нет, см. renderChatSide.
    else toast(t('chat.openTodo'));
    return;
  }
  // Клик по фото - показать его крупно, а не открыть переписку: миниатюра
  // маленькая, и разглядеть товар в ней нельзя.
  const photo = e.target.closest('[data-photo]');
  if (photo) {
    e.stopPropagation();
    openPhoto(photo.dataset.photo);
    return;
  }
  const row = e.target.closest('.cl-row');
  if (row) openChat(row.dataset.key);
}

/**
 * Строка переписки. Не `button`: внутри свои кнопки действий, а кнопка в кнопке
 * - недопустимая разметка. Роль и tabindex оставляют строку доступной с
 * клавиатуры, нажатие обрабатывает renderChatGroups.
 */
function chatRowHtml(c, showProfile) {
  const q = state.chatQuery.trim();
  const title = (c.contact && c.contact.title) || '';
  const last = c.lastText ? shorten(c.lastText, 60) : '';
  const listing = (c.contact && c.contact.listingUrl) || '';
  // Фото товара вместо буквы адресата: про какое объявление переписка, по
  // строке иначе не понять, а сам адрес стоит тут же справа.
  const photo = (c.contact && c.contact.imageUrl) || '';
  return `<div class="cl-row ${state.openChat === c.chatKey ? 'on' : ''}" data-key="${esc(c.chatKey)}"
    role="button" tabindex="0">
    ${photo
      ? photoHtml(photo, 'cl-photo')
      : `<span class="pc-avatar" style="--av:${avatarColor({ email: c.email })}">${esc((c.email || '?').charAt(0).toUpperCase())}</span>`}
    <span class="clr-id">
      <span class="clr-top">
        <span class="clr-name">${markMatch(c.email || dash, q)}</span>
        <span class="clr-time">${esc(fmtShortTime(c.lastTs))}</span>
      </span>
      ${showProfile ? `<span class="clr-prof">${markMatch(
    (c.mailbox || c.profileEmail || c.profileLabel || t('chat.unknownProfile'))
      + (c.mailbox && c.profileLabel ? ' · ' + c.profileLabel : ''), q,
  )}</span>` : ''}
      ${title ? `<span class="clr-title">${ICONS.target}${markMatch(shorten(title, 42), q)}</span>` : ''}
      <span class="clr-last">${c.lastDir === 'out' ? esc(t('chat.you')) + ': ' : ''}${esc(last)}</span>
    </span>
    <span class="clr-side">
      ${c.replies ? `<span class="clr-badge">${c.replies}</span>` : ''}
      <span class="clr-acts">
        <button class="mini" data-act="nudge" data-email="${esc(c.email)}"
          title="${esc(t('nudge.btn'))}" aria-label="${esc(t('nudge.btn'))}">${ICONS.send}</button>
        ${listing ? `<button class="mini" data-act="open" data-url="${esc(listing)}"
          title="${esc(t('chat.openListing'))}" aria-label="${esc(t('chat.openListing'))}">${ICONS.link}</button>` : ''}
      </span>
    </span>
  </div>`;
}

/** Подсветку открытого чата ставим классом, а не пересборкой списка. */
function markActiveChatRow() {
  $$('.cl-row').forEach((el) => el.classList.toggle('on', el.dataset.key === state.openChat));
}

async function openChat(key) {
  if (state.openChat === key && state.chatMessages.length) return;
  state.openChat = key;
  markActiveChatRow();
  state.chatMessages = await api.chats.messages(key);
  renderChatMain();
}

/** Средняя колонка: шапка, лента писем, поле ответа. */
function renderChatMain() {
  const box = $('#chatMain');
  const side = $('#chatSide');
  if (!box) return;

  const c = chatById(state.openChat);
  if (!c) {
    setOnce(box, `<div class="empty" style="height:100%">${ICONS.chat}
      <div>${esc((state.chats || []).length ? t('chat.pick') : t('chat.empty'))}</div></div>`);
    if (side) setOnce(side, '');
    return;
  }

  const cap = state.settings.system.maxRepliesPerDialog;
  const canReply = c.replies > 0;

  setOnce(box, `
    <header class="cm-head">
      <span class="pc-avatar" style="--av:${avatarColor({ email: c.email })}">${esc((c.email || '?').charAt(0).toUpperCase())}</span>
      <span class="cm-id">
        <span class="cm-name">${esc(c.email || dash)}</span>
        <span class="cm-sub">${esc(c.mailbox || c.profileLabel || dash)} · ${esc(t('chat.repliesOf', { n: c.replies, cap }))}</span>
      </span>
      <button class="mini" id="cmSide" title="${esc(t('chat.toggleSide'))}">${ICONS.dashboard}</button>
    </header>
    <div class="cm-feed" id="cmFeed"></div>
    ${canReply
      ? `<div class="cm-compose">
           <input type="text" id="cmInput" placeholder="${esc(t('chat.placeholder'))}"/>
           <button class="btn primary icon-only" id="cmSend" title="${esc(t('chat.send'))}">${ICONS.send}</button>
         </div>`
      : `<div class="cm-locked">${ICONS.lock}<span>${esc(t('chat.locked'))}</span></div>`}
  `);

  renderChatFeed();
  renderChatSide(c);

  const sideBtn = $('#cmSide', box);
  if (sideBtn) sideBtn.addEventListener('click', () => {
    document.documentElement.classList.toggle('side-off');
  });

  const input = $('#cmInput', box);
  if (input) {
    const send = () => sendChatMessage(c, input);
    $('#cmSend', box).addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }
  wireRipples(box);
}

/**
 * Отправка в тред. Движок такого пока не умеет: есть только "Подтолкнуть" по
 * адресу, а ответ в конкретную переписку - отдельная работа по DOM Gmail.
 * Поле оставлено рабочим на вид, отправка помечена как незаконченная.
 */
async function sendChatMessage(chat, input) {
  const text = input.value.trim();
  if (!text) return;
  // TODO(gmail-dom): ответ в конкретный тред через chrome.gmailReply.
  toast(t('chat.sendTodo'), 'error');
}

function renderChatFeed() {
  const feed = $('#cmFeed');
  if (!feed) return;
  const rows = state.chatMessages || [];
  if (!rows.length) {
    setOnce(feed, `<div class="empty" style="padding:40px 0">${esc(t('chat.noMessages'))}</div>`);
    return;
  }
  // Разделитель дня перед первым письмом каждой даты: у пузыря есть только
  // время, и в переписке на две недели непонятно, когда что было.
  const chat = chatById(state.openChat) || {};
  let day = '';
  setOnce(feed, rows.map((m, i) => {
    const key = m.ts ? new Date(m.ts).toDateString() : '';
    const newDay = key && key !== day;
    const head = newDay ? `<div class="cm-day"><span>${esc(fmtDayLabel(m.ts))}</span></div>` : '';
    day = key || day;
    return head + chatBubbleHtml(m, chat, !newDay && sameSpeaker(rows[i - 1], m));
  }).join(''));
  wirePhotos(feed);
  // Просмотр HTML-письма целиком. Обработчик на всю ленту: писем в ней много, а
  // кнопка есть только у части.
  if (!feed.dataset.wiredHtml) {
    feed.dataset.wiredHtml = '1';
    feed.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn) return;
      const msg = (state.chatMessages || []).find((x) => x.id === btn.dataset.view);
      if (msg && msg.html) openHtmlPreview(msg.html);
    });
  }
  // К последнему письму - в кадре, чтобы не считать раскладку сразу после
  // вставки всей ленты.
  requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

/**
 * Письма подряд от одного и того же - одна группа: подпись у них общая, второй
 * раз называть автора незачем. Через шесть часов считаем разговор возобновлён -
 * там подпись снова нужна.
 */
function sameSpeaker(prev, m) {
  if (!prev) return false;
  return prev.dir === m.dir && (prev.kind || 'first') === (m.kind || 'first')
    && (m.ts - prev.ts) < 6 * 3600 * 1000;
}

/** Кто написал: наш профиль или продавец. */
function chatAuthor(m, c) {
  if (m.dir === 'out') return c.profileLabel || t('chat.you');
  const name = (c.contact && c.contact.name) || '';
  return name || String(c.email || dash).split('@')[0];
}

/**
 * Письмо в ленте. Подпись вынесена НАД пузырём: внутри она читалась как
 * отладочная строка и отъедала высоту у самого текста. Исходящее не заливаем
 * акцентом целиком - на тёмном фоне это была самая яркая плита на экране;
 * хватает мягкой подложки и кромки.
 */
function chatBubbleHtml(m, c, same) {
  const out = m.dir === 'out';
  // Тексты рассылки заканчиваются переносом строки - в письме он не виден, а в
  // пузыре рисовался бы пустой строкой. Внутренние абзацы сохраняем: они
  // осмысленные, ими текст и разбит.
  const body = String(m.body || '').trim();
  // Письмо уходило HTML-шаблоном. В пузырь ставим картинки и текстовую
  // проекцию, а не саму разметку: письмо со своими стилями сломало бы ленту, а
  // сырой HTML в переписке читать невозможно. Целиком письмо открывается
  // кнопкой, тем же превью, что и в настройках.
  const shots = m.html ? htmlImages(m.html) : [];
  return `<div class="bubble ${out ? 'out' : 'in'} ${same ? 'same' : ''}">
    <div class="bb-meta">
      ${same ? '' : `<span class="bb-who">${esc(chatAuthor(m, c))}</span>
      <span class="bb-kind">${esc(t('chat.kind.' + (m.kind || 'first')))}</span>`}
      ${m.html ? `<span class="bb-kind">HTML</span>` : ''}
      ${m.partial ? `<span class="bb-partial" title="${esc(t('chat.partialHint'))}">${esc(t('chat.partial'))}</span>` : ''}
      <span class="bb-time">${esc(fmtClock(m.ts))}</span>
    </div>
    <div class="bb-body">
      ${m.subject && m.kind === 'first' ? `<div class="bb-subj">${esc(m.subject)}</div>` : ''}
      ${shots.length ? `<div class="bb-shots">${shots.map((u) => photoHtml(u, 'bb-photo')).join('')}</div>` : ''}
      <div class="bb-text">${esc(body)}</div>
      ${m.html ? `<button class="mini bb-view" data-view="${esc(m.id)}">${ICONS.image}<span>${esc(t('chat.viewHtml'))}</span></button>` : ''}
    </div>
  </div>`;
}

/**
 * Адреса картинок из разметки письма. Тот же разбор, что в main
 * (htmlTemplate.images), но лента чата собирается в рендере, и гонять письмо
 * туда-обратно через IPC ради одного списка незачем.
 */
function htmlImages(html) {
  const out = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m = re.exec(String(html || ''));
  while (m) {
    const src = String(m[2] != null ? m[2] : (m[3] || ''))
      .replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');
    if (src && out.indexOf(src) < 0) out.push(src);
    m = re.exec(String(html || ''));
  }
  return out;
}

/**
 * Фото товара из парсера (`imageUrl` лида).
 *
 * Картинка живёт на CDN площадки и пропадает вместе с объявлением, поэтому
 * разметка всегда одна и та же: контейнер с заглушкой, а `img` внутри. Не
 * загрузилась - `wirePhotos` возвращает контейнер к заглушке, вместо рамки с
 * крестом. Пустой адрес - сразу заглушка.
 */
function photoHtml(url, cls) {
  const src = String(url == null ? '' : url).trim();
  if (!src) return `<div class="photo ${cls} empty-photo">${ICONS.image}</div>`;
  return `<div class="photo ${cls}" data-photo="${esc(src)}" title="${esc(t('chat.photoOpen'))}">
    <img src="${esc(src)}" alt="" loading="lazy"/></div>`;
}

/** Заглушка при осечке загрузки и открытие фото крупно по клику. */
function wirePhotos(root) {
  $$('[data-photo]', root).forEach((box) => {
    if (box.dataset.wired) return;
    box.dataset.wired = '1';
    const img = box.querySelector('img');
    if (img) {
      img.addEventListener('error', () => {
        box.classList.add('empty-photo');
        box.removeAttribute('data-photo');
        box.innerHTML = ICONS.image;
      });
    }
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      if (box.dataset.photo) openPhoto(box.dataset.photo);
    });
  });
}

/** Фото объявления во весь экран - в списке и в карточке оно слишком мелкое. */
function openPhoto(url) {
  return modal(
    `<div class="photo-full"><img src="${esc(url)}" alt=""/></div>
     <div class="modal-actions">
       <button class="btn" id="phClose">${esc(t('common.close'))}</button>
     </div>`,
    (overlay, done) => {
      $('#phClose', overlay).addEventListener('click', () => done(null));
    },
  );
}

/** Правая колонка: карточка объявления. Пустых строк не рисуем. */
function renderChatSide(c) {
  const side = $('#chatSide');
  if (!side) return;
  const info = c.contact;
  if (!info) {
    setOnce(side, `<div class="empty" style="padding:36px 16px">${ICONS.target}
      <div>${esc(t('chat.noContact'))}</div></div>`);
    return;
  }

  const rows = [
    [t('chat.i.price'), info.price ? String(info.price) + (info.currency ? ' ' + info.currency : '') : ''],
    [t('chat.i.seller'), info.name],
    [t('chat.i.platform'), info.platform],
    [t('chat.i.date'), info.datePublication],
    [t('chat.i.firstSent'), info.firstSentAt ? fmtDate(info.firstSentAt) : ''],
  ].filter(([, v]) => v);

  setOnce(side, `
    <div class="cs-head"><span class="section-label">${esc(t('chat.listing'))}</span></div>
    ${photoHtml(info.imageUrl, 'cs-photo')}
    <div class="cs-title">${esc(info.title || t('chat.noTitle'))}</div>
    <div class="cs-rows">
      ${rows.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
    </div>
    <div class="cs-acts">
      ${info.listingUrl ? `<button class="btn ghost" data-open="${esc(info.listingUrl)}">${ICONS.link}<span>${esc(t('chat.openListing'))}</span></button>` : ''}
      <button class="btn ghost" data-nudge="${esc(c.email)}">${ICONS.send}<span>${esc(t('nudge.btn'))}</span></button>
    </div>
  `);

  const openBtn = $('[data-open]', side);
  // Ссылку на объявление открываем во внешнем браузере, а не в окне
  // приложения: своего браузера тут нет, а подменять интерфейс страницей
  // площадки незачем.
  if (openBtn) openBtn.addEventListener('click', () => toast(t('chat.openTodo')));
  const nudgeBtn = $('[data-nudge]', side);
  if (nudgeBtn) nudgeBtn.addEventListener('click', () => nudgeChat(nudgeBtn.dataset.nudge));
  wirePhotos(side);
  wireRipples(side);
}

/** Напоминание продавцу. Одно и то же и из строки списка, и из карточки. */
async function nudgeChat(email) {
  if (!email) return;
  toast(t('nudge.sending'));
  try {
    const res = await api.contacts.nudge(email);
    toast(res && res.ok ? t('nudge.ok') : t('nudge.fail.' + ((res && res.reason) || 'unknown')),
      res && res.ok ? 'success' : 'error');
    if (res && res.ok) refreshChats(true);
  } catch (e) { toast(t('nudge.error', { error: e.message }), 'error'); }
}

/** Часы и минуты. В ленте дату писать незачем - её держит разделитель дня. */
function fmtClock(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Подпись дня для разделителя в ленте. */
function fmtDayLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t('chat.today');
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return t('chat.yesterday');
  return d.toLocaleDateString([], { day: '2-digit', month: 'long' });
}

/** Короткое время: сегодняшнее - часами, старое - датой. */
function fmtShortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

async function refreshChats(force) {
  state.chats = await api.chats.list();
  if (state.route !== 'chats') return;
  // Счётчики профилей и статусы Chrome тоже могли поменяться.
  renderChatRail();
  renderChatGroups();
  // Ленту перечитываем только по явному запросу: она меняется реже списка, а
  // каждое чтение - это обход всего журнала сообщений в main.
  if (force && state.openChat) state.chatMessages = await api.chats.messages(state.openChat);
  renderChatMain();
}

// Фильтры карточек профилей. Считаются по тем же полям, что рисует карточка.
const PROFILE_FILTERS = [
  { id: 'all', match: () => true },
  { id: 'ready', match: (p) => p.gmailStatus === 'ready' },
  { id: 'running', match: (p) => p.running },
  { id: 'problems', match: (p) => p.gmailStatus === 'needs_login' || p.gmailStatus === 'error' },
];

const PROFILE_SORTS = ['created', 'written', 'status', 'label'];

VIEWS.profiles = () => {
  const s = state.profileStats || { total: 0, running: 0, gmailReady: 0, portsOpen: 0 };
  const ui = state.settings.ui || {};
  const wrap = h(`<div>
    <div class="prof-hero card glass glass-sheen">
      <div class="ph-top">
        <div class="ph-main">
          <div class="section-label">${esc(t('prof.heroKicker'))}</div>
          <div class="ph-big"><b id="phReady">0</b><span id="phReadyCap"></span></div>
        </div>
        <span id="viewActions" class="ph-acts"></span>
      </div>
      <div class="ph-track"><span id="phBar" style="width:0%"></span></div>
      <div class="ph-foot">
        <div class="ph-sub" id="phSub"></div>
        <div class="ph-nums">
          <div class="stat-cell"><div class="num" id="sOnline">0/0</div><div class="cap">${esc(t('prof.runningCount'))}</div></div>
          <div class="stat-cell" id="cWritten"><div class="num" id="sWritten">0</div><div class="cap">${esc(t('prof.written'))}</div></div>
          <div class="stat-cell" id="cDialogs"><div class="num" id="sDialogs">0</div><div class="cap">${esc(t('prof.dialogs'))}</div></div>
          <div class="stat-cell" id="cProblems"><div class="num" id="sProblems">0</div><div class="cap">${esc(t('prof.problems'))}</div></div>
        </div>
      </div>
      <div id="pNote"></div>
    </div>

    <div class="filter-row">
      <div class="seg filters" id="pFilters"></div>
      <div class="prof-search">
        ${ICONS.search}
        <input type="search" id="pSearch" autocomplete="off" spellcheck="false"
          placeholder="${esc(t('prof.searchPh'))}" aria-label="${esc(t('prof.searchPh'))}"/>
      </div>
      <span class="spacer"></span>
      <label class="prof-sort" title="${esc(t('prof.sort'))}">
        ${ICONS.sort}
        <select id="pSort" aria-label="${esc(t('prof.sort'))}">
          ${PROFILE_SORTS.map((v) => `<option value="${v}" ${ui.profileSort === v ? 'selected' : ''}>${esc(t('prof.sort.' + v))}</option>`).join('')}
        </select>
      </label>
      <div class="seg icons" id="pView">
        <button data-v="grid" class="${ui.profileView === 'list' ? '' : 'active'}" title="${esc(t('prof.view.grid'))}">${ICONS.grid}</button>
        <button data-v="list" class="${ui.profileView === 'list' ? 'active' : ''}" title="${esc(t('prof.view.list'))}">${ICONS.list}</button>
      </div>
    </div>

    <div class="cards-grid cascade" id="cards"></div>
    <div class="bulk-bar glass" id="pBulk" hidden></div>
  </div>`);

  // Панель массовых действий одна на оба вида списка, поэтому и обработчик
  // один: кнопки в ней перерисовываются, вешать слушателей на каждую нельзя.
  $('#pBulk', wrap).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bulk]');
    if (!btn) return;
    const kind = btn.dataset.bulk;
    if (kind === 'cancel') { if (state.bulk) state.bulk.cancel = true; return; }
    if (kind === 'clear') { clearProfilePicks(); return; }
    runBulk(kind);
  });

  const search = $('#pSearch', wrap);
  search.value = state.profileQuery;
  search.addEventListener('input', debounce(() => {
    state.profileQuery = search.value;
    renderProfileFilters(wrap);
    renderProfileCards(wrap);
  }, 180));

  $('#pSort', wrap).addEventListener('change', async (e) => {
    await saveSection('ui', { profileSort: e.target.value });
    renderProfileCards(wrap);
  });

  $$('#pView button', wrap).forEach((b) => b.addEventListener('click', async () => {
    $$('#pView button', wrap).forEach((x) => x.classList.toggle('active', x === b));
    await saveSection('ui', { profileView: b.dataset.v });
    renderProfileCards(wrap);
  }));

  setTimeout(() => {
    paintProfileStats(s);
    renderProfileFilters(wrap);
    renderProfileCards(wrap);
    paintProfileLive();
    paintBulkBar();
  }, 0);
  return wrap;
};

/**
 * Профили в том составе и порядке, в каком их показывает список.
 *
 * Фильтр, поиск и сортировка собраны в одном месте нарочно: счётчики на
 * кнопках фильтров считаются тем же кодом, и разойтись с содержимым сетки они
 * не могут.
 */
function visibleProfiles(skipFilter) {
  const filter = PROFILE_FILTERS.find((f) => f.id === state.profileFilter) || PROFILE_FILTERS[0];
  const q = state.profileQuery.trim().toLowerCase();
  const hit = (p) => !q || [p.label, p.email]
    .concat((p.mailboxes || []).map((m) => m.email))
    .some((v) => String(v || '').toLowerCase().includes(q));
  const out = state.profiles.filter((p) => hit(p) && (skipFilter || filter.match(p)));
  return sortProfiles(out);
}

function sortProfiles(list) {
  const m = state.profileMetrics || {};
  const written = (p) => ((m[p.id] || {}).written || 0);
  // Порядок состояний от худшего к лучшему: список открывают, чтобы чинить.
  const rank = { error: 0, needs_login: 1, new: 2, unknown: 2, ready: 3 };
  const at = (p) => (rank[p.gmailStatus] === undefined ? 9 : rank[p.gmailStatus]);
  const by = {
    created: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    written: (a, b) => written(b) - written(a),
    status: (a, b) => at(a) - at(b),
    label: (a, b) => String(a.label || '').localeCompare(String(b.label || '')),
  };
  const cmp = by[(state.settings.ui || {}).profileSort] || by.created;
  return list.slice().sort(cmp);
}

function renderProfileFilters(root) {
  const box = root.querySelector('#pFilters') || $('#pFilters');
  if (!box) return;
  // Счётчик считаем по тому же поиску, что и сетку: иначе "Готовы 3" при трёх
  // отфильтрованных карточках и пустом списке выглядело бы поломкой.
  const found = visibleProfiles(true);
  box.innerHTML = PROFILE_FILTERS.map((f) => {
    const n = found.filter(f.match).length;
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

  // Шапка: сколько профилей движок возьмёт в прогон и сколько писем по лимиту
  // уже израсходовано. Готовым считаем то же, что и движок (_readyProfiles):
  // профиль со статусом ready. Полоса идёт по ПОЧТАМ - лимит считается по
  // каждой отдельно, и делить один лимит между ними было бы неправдой.
  const ready = state.profiles.filter((p) => p.gmailStatus === 'ready').length;
  const bigN = $('#phReady');
  if (bigN) bigN.textContent = String(ready);
  const bigCap = $('#phReadyCap');
  if (bigCap) bigCap.textContent = t('prof.heroReady', { n: state.profiles.length });
  setTone(bigN && bigN.parentElement, ready > 0 ? 'ok' : (state.profiles.length ? 'bad' : ''));

  const limit = state.settings.system.mailsPerAccount;
  let cap = 0;
  let sent = 0;
  for (const p of state.profiles) {
    const boxes = p.mailboxes || [];
    cap += limit * Math.max(1, boxes.length);
    sent += boxes.length
      ? boxes.reduce((n, b) => n + Math.min(b.sentCount || 0, limit), 0)
      : Math.min(p.sentCount || 0, limit);
  }
  const bar = $('#phBar');
  if (bar) bar.style.width = (cap > 0 ? clamp(sent / cap, 0, 1) * 100 : 0).toFixed(1) + '%';
  const sub = $('#phSub');
  if (sub) sub.textContent = t('prof.heroCap', { sent, cap });
}

function renderProfileCards(root) {
  const cards = root.querySelector('#cards') || $('#cards');
  if (!cards) return;
  const limit = state.settings.system.mailsPerAccount;
  const ui = state.settings.ui || {};
  const list = ui.profileView === 'list';

  // Список пересобираем, только когда изменилось что-то видимое на карточке.
  // Опрос идёт каждые четыре секунды, и без этой проверки DOM выбрасывался и
  // строился заново вхолостую - вместе с наведением, бликом и каскадом.
  const current = sessionPlan().current;
  const sign = JSON.stringify([
    state.booted, state.profileFilter, limit, state.selectedProfile,
    state.profileQuery, ui.profileSort, ui.profileView, state.selectedProfiles,
    current && state.runStatus.running ? current.key : '',
    state.profiles.map((p) => [p.id, p.label, p.email, p.gmailStatus, p.running, p.port, p.sentCount,
      (p.mailboxes || []).map((m) => [m.email, m.hasTab, m.sentCount]),
      (state.profileMetrics || {})[p.id]]),
  ]);
  if (cards.dataset.sign === sign) return;
  cards.dataset.sign = sign;

  cards.className = 'cascade ' + (list ? 'prof-rows' : 'cards-grid');
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

  const shown = visibleProfiles();
  if (!shown.length) {
    cards.appendChild(h(`<div class="empty glass" style="grid-column:1/-1">${ICONS.profiles}
      <div>${esc(state.profileQuery.trim() ? t('prof.emptySearch') : t('prof.emptyFiltered'))}</div></div>`));
    return;
  }

  for (const p of shown) {
    const info = profileInfo(p, limit, current);
    const el = h(list ? profileRowHtml(p, info, limit) : profileCardHtml(p, info, limit, current));
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-pick]')) { e.stopPropagation(); toggleProfilePick(p.id); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) { openProfileDrawer(p.id); return; }
      e.stopPropagation();
      profileAction(btn.dataset.act, p);
    });
    cards.appendChild(el);
  }

  // Плитка "новый профиль" - часть сетки. В списке она смотрелась бы строкой
  // среди аккаунтов, поэтому там её место занимает кнопка в шапке раздела.
  if (!list) {
    const add = h(`<div class="add-card">
      <span class="plus">${ICONS.plus}</span>
      <span class="cap">${esc(t('prof.new'))}</span>
      <span class="sub">${esc(t('prof.addSub'))}</span></div>`);
    add.addEventListener('click', () => createProfile());
    cards.appendChild(add);
  }

  wireSheen(cards);
  wireCascade(cards.parentElement || document);
}

/**
 * Числа профиля, общие для карточки и строки: прогресс по лимиту, метрики и
 * признак "пишем прямо сейчас". Считаются в одном месте, чтобы два вида одного
 * списка не разошлись в цифрах.
 */
function profileInfo(p, limit, current) {
  const boxes = p.mailboxes || [];
  // Прогресс профиля - по сумме лимитов его почт: лимит применяется к каждой
  // почте отдельно, и делить один лимит между ними было бы неправдой.
  const cap = limit * Math.max(1, boxes.length);
  const sent = boxes.length
    ? boxes.reduce((n, m) => n + Math.min(m.sentCount || 0, limit), 0)
    : (p.sentCount || 0);
  return {
    boxes,
    cap,
    sent,
    done: cap > 0 ? clamp(sent / cap, 0, 1) : 0,
    isCurrent: !!(current && current.profileId === p.id && state.runStatus.running),
    m: (state.profileMetrics || {})[p.id] || { written: 0, dialogs: 0, replies: 0 },
    bad: p.gmailStatus === 'error' || p.gmailStatus === 'needs_login',
  };
}

function profileCardHtml(p, info, limit, current) {
  const { boxes, cap, sent, done, isCurrent, m, bad } = info;
  return `<div class="profile-card glass glass-sheen ${state.selectedProfile === p.id ? 'selected' : ''} ${isCurrent ? 'current' : ''} ${bad ? 'error' : ''} ${state.selectedProfiles.includes(p.id) ? 'picked' : ''}" data-id="${esc(p.id)}">
    <div class="pc-head">
      ${pickHtml(p)}
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

    ${profileLiveHtml(p, info)}

    ${mailboxListHtml(p, limit, current)}

    <div class="pc-meta">
      <span><span class="dot ${p.running ? 'running' : 'new'}"></span> ${esc(p.running ? t('prof.running') : t('prof.stopped'))}</span>
      <span>${esc(t('prof.port'))}: ${p.port || dash}</span>
      <span class="chip-mini" title="${esc(t('prof.sentHint'))}">${boxes.length ? sent + ' / ' + cap : sent}</span>
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
  </div>`;
}

/**
 * Тот же профиль строкой. Нужен, когда аккаунтов много: карточками десяток
 * профилей занимает несколько экранов, и сравнить их между собой нельзя.
 * Здесь только то, по чему их сравнивают: состояние, написано, прогресс.
 */
function profileRowHtml(p, info, limit) {
  const { boxes, cap, sent, done, isCurrent, m, bad } = info;
  return `<div class="prow glass ${state.selectedProfile === p.id ? 'selected' : ''} ${isCurrent ? 'current' : ''} ${bad ? 'error' : ''} ${state.selectedProfiles.includes(p.id) ? 'picked' : ''}" data-id="${esc(p.id)}">
    ${pickHtml(p)}
    <span class="pc-avatar" style="--av:${avatarColor(p)}">${esc(avatarLetter(p))}
      <span class="mark ${p.gmailStatus}"></span></span>
    <span class="prow-id">
      <span class="pc-name">${esc(p.label)}</span>
      <span class="pc-email">${esc(p.email || t('prof.notSignedIn'))}</span>
    </span>
    <span class="prow-tags">${profileTags(p, m, isCurrent, limit)}</span>
    <span class="prow-num"><b>${m.written}</b><span>${esc(t('prof.written'))}</span></span>
    <span class="prow-num"><b>${m.replies}</b><span>${esc(t('prof.replies'))}</span></span>
    <span class="prow-track" title="${esc(t('prof.sentHint'))}">
      <span class="track"><span style="width:${(done * 100).toFixed(1)}%"></span></span>
      <span class="cnt">${boxes.length ? sent + ' / ' + cap : sent}</span>
    </span>
    <span class="acts">
      <button class="mini go" data-act="${p.running ? 'stop' : 'launch'}"
        title="${esc(p.running ? t('prof.stopBtnFull') : t('prof.launch'))}">${p.running ? ICONS.stop : ICONS.play}</button>
      <button class="mini" data-act="scan" title="${esc(t('prof.scan'))}">${ICONS.reset}</button>
      <button class="mini" data-act="open" title="${esc(t('prof.details'))}">${ICONS.settings}</button>
      <button class="mini danger" data-act="del" title="${esc(t('prof.delete'))}">${ICONS.trash}</button>
    </span>
  </div>`;
}

// ── массовые действия над профилями ────────────────────────────────
// Каждое действие тут - это запуск или остановка отдельного Chrome, поэтому
// идём строго по очереди и с возможностью прервать: одновременный старт
// десятка браузеров упирается в память и в выдачу отладочных портов.

function toggleProfilePick(id) {
  const at = state.selectedProfiles.indexOf(id);
  if (at === -1) state.selectedProfiles.push(id);
  else state.selectedProfiles.splice(at, 1);
  renderProfileCards(document);
  paintBulkBar();
}

function clearProfilePicks() {
  if (!state.selectedProfiles.length) return;
  state.selectedProfiles = [];
  renderProfileCards(document);
  paintBulkBar();
}

const BULK_ACTIONS = [
  { kind: 'launch', icon: 'play', key: 'prof.bulkLaunch', cls: '' },
  { kind: 'stop', icon: 'stop', key: 'prof.bulkStop', cls: '' },
  { kind: 'scan', icon: 'reset', key: 'prof.bulkScan', cls: '' },
  { kind: 'del', icon: 'trash', key: 'prof.bulkDel', cls: 'danger' },
];

function paintBulkBar() {
  const bar = $('#pBulk');
  if (!bar) return;
  const busy = state.bulk;
  const n = state.selectedProfiles.length;
  bar.hidden = !busy && !n;
  if (bar.hidden) return;

  if (busy) {
    const pct = busy.total ? (busy.done / busy.total) * 100 : 0;
    bar.innerHTML = `
      <span class="bb-count">${esc(t('prof.bulkProgress', { done: busy.done, total: busy.total }))}</span>
      <span class="bb-track"><span style="width:${pct.toFixed(1)}%"></span></span>
      <button class="btn ghost" data-bulk="cancel">${esc(t('prof.bulkCancel'))}</button>`;
    return;
  }
  bar.innerHTML = `
    <span class="bb-count">${esc(t('prof.bulkSelected', { n }))}</span>
    <span class="grow"></span>
    ${BULK_ACTIONS.map((a) => `<button class="btn ${a.cls}" data-bulk="${a.kind}">${ICONS[a.icon]}<span>${esc(t(a.key))}</span></button>`).join('')}
    <button class="btn ghost" data-bulk="clear">${esc(t('prof.bulkClear'))}</button>`;
  wireRipples(bar);
}

async function runBulk(kind) {
  if (state.bulk) return;
  const list = state.profiles.filter((p) => state.selectedProfiles.includes(p.id));
  if (!list.length) return;
  const names = list.map((p) => p.label).join(', ');

  // Запуск и удаление спрашивают подтверждение со списком имён: оба
  // необратимы по последствиям, и промахнуться выбором тут легко.
  if (kind === 'launch') {
    const ok = await askConfirm(t('prof.confirmBulkLaunchTitle', { n: list.length }),
      t('prof.confirmBulkLaunchText', { list: names }));
    if (!ok) return;
  }
  if (kind === 'del') {
    const ok = await askConfirm(t('prof.confirmBulkDelTitle', { n: list.length }),
      t('prof.confirmBulkDelText', { list: names }), { danger: true, okLabel: t('common.delete') });
    if (!ok) return;
  }

  state.bulk = { kind, total: list.length, done: 0, cancel: false };
  paintBulkBar();
  let failed = 0;
  for (const p of list) {
    if (state.bulk.cancel) break;
    try {
      if (kind === 'launch') await api.profiles.launch(p.id, true);
      else if (kind === 'stop') await api.profiles.stop(p.id);
      else if (kind === 'scan') await api.profiles.scan(p.id);
      else if (kind === 'del') await api.profiles.remove(p.id);
    } catch (e) {
      failed++;
      toast(t('prof.bulkFailed', { label: p.label, error: e.message }), 'error');
    }
    state.bulk.done++;
    paintBulkBar();
  }

  const { done, total, cancel } = state.bulk;
  state.bulk = null;
  state.selectedProfiles = [];
  await refreshProfiles();
  paintBulkBar();
  if (cancel) toast(t('prof.bulkStopped', { done, total }), 'warn');
  else if (failed) toast(t('prof.bulkPartial', { done: done - failed, total }), 'warn');
  else toast(t('prof.bulkDone', { n: done }), 'success');
}

/** Отметка карточки для массового действия. */
function pickHtml(p) {
  const on = state.selectedProfiles.includes(p.id);
  return `<button class="pick ${on ? 'on' : ''}" data-pick="1" aria-pressed="${on}"
    title="${esc(t('prof.pick'))}">${on ? ICONS.check : ''}</button>`;
}

/**
 * Живая строка карточки: график отправок за сессию, когда профиль писал в
 * последний раз и когда упрётся в лимит.
 *
 * График копится в рендере с момента запуска приложения, а время последнего
 * письма приходит из main и переживает перезапуск - поэтому пустой график
 * рядом с "писал 2 часа назад" это не противоречие.
 */
function profileLiveHtml(p, info) {
  const row = state.profileSeries[p.id];
  const d = sparkPath(row && row.values, 100, 18);
  const when = info.m.lastSentAt ? t('prof.lastSent', { ago: fmtAgo(info.m.lastSentAt) }) : t('prof.neverSent');
  const eta = profileEta(p, info);
  return `<div class="pc-live">
    <svg class="pc-spark" viewBox="0 0 100 18" preserveAspectRatio="none">
      <path class="area" d="${d.area}"/><path d="${d.line}" vector-effect="non-scaling-stroke"/>
    </svg>
    <span class="pc-when">${esc(when)}</span>
    ${eta ? `<span class="pc-eta">${ICONS.clock}<span>${esc(eta)}</span></span>` : ''}
  </div>`;
}

/**
 * Живые части карточек: график, "писал N назад" и прогноз.
 *
 * Обновляем на месте, не пересобирая список. Спарклайн меняется на каждом
 * такте опроса, а пересборка сетки каждые четыре секунды рвёт наведение, блик
 * и каскад - ровно то, от чего защищает подпись в renderProfileCards.
 */
function paintProfileLive() {
  const boxes = $$('.pc-live');
  if (!boxes.length) return;
  const limit = state.settings.system.mailsPerAccount;
  const current = sessionPlan().current;
  for (const box of boxes) {
    const host = box.closest('[data-id]');
    const p = host && state.profiles.find((x) => x.id === host.dataset.id);
    if (!p) continue;
    const info = profileInfo(p, limit, current);
    const row = state.profileSeries[p.id];
    const d = sparkPath(row && row.values, 100, 18);
    const svg = box.querySelector('svg');
    if (svg) {
      svg.children[0].setAttribute('d', d.area);
      svg.children[1].setAttribute('d', d.line);
    }
    const when = box.querySelector('.pc-when');
    if (when) {
      when.textContent = info.m.lastSentAt
        ? t('prof.lastSent', { ago: fmtAgo(info.m.lastSentAt) })
        : t('prof.neverSent');
    }
    const eta = profileEta(p, info);
    let tag = box.querySelector('.pc-eta');
    if (eta && !tag) {
      tag = h(`<span class="pc-eta">${ICONS.clock}<span></span></span>`);
      box.appendChild(tag);
    }
    if (!tag) continue;
    tag.hidden = !eta;
    if (eta) tag.lastElementChild.textContent = eta;
  }
}

/**
 * Сколько ждать, пока профиль упрётся в лимит.
 *
 * Темп берём из накопленного ряда: за наблюдаемое время ушло столько-то писем.
 * Пока писем мало или наблюдаем меньше минуты, темпа ещё нет - и честнее не
 * показать ничего, чем красивое, но выдуманное число.
 */
function profileEta(p, info) {
  if (!state.runStatus.running) return '';
  const row = state.profileSeries[p.id];
  if (!row || !row.first) return '';
  const sec = (Date.now() - row.first) / 1000;
  const sum = row.values.reduce((n, v) => n + v, 0);
  if (sum < 2 || sec < 60) return '';
  const left = Math.max(0, info.cap - info.sent);
  if (!left) return '';
  return t('prof.etaLimit', { time: fmtUptime(Math.round(left * sec / sum)) });
}

/**
 * Почты профиля со своим счётчиком.
 *
 * В одном профиле их может быть несколько (мультилогин Google), и лимит писем
 * считается по каждой отдельно. Почта без открытой вкладки в рассылке не
 * участвует - об этом и говорит пометка: вкладку открывает пользователь, само
 * приложение её не заводит.
 */
function mailboxListHtml(p, limit, current) {
  const boxes = p.mailboxes || [];
  if (!boxes.length) {
    if (!p.running) return '';
    return `<div class="pc-boxes"><div class="hint">${esc(t('prof.noMailboxes'))}</div></div>`;
  }
  return `<div class="pc-boxes">
    <div class="section-label">${esc(t('prof.mailboxes', { n: boxes.length }))}</div>
    ${boxes.map((m) => {
    const sent = m.sentCount || 0;
    const done = limit > 0 ? clamp(sent / limit, 0, 1) : 0;
    const live = !!(current && state.runStatus.running
      && current.profileId === p.id && current.email === m.email);
    return `<div class="pc-box ${m.hasTab ? '' : 'off'}">
        <span class="pb-dot ${m.hasTab ? 'on' : ''}"></span>
        <span class="pb-mail">${esc(m.email || dash)}</span>
        ${live ? `<span class="pc-tag live">${esc(t('prof.writingNow'))}</span>` : ''}
        ${m.hasTab ? '' : `<span class="pc-tag warn" title="${esc(t('prof.noTabHint'))}">${esc(t('prof.noTab'))}</span>`}
        <span class="pb-track"><span style="width:${(done * 100).toFixed(1)}%"></span></span>
        <span class="pb-cnt">${sent} / ${limit}</span>
      </div>`;
  }).join('')}
  </div>`;
}

/**
 * Теги карточки. Только то, что видно по данным: выдуманных ярлыков вроде
 * "надёжный" здесь быть не должно - они ничего не значат.
 */
function profileTags(p, m, isCurrent, limit) {
  const tags = [];
  const boxes = p.mailboxes || [];
  if (isCurrent) tags.push(['live', t('prof.writingNow')]);
  if (p.gmailStatus !== 'ready') tags.push([p.gmailStatus === 'error' ? 'bad' : 'warn', t('status.' + p.gmailStatus)]);
  // Лимит профиля исчерпан, только когда его добрали ВСЕ почты: пока хоть одна
  // под лимитом, с профиля продолжают уходить письма.
  const capped = boxes.length
    ? boxes.every((b) => limit > 0 && (b.sentCount || 0) >= limit)
    : (limit > 0 && (p.sentCount || 0) >= limit);
  if (capped) tags.push(['done', t('prof.tagLimit')]);
  if (boxes.length > 1) tags.push(['', t('prof.tagMailboxes', { n: boxes.length })]);
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
    ${(p.mailboxes || []).length
      ? (p.mailboxes || []).map((m) => `<div class="kv"><span class="k">${esc(m.email || dash)}${m.hasTab ? '' : ' · ' + esc(t('prof.noTab'))}</span>
          <span class="v">${m.sentCount || 0} / ${state.settings.system.mailsPerAccount}</span></div>`).join('')
      : `<div class="kv"><span class="k">${esc(t('prof.sentCount'))}</span><span class="v">${p.sentCount} / ${state.settings.system.mailsPerAccount}</span></div>`}
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

// ── Настройки: разделы слева, содержимое справа ─────────────────────
// Всё настраиваемое собрано здесь. Отдельных разделов под парсер, CDP,
// ссылки и Telegram в верхней панели нет: одно место правды.
//
// Группы разложены по разделам, а не идут одним плоским списком: девять
// пунктов подряд ничего не подсказывают, а "пауза между письмами" и "лимит на
// аккаунт" - это одна тема, и лежать они должны рядом.
//
// `terms` - ключи подписей, по которым группа находится поиском. Список
// небольшой и заодно показывает, что в группе вообще есть.

const SETTINGS_GROUPS = [
  {
    id: 'limits', section: 'run', icon: 'dashboard', reset: 'system', build: buildSetLimits,
    terms: ['set.mails', 'set.replies', 'set.sendDelay', 'set.checkInterval', 'set.waitScale'],
  },
  {
    id: 'autoreply', section: 'run', icon: 'chat', reset: 'autoReply', build: buildSetAutoReply,
    // Единственная группа, которой узкой колонки мало: в ней редактор HTML.
    wide: true,
    terms: ['ar.modeText', 'ar.modeHtml', 'set.b.template', 'ar.slots'],
  },
  {
    id: 'texts', section: 'run', icon: 'inbox', build: buildSetTexts,
    terms: ['txt.outreachLang', 'txt.editJson', 'txt.d.first', 'txt.d.reply', 'txt.d.nudge'],
  },
  {
    id: 'parser', section: 'data', icon: 'parser', reset: 'parser', build: buildSetParser,
    terms: ['parser.apiKey', 'parser.type', 'parser.enabled', 'parser.aiSwap', 'parser.swapN',
      'set.batch', 'set.threshold'],
  },
  {
    id: 'targets', section: 'data', icon: 'target', build: buildSetTargets,
    terms: ['set.g.targets'],
  },
  {
    id: 'link', section: 'data', icon: 'link', reset: 'link', build: buildSetLink,
    terms: ['link.apiKey', 'link.team', 'link.mode', 'link.profileId', 'link.country'],
  },
  {
    id: 'cdp', section: 'system', icon: 'cdp', reset: 'cdp', build: buildSetCdp,
    terms: ['cdp.portStart', 'cdp.portEnd', 'cdp.path', 'cdp.detect'],
  },
  {
    id: 'telegram', section: 'system', icon: 'telegram', reset: 'telegram', build: buildSetTelegram,
    terms: ['tg.token', 'tg.chatId', 'tg.test'],
  },
  {
    id: 'interface', section: 'look', icon: 'settings', build: buildSetInterface,
    terms: ['set.language'],
  },
  {
    id: 'appearance', section: 'look', icon: 'palette', build: buildSetAppearance,
    terms: ['appear.background', 'appear.presets', 'appear.fit', 'appear.dim', 'appear.blur',
      'appear.glass', 'appear.accent', 'appear.motion'],
  },
];

const SETTINGS_SECTIONS = ['run', 'data', 'system', 'look'];

VIEWS.settings = () => {
  const wrap = h(`<div class="settings">
    <aside class="set-menu glass">
      <div class="set-search">
        ${ICONS.search}
        <input type="search" id="setSearch" autocomplete="off" spellcheck="false"
          placeholder="${esc(t('set.searchPh'))}" aria-label="${esc(t('set.searchPh'))}"/>
        <span class="set-count" id="setCount"></span>
      </div>
      <div class="set-nav" id="setNav">
        ${SETTINGS_SECTIONS.map((sec) => `<div class="set-sec" data-sec="${sec}">
          <div class="set-sec-cap">${esc(t('set.sec.' + sec))}</div>
          ${SETTINGS_GROUPS.filter((g) => g.section === sec).map((g) => `
            <button class="set-tab" data-g="${g.id}">
              <span class="icon">${ICONS[g.icon]}</span><span>${esc(t('set.g.' + g.id))}</span>
              <span class="set-dot" title="${esc(t('set.changed'))}"></span>
            </button>`).join('')}
        </div>`).join('')}
      </div>
      <div class="set-nomatch hint" id="setNoMatch" hidden>${esc(t('set.noMatch'))}</div>
    </aside>
    <div class="set-panel" id="setPanel"></div>
  </div>`);

  $$('.set-tab', wrap).forEach((b) => b.addEventListener('click', () => {
    state.settingsGroup = b.dataset.g;
    renderSettingsGroup(wrap);
  }));

  const search = $('#setSearch', wrap);
  search.value = state.settingsQuery;
  search.addEventListener('input', debounce(() => {
    state.settingsQuery = search.value;
    filterSettings(wrap);
  }, 160));

  // Найдя раздел поиском, за ним обычно тянутся мышью. Стрелки и Enter
  // избавляют от этого: руки уже на клавиатуре.
  search.addEventListener('keydown', (e) => {
    const tabs = $$('.set-tab', wrap).filter((b) => !b.hidden);
    if (!tabs.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = tabs.findIndex((b) => b.classList.contains('marked'));
      const next = e.key === 'ArrowDown'
        ? (at + 1) % tabs.length
        : (at <= 0 ? tabs.length - 1 : at - 1);
      tabs.forEach((b, i) => b.classList.toggle('marked', i === next));
      tabs[next].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = tabs.find((b) => b.classList.contains('marked')) || tabs[0];
      state.settingsGroup = pick.dataset.g;
      renderSettingsGroup(wrap);
    }
  });

  setTimeout(async () => {
    renderSettingsGroup(wrap);
    if (state.settingsQuery) filterSettings(wrap);
    if (!state.settingsDefaults) state.settingsDefaults = await api.settings.defaults();
    paintSettingsDots(wrap);
  }, 0);
  return wrap;
};

/**
 * Точка у раздела, значения которого отличаются от поставочных. Разделов
 * десять, и по виду меню нельзя было понять, где человек что-то менял, а где
 * всё осталось как из коробки.
 *
 * Помечаем только группы со своим разделом настроек (у них есть reset):
 * "Тексты", "Цели" и "Оформление" - это части чужих разделов, и точка на них
 * означала бы неправду.
 */
function paintSettingsDots(root) {
  const defaults = state.settingsDefaults;
  if (!defaults) return;
  const box = root || $('.settings');
  if (!box) return;
  $$('.set-tab', box).forEach((b) => {
    const group = SETTINGS_GROUPS.find((g) => g.id === b.dataset.g);
    b.classList.toggle('changed', !!(group && group.reset && sectionChanged(defaults, group.reset)));
  });
}

/** Раздел отличается от поставочного? Сравниваем по ключам умолчаний: лишние
    поля в настройках изменением не считаем. */
function sectionChanged(defaults, key) {
  const base = defaults[key];
  const now = state.settings[key];
  if (!base || typeof base !== 'object') return false;
  return Object.keys(base).some((k) => JSON.stringify(base[k]) !== JSON.stringify(now && now[k]));
}

/**
 * Поиск по настройкам. Прячет непопавшие группы и подсвечивает найденные поля в
 * открытой карточке. Совпадение ищем подстрокой, без RegExp: запрос вводит
 * человек, и звёздочка в нём не должна ронять поиск.
 */
function filterSettings(root) {
  const q = state.settingsQuery.trim().toLowerCase();
  const hit = (g) => !q || [t('set.g.' + g.id), t('set.h.' + g.id), t('set.s.' + g.id)]
    .concat((g.terms || []).map((k) => t(k)))
    .some((s) => String(s).toLowerCase().includes(q));

  const shown = SETTINGS_GROUPS.filter(hit);
  $$('.set-tab', root).forEach((b) => {
    b.hidden = !shown.some((g) => g.id === b.dataset.g);
    // Отметка стрелками относится к прошлому запросу - снимаем.
    b.classList.remove('marked');
  });
  // Подпись раздела без единой видимой группы только мешает.
  $$('.set-sec', root).forEach((sec) => {
    sec.hidden = !$$('.set-tab', sec).some((b) => !b.hidden);
  });
  const none = $('#setNoMatch', root);
  if (none) none.hidden = !!shown.length;
  // Сколько групп осталось. Без счётчика по короткому списку не видно, сузил
  // запрос выборку до одной группы или просто совпало.
  const count = $('#setCount', root);
  if (count) count.textContent = q ? shown.length + ' / ' + SETTINGS_GROUPS.length : '';

  // Открытая группа выпала из поиска - показываем первую найденную, иначе
  // справа осталась бы карточка, которой в списке уже нет.
  if (shown.length && !shown.some((g) => g.id === state.settingsGroup)) {
    state.settingsGroup = shown[0].id;
    renderSettingsGroup(root);
    return;
  }
  markSettingsHits(root, q);
}

/** Подсветка полей, подходящих под запрос, внутри открытой карточки. */
function markSettingsHits(root, q) {
  $$('.set-panel .field', root).forEach((field) => {
    const label = field.querySelector('label');
    const text = label ? label.textContent.toLowerCase() : '';
    field.classList.toggle('hit', !!q && text.includes(q));
  });
}

function renderSettingsGroup(root) {
  const group = SETTINGS_GROUPS.find((g) => g.id === state.settingsGroup) || SETTINGS_GROUPS[0];
  $$('.set-tab', root).forEach((b) => b.classList.toggle('active', b.dataset.g === group.id));

  // Панель превью привязана к редактору шаблона: карточку пересобираем -
  // убираем и её. Открытой она останется, если редактор попросит заново.
  dropArPreview();

  // Колонка настроек нарочно узкая: поле "Ключ API" во всю ширину экрана
  // читать неудобно. Редактору HTML это ограничение мешает, поэтому группа
  // может попросить всю ширину сама.
  const shell = root.classList && root.classList.contains('settings') ? root : $('.settings');
  if (shell) {
    shell.classList.toggle('wide', !!group.wide);
    shell.classList.remove('focus-editor');
  }

  const panel = root.querySelector('#setPanel');
  if (!panel) return;
  panel.innerHTML = '';
  const el = group.build();
  el.classList.add('view-enter');
  panel.appendChild(el);
  // Сброс раздела висит на карточке, а обработчик один на все группы: кнопка
  // одна и та же, отличается только имя раздела настроек.
  const resetBtn = $('[data-reset]', panel);
  if (resetBtn) resetBtn.addEventListener('click', () => resetSettingsSection(resetBtn.dataset.reset));
  wireRipples(panel);
  wireSheen(panel);
  markSettingsHits(root, state.settingsQuery.trim().toLowerCase());
}

/**
 * Вернуть раздел настроек к значениям по умолчанию. Значения берём из main
 * (DEFAULTS в store.js), своей копии в рендере нет - она бы разошлась с
 * настоящими значениями при первой же правке движка.
 */
async function resetSettingsSection(section) {
  const defaults = await api.settings.defaults();
  const value = defaults && defaults[section];
  if (!value) return;
  const ok = await askConfirm(t('set.resetTitle'), t('set.resetText'), { okLabel: t('set.reset') });
  if (!ok) return;
  await saveSection(section, value);
  toast(t('set.resetDone'), 'success');
  const root = $('.settings');
  if (root) renderSettingsGroup(root);
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

/**
 * Шапка карточки настроек: поясняющий заголовок, строка о том, на что группа
 * влияет, и кнопка сброса раздела. Название группы стоит в боковом меню и здесь
 * не повторяется - иначе одно и то же трижды на экране.
 */
function setCard(groupId, bodyHtml) {
  const group = SETTINGS_GROUPS.find((g) => g.id === groupId);
  return `<div class="card glass">
    <div class="set-card-head">
      <div class="sch-id">
        <h3>${esc(t('set.h.' + groupId))}</h3>
        <div class="sch-sub">${esc(t('set.s.' + groupId))}</div>
      </div>
      ${group && group.reset
        ? `<button class="btn ghost" data-reset="${group.reset}">${ICONS.reset}<span>${esc(t('set.reset'))}</span></button>`
        : ''}
    </div>
    ${bodyHtml}
  </div>`;
}

/**
 * Подраздел внутри карточки. Плоский список полей не показывал, что от чего
 * зависит: лимиты, темп отправки и очередь парсера жили в одной куче.
 */
function setBlock(titleKey, hintKey, bodyHtml) {
  return `<section class="set-block">
    <div class="section-label">${esc(t(titleKey))}</div>
    ${hintKey ? `<div class="hint sb-hint">${esc(t(hintKey))}</div>` : ''}
    ${bodyHtml}
  </section>`;
}

/**
 * Отметка "сохранено" у поля.
 *
 * Настройки пишутся сразу при вводе, без кнопки "Применить", и по виду экрана
 * понять, дошло ли значение до файла, было нельзя. Отметка живёт пару секунд и
 * пропадает сама.
 */
function markSaved(el) {
  const field = el && el.closest ? el.closest('.field') : null;
  const host = field && (field.querySelector('label') || field);
  if (!host) return;
  let mark = host.querySelector('.saved-mark');
  if (!mark) {
    mark = h(`<span class="saved-mark">${ICONS.check}<span>${esc(t('set.saved'))}</span></span>`);
    host.appendChild(mark);
  }
  // Перезапуск проявления: без перерисовки повторное сохранение не мигает.
  mark.classList.remove('show');
  void mark.offsetWidth;
  mark.classList.add('show');
  clearTimeout(savedTimers.get(mark));
  savedTimers.set(mark, setTimeout(() => mark.classList.remove('show'), 1800));
}
// Таймеры отметок держим отдельно от разметки: карточка настроек пересобирается,
// и вешать состояние на data-атрибуты значило бы возить его туда-обратно строкой.
const savedTimers = new WeakMap();

/** Текстовое поле настроек: пишем с задержкой и отмечаем сохранение. */
function bindText(input, section, key) {
  if (!input) return;
  input.addEventListener('input', debounce(async () => {
    await saveSection(section, { [key]: input.value });
    markSaved(input);
  }));
}

/** Переключатель настроек. */
function bindToggle(input, section, key) {
  if (!input) return;
  input.addEventListener('change', async () => {
    await saveSection(section, { [key]: input.checked });
    markSaved(input);
  });
}

/** Ряд кнопок-переключателей: значение берём из data-v. */
function bindSeg(box, section, key, cast) {
  if (!box) return;
  $$('button', box).forEach((b) => b.addEventListener('click', async () => {
    $$('button', box).forEach((x) => x.classList.toggle('active', x === b));
    const raw = b.dataset.v;
    await saveSection(section, { [key]: cast ? cast(raw) : raw });
    markSaved(box);
  }));
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
    ${setBlock('set.b.caps', 'set.limitsHint', `
      <div class="set-grid">
        <div class="field"><label for="mMails">${esc(t('set.mails'))}</label><input type="number" id="mMails" min="1" value="${s.mailsPerAccount}"/></div>
        <div class="field"><label for="mReplies">${esc(t('set.replies'))}</label><input type="number" id="mReplies" min="0" value="${s.maxRepliesPerDialog}"/></div>
      </div>`)}

    ${setBlock('set.b.pace', 'set.sendDelayHint', `
      <div class="set-grid">
        <div class="field"><label for="mDelay">${esc(t('set.sendDelay'))}</label><input type="number" id="mDelay" min="1" value="${s.sendDelaySec}"/></div>
        <div class="field"><label for="mCheck">${esc(t('set.checkInterval'))}</label><input type="number" id="mCheck" min="3" value="${s.checkIntervalSec}"/></div>
      </div>
      <div class="field">
        <label>${esc(t('set.waitScale'))}</label>
        <div class="seg" id="mWait">
          ${WAIT_SCALES.map((v) => `<button data-v="${v}" class="${Number(s.waitScale || 1) === v ? 'active' : ''}">${v}x</button>`).join('')}
        </div>
        <div class="hint field-hint">${esc(t('set.waitScaleHint'))}</div>
      </div>`)}`));
  // Минимумы обязательны. Пустое поле или ноль в "Писем на аккаунт" делали
  // прогон бессмысленным: движок не находил ни одного аккаунта под лимитом,
  // ничего не отправлял и писал в лог "все лимиты достигнуты".
  bindNumber($('#mMails', el), 'system', 'mailsPerAccount', 1);
  bindNumber($('#mReplies', el), 'system', 'maxRepliesPerDialog', 0);
  bindNumber($('#mDelay', el), 'system', 'sendDelaySec', 1);
  bindNumber($('#mCheck', el), 'system', 'checkIntervalSec', 3);
  // Терпение - готовые ступени, а не поле ввода: значение дробное, и вписать
  // туда ноль значило бы отменить все ожидания сразу.
  bindSeg($('#mWait', el), 'system', 'waitScale', Number);
  return el;
}

function buildSetParser() {
  const p = state.settings.parser;
  const s = state.settings.system;
  const el = h(setCard('parser', `
    ${setBlock('set.b.api', '', `
      <div class="set-grid">
        <div class="field"><label for="pKey">${esc(t('parser.apiKey'))}</label><input type="password" id="pKey" value="${esc(p.apiKey)}" placeholder="${esc(t('parser.apiKeyPh'))}"/></div>
        <div class="field"><label>${esc(t('parser.type'))}</label>
          <div class="seg" id="pType">
            <button data-v="xproject" class="${p.apiType === 'xproject' ? 'active' : ''}">xproject</button>
            <button data-v="vvs" class="${p.apiType === 'vvs' ? 'active' : ''}">vvs</button>
          </div>
        </div>
      </div>
      <div class="field"><label class="switch"><input type="checkbox" id="pEnabled" ${p.enabled ? 'checked' : ''}/><span class="track"></span><span class="lbl">${esc(t('parser.enabled'))}</span></label></div>
      <div class="field"><label class="switch"><input type="checkbox" id="pAi" ${p.aiTemplateSwap ? 'checked' : ''}/><span class="track"></span><span class="lbl">${esc(t('parser.aiSwap'))}</span></label></div>
      <div class="field" style="max-width:340px"><label for="pSwapN">${esc(t('parser.swapN'))}</label><input type="number" id="pSwapN" min="0" value="${p.swapKeyEveryN}"/></div>`)}

    ${setBlock('set.b.queue', 'set.queueHint', `
      <div class="set-grid">
        <div class="field"><label for="mBatch">${esc(t('set.batch'))}</label><input type="number" id="mBatch" min="1" value="${s.parserBatchSize}"/></div>
        <div class="field"><label for="mThresh">${esc(t('set.threshold'))}</label><input type="number" id="mThresh" min="0" value="${s.queueRefillThreshold}"/></div>
      </div>`)}

    <div class="hint">${esc(t('parser.platformsHint'))} <a href="#" id="pToTargets">${esc(t('set.g.targets'))}</a>.</div>`));

  bindText($('#pKey', el), 'parser', 'apiKey');
  bindSeg($('#pType', el), 'parser', 'apiType');
  bindToggle($('#pEnabled', el), 'parser', 'enabled');
  bindToggle($('#pAi', el), 'parser', 'aiTemplateSwap');
  bindNumber($('#pSwapN', el), 'parser', 'swapKeyEveryN', 0);
  // Размер пачки и порог пополнения живут в разделе system, но настраивают они
  // именно парсер - поэтому стоят здесь, а не в лимитах рассылки.
  bindNumber($('#mBatch', el), 'system', 'parserBatchSize', 1);
  bindNumber($('#mThresh', el), 'system', 'queueRefillThreshold', 1);
  $('#pToTargets', el).addEventListener('click', (e) => { e.preventDefault(); goSettings('targets'); });
  return el;
}

function buildSetTargets() {
  const el = h(setCard('targets', `
    <div class="tg-current" id="tgCurrent"></div>
    <div class="ar-acts" style="margin-top:16px">
      <button class="btn primary" id="tgEdit">${ICONS.target}<span>${esc(t('targets.change'))}</span></button>
    </div>`));
  paintTargetSummary($('#tgCurrent', el));
  $('#tgEdit', el).addEventListener('click', () => openTargetsModal());
  return el;
}

/** Что сейчас выбрано: площадка с логотипом и её страны. */
function paintTargetSummary(box) {
  if (!box) return;
  const { platform, countries } = currentTarget();
  // Пересобираем только при смене цели: в центре управления этот блок
  // перерисовывается каждый такт опроса, и логотип грузился бы заново.
  const sign = platform.id + '|' + countries.join(',');
  if (box.dataset.sign === sign) return;
  box.dataset.sign = sign;
  box.innerHTML = '';
  const row = h(`<div class="tg-sum">
    <span class="tg-sum-id">
      <span class="tg-name">${esc(platform.label)}</span>
      <span class="tg-note">${esc(t('platform.' + platform.id + '.note'))}</span>
    </span>
  </div>`);
  row.prepend(platformAvatar(platform));
  box.appendChild(row);

  const list = h(`<div class="tg-sum-countries"></div>`);
  if (!countries.length) {
    list.appendChild(h(`<span class="hint">${esc(t('targets.noCountry'))}</span>`));
  } else {
    for (const c of countries) list.appendChild(h(`<span class="tg-flag">${esc(t('country.' + c))}</span>`));
  }
  box.appendChild(list);
}

/**
 * Аватарка площадки.
 *
 * Монограмма в цвете площадки - основа, логотип подставляется поверх, если
 * файл positions platforms/<id>.svg положен рядом с интерфейсом. Картинку
 * вставляем только после успешной загрузки: так отсутствие файла ничего не
 * ломает и не мигает битым значком, а обработчик события пишется кодом -
 * inline-атрибут onerror запрещён политикой безопасности.
 */
function platformAvatar(p) {
  const el = h(`<span class="pf-avatar" style="--pf:${p.color}">${esc(p.label.charAt(0))}</span>`);
  const img = new Image();
  img.className = 'pf-logo';
  img.alt = '';
  img.addEventListener('load', () => el.appendChild(img));
  img.src = 'platforms/' + encodeURIComponent(p.id) + '.svg';
  return el;
}

/**
 * Выбор цели рассылки.
 *
 * Площадка одна: оба парсера принимают ровно одну за вызов, и мультивыбор
 * означал бы обещание, которого движок не выполняет. Стран у всемирной
 * площадки можно отметить сколько угодно - клиенты обходят их по очереди.
 */
function openTargetsModal() {
  const cur = currentTarget();
  let pickedId = cur.platform.id;
  let picked = cur.countries.slice();
  if (!picked.length) picked = [cur.platform.countries[0]];

  return modal(
    `<h3>${esc(t('targets.title'))}</h3>
     <div class="hint" style="margin-top:-6px">${esc(t('targets.modalSub'))}</div>
     <div class="tg-groups" id="tgGroups"></div>
     <div class="tg-countries" id="tgCountries"></div>
     <div class="modal-actions">
       <button class="btn" id="tgCancel">${esc(t('common.cancel'))}</button>
       <button class="btn primary" id="tgSave">${esc(t('common.ok'))}</button>
     </div>`,
    (overlay, done) => {
      overlay.firstElementChild.classList.add('wide');
      const groups = $('#tgGroups', overlay);
      const box = $('#tgCountries', overlay);
      const save = $('#tgSave', overlay);

      const paintCountries = () => {
        const p = platformById(pickedId);
        // У площадки одной страны выбирать нечего - блок только мешал бы.
        if (p.countries.length < 2) { box.innerHTML = ''; save.disabled = false; return; }
        box.innerHTML = `
          <div class="tg-c-head">
            <div class="section-label">${esc(t('targets.countries'))}</div>
            <button class="btn ghost" data-all="1">${esc(t('targets.selectAll'))}</button>
            <button class="btn ghost" data-none="1">${esc(t('targets.selectNone'))}</button>
          </div>
          <div class="tg-c-grid">
            ${p.countries.map((c) => `<button class="tg-c ${picked.includes(c) ? 'on' : ''}" data-c="${c}">
              <span class="tg-c-box">${picked.includes(c) ? ICONS.check : ''}</span>
              <span>${esc(t('country.' + c))}</span>
            </button>`).join('')}
          </div>
          <div class="hint tg-c-note">${esc(t('targets.countriesHint'))}</div>`;
        $$('.tg-c', box).forEach((b) => b.addEventListener('click', () => {
          const c = b.dataset.c;
          const at = picked.indexOf(c);
          if (at === -1) picked.push(c); else picked.splice(at, 1);
          paintCountries();
        }));
        $('[data-all]', box).addEventListener('click', () => { picked = p.countries.slice(); paintCountries(); });
        $('[data-none]', box).addEventListener('click', () => { picked = []; paintCountries(); });
        // Без единой страны запрос отправлять некуда.
        save.disabled = !picked.length;
      };

      const paintGroups = () => {
        groups.innerHTML = PLATFORM_GROUPS.map((g) => `
          <div class="tg-group">
            <div class="section-label">${esc(t('targets.group.' + g))}</div>
            <div class="tg-cards">
              ${PLATFORMS.filter((p) => p.group === g).map((p) => `
                <button class="tg-card ${p.id === pickedId ? 'on' : ''}" data-p="${p.id}">
                  <span class="tg-card-av" data-av="${p.id}"></span>
                  <span class="tg-card-id">
                    <span class="tg-name">${esc(p.label)}</span>
                    <span class="tg-note">${esc(t('platform.' + p.id + '.note'))}</span>
                    <span class="tg-note">${esc(p.countries.length > 1
                      ? t('targets.nCountries', { n: p.countries.length })
                      : t('country.' + p.countries[0]))}</span>
                  </span>
                  <span class="tg-mark">${p.id === pickedId ? ICONS.check : ''}</span>
                </button>`).join('')}
            </div>
          </div>`).join('');
        // Аватарки собираем кодом: внутри лежит картинка с обработчиком загрузки.
        $$('[data-av]', groups).forEach((slot) => slot.appendChild(platformAvatar(platformById(slot.dataset.av))));
        $$('.tg-card', groups).forEach((b) => b.addEventListener('click', () => {
          if (b.dataset.p === pickedId) return;
          pickedId = b.dataset.p;
          const p = platformById(pickedId);
          // Со сменой площадки оставляем те страны, которые она умеет; если не
          // осталось ни одной - первую из её списка, чтобы цель не стала пустой.
          picked = picked.filter((c) => p.countries.includes(c));
          if (!picked.length) picked = [p.countries[0]];
          paintGroups();
          paintCountries();
        }));
      };

      paintGroups();
      paintCountries();
      wireRipples(overlay);

      $('#tgCancel', overlay).addEventListener('click', () => done(null));
      save.addEventListener('click', async () => {
        await saveSection('parser', { platform: pickedId, countries: picked });
        toast(t('targets.saved'), 'success');
        const root = $('.settings');
        if (root) renderSettingsGroup(root);
        done(true);
      });
    },
  );
}

function buildSetCdp() {
  const c = state.settings.cdp;
  const el = h(setCard('cdp', `
    ${setBlock('set.b.chrome', 'set.chromeHint', `
      <div class="field"><label for="cPath">${esc(t('cdp.path'))}</label><input type="text" id="cPath" value="${esc(c.chromePath)}" placeholder="${esc(t('cdp.pathPh'))}"/></div>
      <button class="btn" id="cDetect">${ICONS.search}<span>${esc(t('cdp.detect'))}</span></button>
      <div class="hint" id="cDetected" style="margin-top:12px"></div>`)}

    ${setBlock('set.b.ports', 'set.portsHint', `
      <div class="set-grid">
        <div class="field"><label for="cStart">${esc(t('cdp.portStart'))}</label><input type="number" id="cStart" value="${c.portStart}"/></div>
        <div class="field"><label for="cEnd">${esc(t('cdp.portEnd'))}</label><input type="number" id="cEnd" value="${c.portEnd}"/></div>
      </div>`)}`));
  bindNumber($('#cStart', el), 'cdp', 'portStart', 1024);
  bindNumber($('#cEnd', el), 'cdp', 'portEnd', 1024);
  bindText($('#cPath', el), 'cdp', 'chromePath');
  $('#cDetect', el).addEventListener('click', async () => {
    const found = await api.cdp.detectChrome();
    $('#cDetected', el).textContent = found ? t('cdp.found', { path: found }) : t('cdp.notFound');
  });
  return el;
}

function buildSetLink() {
  const l = state.settings.link;
  const el = h(setCard('link', `
    ${setBlock('set.b.api', '', `
      <div class="set-grid">
        <div class="field"><label for="lKey">${esc(t('link.apiKey'))}</label><input type="password" id="lKey" value="${esc(l.apiKey)}"/></div>
        <div class="field"><label for="lTeam">${esc(t('link.team'))}</label>
          <select id="lTeam"><option value="haron_rent" ${l.team === 'haron_rent' ? 'selected' : ''}>Haron Rent</option></select>
        </div>
      </div>`)}

    ${setBlock('set.b.linkParams', 'link.hint', `
      <div class="set-grid">
        <div class="field"><label for="lMode">${esc(t('link.mode'))}</label><input type="text" id="lMode" value="${esc(l.mode)}" placeholder="${esc(t('link.modePh'))}"/></div>
        <div class="field"><label for="lPid">${esc(t('link.profileId'))}</label><input type="text" id="lPid" value="${esc(l.profileId)}"/></div>
        <div class="field"><label for="lCountry">${esc(t('link.country'))}</label>
          <select id="lCountry"><option value="US" ${l.country === 'US' ? 'selected' : ''}>US</option></select>
        </div>
      </div>`)}`));
  bindText($('#lKey', el), 'link', 'apiKey');
  bindText($('#lMode', el), 'link', 'mode');
  bindText($('#lPid', el), 'link', 'profileId');
  $('#lTeam', el).addEventListener('change', async (e) => {
    await saveSection('link', { team: e.target.value });
    markSaved(e.target);
  });
  $('#lCountry', el).addEventListener('change', async (e) => {
    await saveSection('link', { country: e.target.value });
    markSaved(e.target);
  });
  return el;
}

function buildSetTelegram() {
  const tg = state.settings.telegram;
  const el = h(setCard('telegram', `
    ${setBlock('set.b.bot', 'set.tgHint', `
      <div class="set-grid">
        <div class="field"><label for="tToken">${esc(t('tg.token'))}</label><input type="password" id="tToken" value="${esc(tg.botToken)}"/></div>
        <div class="field"><label for="tId">${esc(t('tg.chatId'))}</label><input type="text" id="tId" value="${esc(tg.botId)}"/></div>
      </div>
      <button class="btn" id="tTest">${ICONS.send}<span>${esc(t('tg.test'))}</span></button>
      <div class="hint" id="tResult" style="margin-top:12px"></div>`)}`));
  bindText($('#tToken', el), 'telegram', 'botToken');
  bindText($('#tId', el), 'telegram', 'botId');
  $('#tTest', el).addEventListener('click', async () => {
    const res = await api.telegram.test($('#tToken', el).value);
    $('#tResult', el).textContent = res && res.ok
      ? t('tg.ok', { username: (res.result && res.result.username) || 'bot' })
      : t('tg.fail');
  });
  return el;
}

// ── Авто-ответ: обычный текст или HTML ─────────────────────────────
// Текстом отвечает вариант из PASTE_DICT (см. раздел текстов), HTML - один
// шаблон отсюда. Шаблон верстается руками, поэтому набора вариантов у него нет.

// Плейсхолдеры шаблона. Порядок не случайный: картинка и ссылка нужны почти
// всегда, остальное по вкусу.
const HTML_SLOTS = ['{image_url}', '{link}', '{title}', '{price}', '{seller_username}', '{ad_url}', '{date}'];

function buildSetAutoReply() {
  const ar = state.settings.autoReply || { mode: 'text', html: '' };
  const html = ar.mode === 'html';
  const el = h(setCard('autoreply', `
    ${setBlock('set.b.mode', 'set.arModeHint', `
      <div class="field" style="max-width:320px">
        <label>${esc(t('ar.mode'))}</label>
        <div class="seg" id="arMode">
          <button data-v="text" class="${html ? '' : 'active'}">${esc(t('ar.modeText'))}</button>
          <button data-v="html" class="${html ? 'active' : ''}">${esc(t('ar.modeHtml'))}</button>
        </div>
      </div>`)}
    ${html ? setBlock('set.b.template', 'set.arTplHint', `
      <div class="ar-acts">
        <button class="btn ghost" id="arPreview">${ICONS.eye}<span>${esc(t('ar.previewToggle'))}</span></button>
        <button class="btn ghost" id="arBig">${ICONS.image}<span>${esc(t('ar.big'))}</span></button>
        <button class="btn ghost" id="arSample">${ICONS.reset}<span>${esc(t('ar.sample'))}</span></button>
        <span class="grow"></span>
        <button class="btn ghost icon-only" id="arFocus" title="${esc(t('ar.focus'))}">${ICONS.expand}</button>
      </div>
      <div class="ar-slots tl-slots">
        ${HTML_SLOTS.map((s) => `<button class="slot-btn" data-slot="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>
      <div class="ar-code">
        <div class="ar-gutter" id="arGutter" aria-hidden="true"></div>
        <textarea id="arHtml" class="ar-area" spellcheck="false" wrap="off"
          aria-label="${esc(t('set.b.template'))}">${esc(ar.html || '')}</textarea>
      </div>
      <div class="ar-status">
        <span id="arPos"></span>
        <span id="arLines"></span>
        <span id="arSize"></span>
        <span class="grow"></span>
        <span id="arSaveHint">${esc(t('ar.saveHint'))}</span>
      </div>
      <div class="txt-issues" id="arIssues"></div>`) : ''}`));

  // Смена вида перерисовывает карточку: редактор нужен только в режиме HTML.
  // Перерисовываем ПОСЛЕ сохранения, иначе карточка соберётся по старому
  // значению - настройка уходит в main через IPC и возвращается не сразу.
  $$('#arMode button', el).forEach((b) => b.addEventListener('click', async () => {
    $$('#arMode button', el).forEach((x) => x.classList.toggle('active', x === b));
    await saveSection('autoReply', { mode: b.dataset.v });
    renderSettingsGroup($('.settings'));
  }));
  if (html) wireAutoReplyEditor(el);
  return el;
}

/**
 * Редактор шаблона.
 *
 * Превью больше не делит место с кодом: письмо на 600 px и HTML-таблица рядом
 * не помещались ни во что читаемое. Письмо ушло в выезжающую панель, а редактор
 * забрал всю ширину карточки и получил колонку номеров строк - без них найти
 * место по сообщению об ошибке в шаблоне было нечем.
 */
function wireAutoReplyEditor(el) {
  const area = $('#arHtml', el);
  const gutter = $('#arGutter', el);
  // Панель превью переживает перерисовку статуса, поэтому берёт текст функцией,
  // а не значением на момент открытия.
  const currentHtml = () => area.value;

  let lineCount = -1;
  let curLine = -1;

  const paintGutter = () => {
    const n = area.value.split('\n').length;
    if (n !== lineCount) {
      lineCount = n;
      curLine = -1;
      let out = '';
      for (let i = 1; i <= n; i++) out += '<span>' + i + '</span>';
      gutter.innerHTML = out;
    }
    // Подсветку строки под курсором двигаем точечно: перебирать сотни номеров
    // на каждое нажатие клавиши незачем.
    const at = area.value.slice(0, area.selectionStart).split('\n').length - 1;
    if (at !== curLine) {
      const prev = gutter.children[curLine];
      if (prev) prev.classList.remove('cur');
      const now = gutter.children[at];
      if (now) now.classList.add('cur');
      curLine = at;
    }
    gutter.scrollTop = area.scrollTop;
  };

  const paintStatus = () => {
    const before = area.value.slice(0, area.selectionStart).split('\n');
    const pos = $('#arPos', el);
    const lines = $('#arLines', el);
    const size = $('#arSize', el);
    if (pos) pos.textContent = t('ar.pos', { line: before.length, col: before[before.length - 1].length + 1 });
    if (lines) lines.textContent = t('ar.lines', { n: area.value.split('\n').length });
    // Размер в килобайтах, а не в символах: письмо режется по байтам, и
    // кириллица в шаблоне весит вдвое больше латиницы.
    if (size) size.textContent = t('ar.size', { n: (new Blob([area.value]).size / 1024).toFixed(1) });
  };

  const paintChrome = () => { paintGutter(); paintStatus(); };

  const repaint = () => {
    paintAutoReplyIssues($('#arIssues', el), area.value);
    repaintArPreview();
  };

  const save = async () => {
    await saveSection('autoReply', { html: area.value });
    const hint = $('#arSaveHint', el);
    if (hint) {
      hint.textContent = t('set.saved');
      hint.classList.add('ok');
      clearTimeout(hint._t);
      hint._t = setTimeout(() => {
        hint.textContent = t('ar.saveHint');
        hint.classList.remove('ok');
      }, 1800);
    }
  };

  const saveLater = debounce(() => { save(); repaint(); }, 260);

  area.addEventListener('input', () => { paintChrome(); saveLater(); });
  area.addEventListener('keyup', paintChrome);
  area.addEventListener('click', paintChrome);
  area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });

  area.addEventListener('keydown', async (e) => {
    // Tab в шаблоне нужен как отступ: уводить им фокус на следующую кнопку
    // в редакторе кода бессмысленно.
    if (e.key === 'Tab') {
      e.preventDefault();
      insertAtCursor(area, '  ');
      return;
    }
    // Сохранение отложенное, и момент записи по виду экрана не читался.
    // Ctrl+S записывает сразу и говорит об этом.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      await save();
      repaint();
      toast(t('ar.saved'), 'success');
    }
  });

  // Плейсхолдер вставляем в место курсора - дописывать его в конец шаблона
  // почти всегда не то, что нужно.
  $$('.slot-btn', el).forEach((b) => b.addEventListener('click', () => {
    insertAtCursor(area, b.dataset.slot);
  }));

  $('#arSample', el).addEventListener('click', async () => {
    const sample = await api.autoReply.defaultHtml();
    area.value = sample;
    await save();
    paintChrome();
    toast(t('ar.sampleDone'), 'success');
    repaint();
  });

  $('#arBig', el).addEventListener('click', async () => {
    const res = await api.autoReply.preview(area.value);
    openHtmlPreview(res && res.html);
  });

  const previewBtn = $('#arPreview', el);
  previewBtn.addEventListener('click', async () => {
    if (drawerView && drawerView.kind === 'arPreview') { setDrawerOpen(false); return; }
    previewBtn.classList.add('on');
    await saveSection('ui', { arPreviewOpen: true });
    openArPreviewDrawer(currentHtml);
  });

  // Редактор во весь экран: меню разделов уезжает, код занимает рабочую область.
  // Состояние временное - при следующем заходе настройки открываются как обычно.
  const focusBtn = $('#arFocus', el);
  focusBtn.addEventListener('click', () => {
    const shell = $('.settings');
    if (!shell) return;
    const on = shell.classList.toggle('focus-editor');
    focusBtn.innerHTML = on ? ICONS.collapse : ICONS.expand;
    focusBtn.title = on ? t('ar.focusOff') : t('ar.focus');
  });

  if ((state.settings.ui || {}).arPreviewOpen) {
    previewBtn.classList.add('on');
    openArPreviewDrawer(currentHtml);
  }

  // Пустой шаблон означает "взять образец" (см. htmlTemplate.js). Оставить при
  // этом пустой редактор рядом с непустым превью нельзя - непонятно, что уйдёт
  // продавцу. Поэтому образец сразу подставляем и в поле, и в настройки.
  if (!area.value.trim()) {
    api.autoReply.defaultHtml().then(async (sample) => {
      area.value = sample;
      await saveSection('autoReply', { html: sample });
      paintChrome();
      repaint();
    });
    return;
  }
  paintChrome();
  repaint();
}

/** Вставка в место курсора с сохранением истории отмены и события input. */
function insertAtCursor(area, text) {
  const at = area.selectionStart;
  area.value = area.value.slice(0, at) + text + area.value.slice(area.selectionEnd);
  area.focus();
  area.setSelectionRange(at + text.length, at + text.length);
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Панель превью письма ───────────────────────────────────────────
// Содержимое перерисовываем точечно, не пересобирая панель: иначе iframe
// пересоздавался бы на каждое нажатие клавиши и письмо мигало.
let arPreviewSource = null;

function openArPreviewDrawer(getHtml) {
  arPreviewSource = getHtml;
  openDrawer({
    kind: 'arPreview',
    wide: true,
    dock: true,
    title: t('ar.preview'),
    build: (body) => {
      const device = (state.settings.ui || {}).arPreviewDevice === 'mobile' ? 'mobile' : 'desktop';
      body.innerHTML = `
        <div class="seg ar-device" id="arDevice">
          <button data-v="desktop" class="${device === 'desktop' ? 'active' : ''}">${ICONS.monitor}<span>${esc(t('ar.deviceDesktop'))}</span></button>
          <button data-v="mobile" class="${device === 'mobile' ? 'active' : ''}">${ICONS.mobile}<span>${esc(t('ar.deviceMobile'))}</span></button>
        </div>
        <div class="hint ar-src" id="arSource"></div>
        <div class="ar-stage" data-device="${device}">
          <iframe id="arFrame" class="ar-frame" title="${esc(t('ar.preview'))}"></iframe>
        </div>`;
      $$('#arDevice button', body).forEach((b) => b.addEventListener('click', async () => {
        $$('#arDevice button', body).forEach((x) => x.classList.toggle('active', x === b));
        $('.ar-stage', body).dataset.device = b.dataset.v;
        await saveSection('ui', { arPreviewDevice: b.dataset.v });
      }));
      repaintArPreview();
    },
    onClose: () => {
      arPreviewSource = null;
      const btn = $('#arPreview');
      if (btn) btn.classList.remove('on');
      saveSection('ui', { arPreviewOpen: false });
    },
  });
}

async function repaintArPreview() {
  const frame = $('#arFrame');
  if (!frame || !arPreviewSource) return;
  const res = await api.autoReply.preview(arPreviewSource());
  paintHtmlPreview(frame, res && res.html);
  const src = $('#arSource');
  if (src) {
    src.textContent = res && res.source === 'contact'
      ? t('ar.previewContact', { title: shorten(res.title || dash, 40) })
      : t('ar.previewDemo');
  }
}

/**
 * Убрать панель превью, не трогая сохранённый выбор "панель открыта": её
 * закрывает уход с экрана, а не человек, и вернувшись он ждёт её на месте.
 */
function dropArPreview() {
  if (!drawerView || drawerView.kind !== 'arPreview') return;
  drawerView.onClose = null;
  setDrawerOpen(false);
  arPreviewSource = null;
}

/**
 * Письмо в превью.
 *
 * Пишем в iframe без адреса (about:blank): такой документ наследует политику
 * безопасности приложения, поэтому скрипт внутри шаблона всё равно не запустится
 * (script-src 'self'), а картинки по https загрузятся. Стили письма при этом
 * остаются внутри рамки и на интерфейс не влияют.
 */
function paintHtmlPreview(frame, html) {
  if (!frame) return;
  let doc = frame.contentDocument;
  // Клик по ссылке в письме мог увести рамку на настоящий адрес: CSP его
  // резал, и на месте превью оставался пустой кадр, который сам не
  // восстанавливался. Такую рамку возвращаем на about:blank и рисуем заново.
  if (!doc || !doc.body) {
    frame.src = 'about:blank';
    setTimeout(() => paintHtmlPreview(frame, html), 60);
    return;
  }
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8">'
    + '<style>html,body{margin:0}body{padding:16px;background:#ffffff;'
    + 'font-family:Arial,Helvetica,sans-serif;color:#202124}img{max-width:100%}'
    + 'a{cursor:default}</style>'
    + '</head><body>' + String(html == null ? '' : html) + '</body></html>');
  doc.close();

  // Превью - картинка письма, а не рабочая страница: ссылка в нём ведёт на
  // боевой адрес подтверждения, и открывать его из редактора шаблона нельзя.
  // Гасим переход и вместо него показываем, куда ссылка ведёт - при проверке
  // шаблона это как раз то, что нужно увидеть.
  doc = frame.contentDocument;
  if (!doc) return;
  doc.addEventListener('click', (e) => {
    const link = e.target && e.target.closest ? e.target.closest('a') : null;
    e.preventDefault();
    if (!link) return;
    const href = link.getAttribute('href') || '';
    toast(href ? t('ar.linkTo', { url: shorten(href, 60) }) : t('ar.linkNone'));
  });
}

/** Письмо крупно, в модалке - в колонке редактора вёрстку на 600 px не видно. */
function openHtmlPreview(html) {
  return modal(
    `<h3>${esc(t('ar.preview'))}</h3>
     <iframe class="ar-frame big" id="arBigFrame" title="${esc(t('ar.preview'))}"></iframe>
     <div class="modal-actions">
       <button class="btn" id="arBigClose">${esc(t('common.close'))}</button>
     </div>`,
    (overlay, done) => {
      paintHtmlPreview($('#arBigFrame', overlay), html);
      $('#arBigClose', overlay).addEventListener('click', () => done(null));
    },
  );
}

/**
 * Замечания по шаблону. Не правим его молча: это ручная вёрстка, и хозяин
 * шаблона должен сам решить, что с ней делать. Скрипты и обработчики Gmail всё
 * равно вырежет.
 */
function paintAutoReplyIssues(box, tpl) {
  if (!box) return;
  const s = String(tpl || '');
  const rows = [];
  if (/<script/i.test(s)) rows.push(['bad', t('ar.warnScript')]);
  if (/\son[a-z]+\s*=/i.test(s)) rows.push(['warn', t('ar.warnHandlers')]);
  if (!/\{link\}/.test(s)) rows.push(['warn', t('ar.warnNoLink')]);
  if (!/\{image_url\}/.test(s)) rows.push(['info', t('ar.warnNoImage')]);
  if (!rows.length) rows.push(['ok', t('ar.allGood')]);
  box.innerHTML = rows.map(([kind, text]) => {
    const icon = kind === 'ok' ? ICONS.check : (kind === 'info' ? ICONS.link : ICONS.alert);
    return `<div class="issue ${kind}">${icon}<span>${esc(text)}</span></div>`;
  }).join('');
}

// ── Тексты рассылки ────────────────────────────────────────────────
// Три словаря, каждый разбит по языку (см. src/main/texts.js). Раньше здесь
// была голая textarea с JSON: понять, что куда уходит и что вообще загружено,
// было невозможно. Теперь загруженное показывается как есть - по словарям,
// языкам и вариантам.

const TEXT_DICTS = [
  { id: 'MESSAGES_DICT', icon: 'send', key: 'first' },
  { id: 'PASTE_DICT', icon: 'chat', key: 'reply' },
  { id: 'CONFIRM_DICT', icon: 'target', key: 'nudge' },
];

// Плейсхолдеры, которые понимает fillPlaceholders в src/main/texts.js.
const TEXT_SLOTS = ['{link}', '{title}', '{price}', '{seller_username}', '{image_url}', '{date}', '{ad_url}'];

/**
 * Проверка формата. Возвращает список замечаний, а не бросает исключение:
 * показать сразу все проблемы полезнее, чем первую попавшуюся.
 */
function validateTexts(json) {
  const errors = [];
  const warns = [];
  const infos = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { errors: [t('txt.errRoot')], warns, infos };
  }
  for (const d of TEXT_DICTS) {
    const dict = json[d.id];
    if (dict === undefined) { errors.push(t('txt.errNoDict', { dict: d.id })); continue; }
    if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
      errors.push(t('txt.errDictShape', { dict: d.id }));
      continue;
    }
    const langs = Object.keys(dict);
    if (!langs.length) { errors.push(t('txt.errDictEmpty', { dict: d.id })); continue; }
    for (const lang of langs) {
      const arr = dict[lang];
      if (!Array.isArray(arr)) { errors.push(t('txt.errLangShape', { dict: d.id, lang })); continue; }
      if (!arr.length) { warns.push(t('txt.warnLangEmpty', { dict: d.id, lang })); continue; }
      if (arr.some((s) => typeof s !== 'string')) errors.push(t('txt.errNotString', { dict: d.id, lang }));
      if (arr.some((s) => typeof s === 'string' && !s.trim())) warns.push(t('txt.warnBlank', { dict: d.id, lang }));
    }
    // Где ссылка встанет сама, а где допишется с новой строки. Это не ошибка -
    // движок допишет её в любом случае (см. withLink в texts.js), - поэтому
    // говорим спокойно и одной строкой на словарь, а не на каждый язык.
    if (d.id !== 'MESSAGES_DICT') {
      let n = 0;
      const where = [];
      for (const lang of langs) {
        const arr = Array.isArray(dict[lang]) ? dict[lang] : [];
        const bad = arr.filter((s) => typeof s === 'string' && !/\{link\}/.test(s) && !/(link|lien|enlace)\s*:\s*$/i.test(s.trimEnd()));
        if (bad.length) { n += bad.length; where.push(lang.toUpperCase()); }
      }
      if (n) infos.push(t('txt.infoNoLink', { dict: d.id, n, langs: where.join(', ') }));
    }
  }
  return { errors, warns, infos };
}

/** Языки, встречающиеся хотя бы в одном словаре. */
function textLangs(json) {
  const set = new Set();
  for (const d of TEXT_DICTS) {
    const dict = (json && json[d.id]) || {};
    Object.keys(dict).forEach((l) => set.add(l));
  }
  return [...set].sort();
}

function buildSetTexts() {
  const loaded = state.settings.texts;
  const el = h(setCard('texts', `<div id="txtBody"></div>`));
  renderTextsBody($('#txtBody', el), loaded);
  return el;
}

function renderTextsBody(box, loaded) {
  if (!box) return;
  if (!loaded) { renderTextsEmpty(box); return; }
  renderTextsView(box, loaded);
}

/** Пусто: объясняем формат и даём два пути - файл или вставка. */
function renderTextsEmpty(box) {
  box.innerHTML = `
    <div class="txt-drop">
      ${ICONS.inbox}
      <div class="txt-drop-title">${esc(t('txt.emptyTitle'))}</div>
      <div class="hint" style="max-width:46ch">${esc(t('txt.emptySub'))}</div>
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;justify-content:center">
        <button class="btn primary" id="txtOpen">${ICONS.image}<span>${esc(t('txt.openFile'))}</span></button>
        <button class="btn" id="txtPaste">${ICONS.parser}<span>${esc(t('txt.paste'))}</span></button>
      </div>
    </div>
    <div class="txt-schema">
      <div class="section-label">${esc(t('txt.schemaTitle'))}</div>
      ${TEXT_DICTS.map((d) => `<div class="schema-row">
        <span class="sk">${esc(d.id)}</span>
        <span class="sv">${esc(t('txt.d.' + d.key))}</span>
      </div>`).join('')}
    </div>`;
  $('#txtOpen', box).addEventListener('click', () => openTextsFile());
  $('#txtPaste', box).addEventListener('click', () => openTextsEditor(''));
  wireRipples(box);
}

/** Загружено: словари, языки, варианты. */
function renderTextsView(box, loaded) {
  const langs = textLangs(loaded);
  const active = langs.includes(state.textsLang) ? state.textsLang : (langs[0] || 'en');
  state.textsLang = active;
  const outreach = state.settings.system.outreachLang || 'en';
  const check = validateTexts(loaded);

  const total = TEXT_DICTS.reduce((n, d) => {
    const dict = loaded[d.id] || {};
    return n + Object.values(dict).reduce((m, arr) => m + (Array.isArray(arr) ? arr.length : 0), 0);
  }, 0);

  box.innerHTML = `
    <div class="txt-head">
      <div class="txt-sum">
        <span class="s"><b>${total}</b>${esc(t('txt.variants'))}</span>
        <span class="s"><b>${langs.length}</b>${esc(t('txt.langs'))}</span>
      </div>
      <div class="txt-acts">
        <button class="btn ghost" id="txtOpen2">${ICONS.image}<span>${esc(t('txt.replace'))}</span></button>
        <button class="btn ghost" id="txtEdit">${ICONS.parser}<span>${esc(t('txt.editJson'))}</span></button>
        <button class="btn ghost" id="txtSave">${ICONS.reset}<span>${esc(t('txt.export'))}</span></button>
      </div>
    </div>

    <div class="txt-issues">
      ${check.errors.map((m) => `<div class="issue bad">${ICONS.alert}<span>${esc(m)}</span></div>`).join('')}
      ${check.warns.map((m) => `<div class="issue warn">${ICONS.alert}<span>${esc(m)}</span></div>`).join('')}
      ${!check.errors.length && !check.warns.length ? `<div class="issue ok">${ICONS.check}<span>${esc(t('txt.allGood'))}</span></div>` : ''}
      ${check.infos.map((m) => `<div class="issue info">${ICONS.link}<span>${esc(m)}</span></div>`).join('')}
    </div>

    <div class="filter-row" style="margin-top:14px">
      <div class="seg filters" id="txtLangs">
        ${langs.map((l) => `<button data-v="${esc(l)}" class="${l === active ? 'active' : ''}">
          ${esc(l.toUpperCase())}${l === outreach ? '<span class="count">' + esc(t('txt.inUse')) + '</span>' : ''}
        </button>`).join('')}
      </div>
      <span class="spacer"></span>
      <label class="switch"><span class="lbl" style="color:var(--text-faint);font-size:11.5px">${esc(t('txt.outreachLang'))}</span></label>
      <select id="txtOutreach" style="width:auto;min-width:92px">
        ${langs.map((l) => `<option value="${esc(l)}" ${l === outreach ? 'selected' : ''}>${esc(l.toUpperCase())}</option>`).join('')}
      </select>
    </div>

    <div class="txt-dicts" id="txtDicts"></div>`;

  renderTextDicts($('#txtDicts', box), loaded, active);

  $$('#txtLangs button', box).forEach((b) => b.addEventListener('click', () => {
    state.textsLang = b.dataset.v;
    renderTextsView(box, loaded);
  }));
  $('#txtOutreach', box).addEventListener('change', async (e) => {
    await saveSection('system', { outreachLang: e.target.value });
    toast(t('txt.outreachSaved', { lang: e.target.value.toUpperCase() }), 'success');
    renderTextsView(box, loaded);
  });
  $('#txtOpen2', box).addEventListener('click', () => openTextsFile());
  $('#txtEdit', box).addEventListener('click', () => openTextsEditor(JSON.stringify(loaded, null, 2)));
  $('#txtSave', box).addEventListener('click', async () => {
    const res = await api.texts.saveFile(JSON.stringify(loaded, null, 2));
    if (res && res.ok) toast(t('txt.exported'), 'success');
  });
  wireRipples(box);
}

function renderTextDicts(box, loaded, lang) {
  if (!box) return;
  box.innerHTML = TEXT_DICTS.map((d) => {
    const dict = loaded[d.id] || {};
    const arr = Array.isArray(dict[lang]) ? dict[lang] : [];
    return `<section class="txt-dict" data-dict="${d.id}">
      <div class="td-head">
        <span class="td-icon">${ICONS[d.icon]}</span>
        <span class="td-id">
          <span class="td-title">${esc(t('txt.d.' + d.key))}</span>
          <span class="td-code">${esc(d.id)}</span>
        </span>
        <span class="td-count">${arr.length}</span>
      </div>
      <div class="hint td-when">${esc(t('txt.w.' + d.key))}</div>
      ${arr.length
        ? `<ol class="td-list">${arr.map((s, i) => textLineHtml(s, i)).join('')}</ol>`
        : `<div class="empty" style="padding:18px 0">${esc(t('txt.noLang', { lang: lang.toUpperCase() }))}</div>`}
      <button class="btn ghost td-add" data-add="${d.id}">${ICONS.plus}<span>${esc(t('txt.addLine'))}</span></button>
    </section>`;
  }).join('');

  wireTextEditing(box, loaded, lang);
}

function textLineHtml(s, i) {
  return `<li data-i="${i}">
    <span class="tl-body">${highlightSlots(s)}</span>
    <span class="tl-acts">
      <button class="mini" data-edit="${i}" title="${esc(t('txt.edit'))}">${ICONS.pencil}</button>
      <button class="mini danger" data-del="${i}" title="${esc(t('txt.remove'))}">${ICONS.trash}</button>
    </span>
  </li>`;
}

/** Правка вариантов прямо в списке: без выгрузки в JSON и обратно. */
function wireTextEditing(box, loaded, lang) {
  const dictOf = (el) => el.closest('.txt-dict').dataset.dict;

  $$('[data-edit]', box).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openLineEditor(b.closest('li'), dictOf(b), lang, +b.dataset.edit, loaded);
  }));

  $$('[data-del]', box).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const dict = dictOf(b);
    const i = +b.dataset.del;
    const arr = loaded[dict][lang];
    // Последний вариант удалять нельзя: пустой список означает, что письма на
    // этом языке просто не уйдут, а понять это по интерфейсу будет негде.
    if (arr.length <= 1) { toast(t('txt.lastLine'), 'error'); return; }
    const ok = await askConfirm(t('txt.removeTitle'), t('txt.removeText', { text: shorten(arr[i], 90) }),
      { danger: true, okLabel: t('txt.remove') });
    if (!ok) return;
    const next = cloneTexts(loaded);
    next[dict][lang].splice(i, 1);
    await saveTexts(next);
  }));

  $$('[data-add]', box).forEach((b) => b.addEventListener('click', () => {
    const dict = b.dataset.add;
    const next = cloneTexts(loaded);
    if (!Array.isArray(next[dict][lang])) next[dict][lang] = [];
    next[dict][lang].push('');
    // Сохраняем сразу и открываем новую строку на правку: пустой вариант в
    // списке существует ровно до того, как в него что-то впишут.
    saveTexts(next, () => {
      const sect = $(`.txt-dict[data-dict="${dict}"]`);
      const li = sect && sect.querySelector(`li[data-i="${next[dict][lang].length - 1}"]`);
      if (li) openLineEditor(li, dict, lang, next[dict][lang].length - 1, next);
    });
  }));

  wireRipples(box);
}

function shorten(s, n) {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '...' : one;
}

function cloneTexts(loaded) {
  return JSON.parse(JSON.stringify(loaded));
}

/** Строка превращается в поле ввода на месте. */
function openLineEditor(li, dict, lang, index, loaded) {
  if (!li || li.classList.contains('editing')) return;
  const value = (loaded[dict] && loaded[dict][lang] && loaded[dict][lang][index]) || '';
  li.classList.add('editing');
  li.innerHTML = `
    <div class="tl-edit">
      <textarea class="tl-area" spellcheck="false">${esc(value)}</textarea>
      <div class="tl-slots">${TEXT_SLOTS.map((s) => `<button class="slot-btn" data-slot="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <div class="tl-edit-acts">
        <span class="hint" style="flex:1 1 auto">${esc(t('txt.editHint'))}</span>
        <button class="btn ghost" data-cancel>${esc(t('common.cancel'))}</button>
        <button class="btn primary" data-save>${esc(t('txt.save'))}</button>
      </div>
    </div>`;

  const area = $('.tl-area', li);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);

  // Плейсхолдер вставляем в место курсора - дописывать его руками в конец
  // строки почти всегда не то, что нужно.
  $$('.slot-btn', li).forEach((b) => b.addEventListener('click', () => {
    const slot = b.dataset.slot;
    const at = area.selectionStart;
    area.value = area.value.slice(0, at) + slot + area.value.slice(area.selectionEnd);
    area.focus();
    area.setSelectionRange(at + slot.length, at + slot.length);
  }));

  const cancel = () => renderSettingsGroup($('.settings'));
  $('[data-cancel]', li).addEventListener('click', cancel);
  $('[data-save]', li).addEventListener('click', async () => {
    const text = area.value;
    if (!text.trim()) { toast(t('txt.emptyLine'), 'error'); return; }
    const next = cloneTexts(loaded);
    next[dict][lang][index] = text;
    await saveTexts(next);
  });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    // Enter переносит строку - в письмах абзацы значимые. Сохраняем по Ctrl+Enter.
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('[data-save]', li).click(); }
  });
  wireRipples(li);
}

/** Записать изменённые тексты и перерисовать раздел. */
async function saveTexts(next, after) {
  state.settings.texts = await api.settings.loadTexts(next);
  toast(t('txt.saved'), 'success');
  const root = $('.settings');
  if (root) renderSettingsGroup(root);
  if (after) setTimeout(after, 0);
}

/**
 * Подсветка служебных мест в тексте: плейсхолдеры, хвост "link:" и переносы
 * строк. Экранируем СНАЧАЛА, потом вставляем разметку - иначе текст с угловыми
 * скобками уехал бы в HTML.
 */
function highlightSlots(text) {
  let out = esc(String(text == null ? '' : text));
  for (const slot of TEXT_SLOTS) {
    out = out.split(esc(slot)).join(`<mark class="slot">${esc(slot)}</mark>`);
  }
  out = out.replace(/(link|lien|enlace)(\s*):(\s*)$/i, '<mark class="slot">$1$2:</mark>$3');
  // Перенос строки показываем знаком: в тексте письма он значимый, а пустое
  // место в списке выглядит как случайный отступ.
  return out.replace(/\n/g, '<span class="nl">¶</span><br>');
}

async function openTextsFile() {
  const res = await api.texts.openFile();
  if (!res || !res.ok) {
    if (res && res.reason === 'read_failed') toast(t('txt.readFailed'), 'error');
    return;
  }
  applyTextsSource(res.content);
}

/** Модалка с JSON: и для вставки нового, и для правки загруженного. */
function openTextsEditor(initial) {
  modal(
    `<h3>${esc(t('txt.editTitle'))}</h3>
     <div class="modal-text">${esc(t('txt.editSub'))}</div>
     <div class="field"><textarea id="txtRaw" style="min-height:260px" spellcheck="false" placeholder='{ "MESSAGES_DICT": { "en": [ ... ] } }'>${esc(initial || '')}</textarea></div>
     <div class="hint" id="txtRawMsg" style="min-height:18px"></div>
     <div class="modal-actions">
       <button class="btn" id="txtCancel">${esc(t('common.cancel'))}</button>
       <button class="btn primary" id="txtApply">${esc(t('txt.apply'))}</button>
     </div>`,
    (overlay, done) => {
      const area = $('#txtRaw', overlay);
      const msg = $('#txtRawMsg', overlay);
      area.focus();
      $('#txtCancel', overlay).addEventListener('click', () => done(null));
      $('#txtApply', overlay).addEventListener('click', async () => {
        const ok = await applyTextsSource(area.value, (text) => { msg.textContent = text; });
        if (ok) done(true);
      });
    },
  );
}

/** Разобрать, проверить и сохранить. Ошибки формата не сохраняем вовсе. */
async function applyTextsSource(raw, onError) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    const text = t('set.textsInvalid', { error: e.message });
    if (onError) onError(text); else toast(text, 'error');
    return false;
  }
  const check = validateTexts(json);
  if (check.errors.length) {
    const text = check.errors[0];
    if (onError) onError(text); else toast(text, 'error');
    return false;
  }
  state.settings.texts = await api.settings.loadTexts(json);
  toast(t('set.textsToast'), 'success');
  const root = $('.settings');
  if (root) renderSettingsGroup(root);
  return true;
}

// ── Выезжающая панель ──────────────────────────────────────────────
// Одна панель на всё: оформление и детали профиля. Что именно в ней
// показано, помнит drawerView - он же умеет перерисовать себя, когда
// данные обновились (например, профиль запустился).
let drawerView = null;

function drawerOpen() { return $('#drawer').classList.contains('open'); }

function setDrawerOpen(open) {
  const view = drawerView;
  // Пристыкованная панель не гасит экран вуалью и не накрывает работу, а
  // отодвигает её: письмо в превью смотрят прямо во время правки шаблона, и
  // редактор при открытой панели должен остаться рабочим.
  const docked = !!(view && view.dock);
  $('#drawer').classList.toggle('open', open);
  $('#drawerScrim').classList.toggle('open', open && !docked);
  document.body.classList.toggle('drawer-docked', open && docked);
  if (open) return;
  drawerView = null;
  // Закрыть панель можно крестиком, вуалью и клавишей Esc. Чтобы вызвавшему
  // экрану не пришлось ловить все три пути, зовём его обработчик здесь.
  if (view && view.onClose) view.onClose();
}

function openDrawer(view) {
  drawerView = view;
  renderDrawerView();
  setDrawerOpen(true);
}

function renderDrawerView() {
  if (!drawerView) return;
  const drawer = $('#drawer');
  // Письмо в превью верстается на 600 px - в обычную ширину панели оно не
  // влезает, поэтому такие панели просят себе больше места сами.
  drawer.classList.toggle('wide', !!drawerView.wide);
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
          <input type="range" id="apDim" min="0" max="0.92" step="0.02" value="${apVal('dim', 0.5)}"/>
          <span class="num" id="apDimNum">${Math.round(apVal('dim', 0.5) * 100)}%</span></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.blur'))}</span>
          <input type="range" id="apBlur" min="0" max="26" step="1" value="${apVal('blur', 0)}"/>
          <span class="num" id="apBlurNum">${apVal('blur', 0)}px</span></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.saturate'))}</span>
          <input type="range" id="apSat" min="0" max="2" step="0.05" value="${apVal('saturate', 1)}"/>
          <span class="num" id="apSatNum">${apVal('saturate', 1).toFixed(2)}</span></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.glass'))}</span>
          <input type="range" id="apGlass" min="0.2" max="1" step="0.02" value="${apVal('glassAlpha', 0.72)}"/>
          <span class="num" id="apGlassNum">${Math.round(apVal('glassAlpha', 0.72) * 100)}%</span></div>
        <div class="slider-row"><span class="lbl">${esc(t('appear.scrim'))}</span>
          <input type="range" id="apScrim" min="0" max="0.85" step="0.02" value="${apVal('scrimAlpha', 0.3)}"/>
          <span class="num" id="apScrimNum">${Math.round(apVal('scrimAlpha', 0.3) * 100)}%</span></div>
        <div class="seg" id="apDensity" style="margin-top:6px">
          ${DENSITY_PRESETS.map((d) => `<button data-v="${d.id}">${esc(t('appear.density.' + d.id))}</button>`).join('')}
        </div>
        <div class="hint" style="margin-top:8px">${esc(t('appear.glassHint'))}</div>
      </div>

      <div class="opt-group">
        <span class="section-label">${esc(t('appear.motion'))}</span>
        <label class="switch" style="margin-bottom:10px"><input type="checkbox" id="apParallax" ${ap.parallax !== false ? 'checked' : ''}/>
          <span class="track"></span><span class="lbl">${esc(t('appear.parallax'))}</span></label>
        <label class="switch" style="margin-bottom:8px"><input type="checkbox" id="apRefract" ${ap.refract ? 'checked' : ''}/>
          <span class="track"></span><span class="lbl">${esc(t('appear.refract'))}</span></label>
        <div class="hint">${esc(t('appear.refractHint'))}</div>
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
      if (!Number.isFinite(v)) return;
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
  slider('#apScrim', '#apScrimNum', 'scrimAlpha', (v) => Math.round(v * 100) + '%', Number);

  $$('#apDensity button', root).forEach((b) => b.addEventListener('click', async () => {
    const preset = DENSITY_PRESETS.find((d) => d.id === b.dataset.v);
    await saveAppearance({ glassAlpha: preset.glass, scrimAlpha: preset.scrim, dim: preset.dim });
    rerender();
  }));
  $('#apParallax', root).addEventListener('change', (e) => saveAppearance({ parallax: e.target.checked }));
  $('#apRefract', root).addEventListener('change', (e) => saveAppearance({ refract: e.target.checked }));

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
  // Пять запросов параллельно, а не по очереди: каждый читает свой файл в
  // main-процессе и друг от друга они не зависят.
  const [profiles, stats, metrics] = await Promise.all([
    api.profiles.list(),
    api.profiles.stats(),
    api.profiles.metrics(),
  ]);
  state.profiles = profiles;
  state.profileStats = stats;
  state.profileMetrics = metrics;

  // Журнал по дням и список переписок меняются медленно - тянуть их каждые
  // четыре секунды незачем. Обновляем раз в минуту и сразу, когда открыт
  // экран, который их показывает.
  const slow = Date.now() - state.slowFetchedAt > 60000
    || state.route === 'overview' || state.route === 'chats';
  if (slow) {
    const [overview, chats] = await Promise.all([api.stats.overview(14), api.chats.list()]);
    state.stats = overview;
    state.chats = chats;
    state.slowFetchedAt = Date.now();
  }

  // Спарклайн: прирост отправленного за тик. Первый замер только задаёт точку
  // отсчёта, иначе весь накопленный за прошлые запуски счёт нарисовался бы
  // одним всплеском.
  const total = state.profiles.reduce((n, p) => n + (p.sentCount || 0), 0);
  if (state.lastSentTotal !== null) {
    state.sendSeries.push(Math.max(0, total - state.lastSentTotal));
    // Окно на 120 тактов, а не на 40: тот же ряд теперь рисует и крупный
    // график прогона, а на сорока точках он показывал только пару минут.
    while (state.sendSeries.length > 120) state.sendSeries.shift();
  }
  state.lastSentTotal = total;

  // То же самое по каждому профилю отдельно. Ряды удалённых профилей выбрасываем,
  // иначе объект растёт до бесконечности.
  const series = {};
  for (const p of state.profiles) {
    const row = state.profileSeries[p.id] || { last: null, first: 0, values: [] };
    const now = p.sentCount || 0;
    if (row.last !== null) {
      row.values.push(Math.max(0, now - row.last));
      while (row.values.length > 30) row.values.shift();
      if (!row.first) row.first = Date.now();
    }
    row.last = now;
    series[p.id] = row;
  }
  state.profileSeries = series;

  if (state.route === 'profiles') {
    renderProfileFilters(document);
    renderProfileCards(document);
    paintProfileLive();
    paintProfileStats(state.profileStats);
  } else if (state.route === 'run') {
    paintRun();
  } else if (state.route === 'overview') {
    paintOverview();
  } else if (state.route === 'chats') {
    renderChatGroups();
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
  // Пауза логов - состояние на время работы, а не настройка вида: приложение,
  // открывшееся с замороженным журналом, выглядит зависшим. Остальное в
  // секции ui (вид списка, сортировка, панель превью) переживает перезапуск.
  if (state.settings.ui && state.settings.ui.logsPaused) saveSection('ui', { logsPaused: false });
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
  wireParallax();
  wirePeek();
}

boot();

})();
