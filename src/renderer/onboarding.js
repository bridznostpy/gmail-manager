'use strict';
/* Знакомство с приложением: мастер первого запуска и подсказки по интерфейсу.

   Отдельным файлом, а не внутри app.js: тот уже больше пяти тысяч строк, и
   класть туда ещё один самостоятельный экран незачем. Общие мелочи (t, esc,
   toast, сохранение настроек) приходят контекстом из app.js - своих копий тут
   нет, иначе они разошлись бы с настоящими при первой же правке.

   Всё, что человек вводит в мастере, сохраняется сразу, на том же шаге. Поэтому
   "Пропустить" ничего не теряет, а закрытый на середине мастер оставляет
   заполненным всё, до чего дошли. */

window.ONBOARD = (() => {

let ctx = null;
const t = (key, params) => ctx.t(key, params);
const esc = (s) => ctx.esc(s);
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

function init(context) {
  ctx = context;
}

// ── Мастер первого запуска ─────────────────────────────────────────
// Порядок шагов - это порядок настройки: сначала то, без чего не поедет
// (браузер), потом источник лидов, потом мелочи, и в самом конце профиль,
// потому что он открывает окно Chrome и уводит внимание из приложения.

const STEPS = [
  { id: 'welcome', icon: 'rocket', build: stepWelcome },
  { id: 'chrome', icon: 'cdp', build: stepChrome },
  { id: 'parser', icon: 'parser', build: stepParser },
  { id: 'link', icon: 'link', build: stepLink },
  { id: 'telegram', icon: 'telegram', build: stepTelegram },
  { id: 'texts', icon: 'inbox', build: stepTexts },
  { id: 'profile', icon: 'profiles', build: stepProfile },
  { id: 'done', icon: 'check', build: stepDone },
];

let wizAt = 0;
let wizBox = null;

/**
 * Открыть мастер. Возвращает промис, который разрешается, когда мастер закрыт:
 * вызывающему нужно знать момент, чтобы предложить подсказки следом.
 */
function wizard() {
  if (wizBox) return Promise.resolve(false);
  wizAt = 0;

  return new Promise((resolve) => {
    const scrim = ctx.h(`<div class="wiz-scrim">
      <div class="wiz glass glass-refract">
        <aside class="wiz-rail">
          <div class="wiz-brand"><span class="wiz-logo">GM</span><span>Gmail Manager</span></div>
          <ol class="wiz-steps" id="wizSteps"></ol>
          <div class="wiz-note">${esc(t('wiz.railNote'))}</div>
        </aside>
        <div class="wiz-main">
          <div class="wiz-head">
            <h2 id="wizTitle"></h2>
            <p id="wizSub"></p>
          </div>
          <div class="wiz-body" id="wizBody"></div>
          <div class="wiz-foot">
            <button class="btn ghost" id="wizBack">${esc(t('wiz.back'))}</button>
            <span class="wiz-gap"></span>
            <button class="btn ghost" id="wizSkip">${esc(t('wiz.skip'))}</button>
            <button class="btn primary" id="wizNext">${esc(t('wiz.next'))}</button>
          </div>
        </div>
      </div>
    </div>`);

    document.body.appendChild(scrim);
    wizBox = scrim;

    const close = async (finished) => {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      wizBox = null;
      // Отметку ставим при любом выходе, не только по кнопке "Готово": мастер
      // встречает один раз, а вернуться к нему можно из руководства.
      await ctx.saveSection('onboarding', { done: true });
      resolve(!!finished);
    };

    // Escape закрывает, но не молча: иначе человек решил бы, что мастер пропал
    // навсегда вместе со всем, что он собирался настроить.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      ctx.toast(t('wiz.closedHint'));
      close(false);
    };
    document.addEventListener('keydown', onKey, true);

    $('#wizBack', scrim).addEventListener('click', () => paintStep(wizAt - 1));
    $('#wizSkip', scrim).addEventListener('click', () => paintStep(wizAt + 1));
    $('#wizNext', scrim).addEventListener('click', () => {
      if (wizAt >= STEPS.length - 1) { close(true); return; }
      paintStep(wizAt + 1);
    });

    paintStep(0);
  });
}

function paintStep(at) {
  const next = Math.max(0, Math.min(STEPS.length - 1, at));
  wizAt = next;
  const step = STEPS[next];
  const scrim = wizBox;

  $('#wizSteps', scrim).innerHTML = STEPS.map((s, i) => `
    <li class="wiz-step ${i === next ? 'active' : ''} ${i < next ? 'past' : ''}">
      <span class="ws-mark">${i < next ? ctx.ICONS.check : ctx.ICONS[s.icon]}</span>
      <span>${esc(t('wiz.s.' + s.id))}</span>
    </li>`).join('');

  $('#wizTitle', scrim).textContent = t('wiz.h.' + step.id);
  $('#wizSub', scrim).textContent = t('wiz.d.' + step.id);

  const body = $('#wizBody', scrim);
  body.innerHTML = '';
  const el = step.build();
  if (el) body.appendChild(el);
  body.scrollTop = 0;

  // Первый шаг некуда возвращать, последний ничего не пропускает.
  $('#wizBack', scrim).disabled = next === 0;
  $('#wizSkip', scrim).hidden = next === 0 || next === STEPS.length - 1;
  $('#wizNext', scrim).textContent = next === STEPS.length - 1 ? t('wiz.finish') : t('wiz.next');
  ctx.wireRipples(scrim);
}

/** Поле мастера в том же виде, что и в настройках - разной вёрстки не нужно. */
function field(id, labelKey, value, opts = {}) {
  const type = opts.password ? 'password' : 'text';
  return `<div class="field">
    <label for="${id}">${esc(t(labelKey))}</label>
    <input type="${type}" id="${id}" value="${esc(value || '')}"
      placeholder="${esc(opts.placeholder || '')}" autocomplete="off" spellcheck="false"/>
  </div>`;
}

/** Сохранять на каждое нажатие клавиши незачем - ждём паузу в наборе. */
function bindField(el, id, section, key) {
  const input = $('#' + id, el);
  if (!input) return;
  const save = ctx.debounce(async () => {
    await ctx.saveSection(section, { [key]: input.value.trim() });
  }, 500);
  input.addEventListener('input', save);
  input.addEventListener('blur', () => ctx.saveSection(section, { [key]: input.value.trim() }));
}

function stepWelcome() {
  const s = ctx.state.settings;
  const el = ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.welcomeLead'))}</div>
    <div class="field"><label>${esc(t('set.language'))}</label>
      <div class="seg" id="wLang">
        ${ctx.I18N.LANGUAGES.map((x) => `<button data-v="${x.id}"
          class="${ctx.I18N.getLanguage() === x.id ? 'active' : ''}">${esc(x.label)}</button>`).join('')}
      </div>
    </div>
    <div class="field"><label>${esc(t('app.theme'))}</label>
      <div class="seg" id="wTheme">
        <button data-v="dark" class="${s.theme !== 'light' ? 'active' : ''}">${esc(t('wiz.themeDark'))}</button>
        <button data-v="light" class="${s.theme === 'light' ? 'active' : ''}">${esc(t('wiz.themeLight'))}</button>
      </div>
    </div>
    <div class="wiz-cards">
      <div class="wiz-card">${ctx.ICONS.profiles}<b>${esc(t('wiz.w1t'))}</b><span>${esc(t('wiz.w1s'))}</span></div>
      <div class="wiz-card">${ctx.ICONS.parser}<b>${esc(t('wiz.w2t'))}</b><span>${esc(t('wiz.w2s'))}</span></div>
      <div class="wiz-card">${ctx.ICONS.chat}<b>${esc(t('wiz.w3t'))}</b><span>${esc(t('wiz.w3s'))}</span></div>
    </div>
  </div>`);

  // Язык меняет надписи прямо в мастере, поэтому шаг перерисовываем целиком.
  $$('#wLang button', el).forEach((b) => b.addEventListener('click', async () => {
    await ctx.setLanguage(b.dataset.v);
    paintStep(wizAt);
  }));
  $$('#wTheme button', el).forEach((b) => b.addEventListener('click', async () => {
    await ctx.setTheme(b.dataset.v);
    paintStep(wizAt);
  }));
  return el;
}

function stepChrome() {
  const c = ctx.state.settings.cdp;
  const el = ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.chromeLead'))}</div>
    ${field('wChrome', 'cdp.path', c.chromePath, { placeholder: t('cdp.pathPh') })}
    <button class="btn" id="wDetect">${ctx.ICONS.search}<span>${esc(t('cdp.detect'))}</span></button>
    <div class="hint" id="wChromeMsg" style="margin-top:12px"></div>
  </div>`);

  bindField(el, 'wChrome', 'cdp', 'chromePath');
  $('#wDetect', el).addEventListener('click', async () => {
    const found = await ctx.api.cdp.detectChrome();
    $('#wChromeMsg', el).textContent = found ? t('cdp.found', { path: found }) : t('cdp.notFound');
    // Найденный путь в настройки не пишем: автоопределение работает и с
    // пустым полем, а записанный путь устареет при переустановке браузера.
  });
  return el;
}

function stepParser() {
  const p = ctx.state.settings.parser;
  const el = ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.parserLead'))}</div>
    ${field('wPKey', 'parser.apiKey', p.apiKey, { password: true })}
    <div class="field"><label for="wPType">${esc(t('parser.type'))}</label>
      <select id="wPType">
        <option value="xproject" ${p.apiType === 'xproject' ? 'selected' : ''}>XProject</option>
        <option value="vvs" ${p.apiType === 'vvs' ? 'selected' : ''}>VVS</option>
      </select>
    </div>
    <div class="field"><label for="wPPlat">${esc(t('wiz.platform'))}</label>
      <select id="wPPlat">
        ${ctx.PLATFORMS.map((x) => `<option value="${x.id}"
          ${p.platform === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
      </select>
    </div>
    <div class="hint">${esc(t('wiz.parserHint'))}</div>
  </div>`);

  bindField(el, 'wPKey', 'parser', 'apiKey');
  $('#wPType', el).addEventListener('change', (e) => ctx.saveSection('parser', { apiType: e.target.value }));
  $('#wPPlat', el).addEventListener('change', async (e) => {
    const platform = ctx.PLATFORMS.find((x) => x.id === e.target.value) || ctx.PLATFORMS[0];
    // Страны от прошлой площадки могут ей не подходить - тогда берём первую
    // доступную. Пустой список стран остановил бы сбор лидов молча.
    const kept = (ctx.state.settings.parser.countries || [])
      .filter((code) => platform.countries.includes(code));
    await ctx.saveSection('parser', {
      platform: platform.id,
      countries: kept.length ? kept : [platform.countries[0]],
    });
  });
  return el;
}

function stepLink() {
  const l = ctx.state.settings.link;
  const el = ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.linkLead'))}</div>
    ${field('wLKey', 'link.apiKey', l.apiKey, { password: true })}
    ${field('wLMode', 'link.mode', l.mode, { placeholder: t('link.modePh') })}
    ${field('wLPid', 'link.profileId', l.profileId)}
    <div class="hint">${esc(t('wiz.linkHint'))}</div>
  </div>`);
  bindField(el, 'wLKey', 'link', 'apiKey');
  bindField(el, 'wLMode', 'link', 'mode');
  bindField(el, 'wLPid', 'link', 'profileId');
  return el;
}

function stepTelegram() {
  const tg = ctx.state.settings.telegram;
  const el = ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.tgLead'))}</div>
    ${field('wTToken', 'tg.token', tg.botToken, { password: true })}
    ${field('wTId', 'tg.chatId', tg.botId)}
    <button class="btn" id="wTTest">${ctx.ICONS.send}<span>${esc(t('tg.test'))}</span></button>
    <div class="hint" id="wTMsg" style="margin-top:12px"></div>
  </div>`);
  bindField(el, 'wTToken', 'telegram', 'botToken');
  bindField(el, 'wTId', 'telegram', 'botId');
  $('#wTTest', el).addEventListener('click', async () => {
    const res = await ctx.api.telegram.test($('#wTToken', el).value);
    $('#wTMsg', el).textContent = res && res.ok
      ? t('tg.ok', { username: (res.result && res.result.username) || 'bot' })
      : t('tg.fail');
  });
  return el;
}

function stepTexts() {
  const loaded = !!ctx.state.settings.texts;
  const el = ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.textsLead'))}</div>
    <div class="wiz-state ${loaded ? 'ok' : ''}" id="wTxtState">
      ${loaded ? ctx.ICONS.check : ctx.ICONS.alert}
      <span>${esc(t(loaded ? 'wiz.textsLoaded' : 'wiz.textsMissing'))}</span>
    </div>
    <button class="btn" id="wTxtOpen">${ctx.ICONS.upload}<span>${esc(t('txt.openFile'))}</span></button>
    <div class="hint" style="margin-top:12px">${esc(t('wiz.textsHint'))}</div>
  </div>`);

  $('#wTxtOpen', el).addEventListener('click', async () => {
    await ctx.openTextsFile();
    paintStep(wizAt);
  });
  return el;
}

function stepProfile() {
  const count = ctx.state.profiles.length;
  const el = ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.profileLead'))}</div>
    <div class="wiz-warn">${ctx.ICONS.lock}<span>${esc(t('wiz.profileManual'))}</span></div>
    ${count ? `<div class="wiz-state ok">${ctx.ICONS.check}
      <span>${esc(t('wiz.profileHave', { n: count }))}</span></div>` : ''}
    <div class="field"><label for="wPName">${esc(t('wiz.profileName'))}</label>
      <input type="text" id="wPName" placeholder="${esc(t('wiz.profileNamePh'))}" autocomplete="off"/>
    </div>
    <button class="btn primary" id="wPCreate">${ctx.ICONS.plus}<span>${esc(t('wiz.profileCreate'))}</span></button>
    <div class="hint" id="wPMsg" style="margin-top:12px"></div>
  </div>`);

  const btn = $('#wPCreate', el);
  btn.addEventListener('click', async () => {
    const label = $('#wPName', el).value.trim();
    if (!label) { $('#wPMsg', el).textContent = t('wiz.profileNeedName'); return; }
    // Создание поднимает Chrome и открывает Gmail - это долго, и без блокировки
    // кнопки нетерпеливый человек завёл бы три профиля подряд.
    btn.disabled = true;
    $('#wPMsg', el).textContent = t('wiz.profileCreating');
    try {
      await ctx.api.profiles.create(label);
      await ctx.refreshProfiles();
      paintStep(wizAt);
    } catch (e) {
      btn.disabled = false;
      $('#wPMsg', el).textContent = t('wiz.profileFailed', { error: e.message });
    }
  });
  return el;
}

function stepDone() {
  const s = ctx.state.settings;
  const rows = [
    { key: 'chrome', done: true },
    { key: 'parser', done: !!s.parser.apiKey },
    { key: 'link', done: !!s.link.apiKey },
    { key: 'telegram', done: !!(s.telegram.botToken && s.telegram.botId) },
    { key: 'texts', done: !!s.texts },
    { key: 'profile', done: ctx.state.profiles.length > 0 },
  ];
  return ctx.h(`<div>
    <div class="wiz-lead">${esc(t('wiz.doneLead'))}</div>
    <div class="wiz-sum">
      ${rows.map((r) => `<div class="wiz-sum-row ${r.done ? 'ok' : ''}">
        <span class="mark">${r.done ? ctx.ICONS.check : ctx.ICONS.x}</span>
        <span>${esc(t('wiz.s.' + r.key))}</span>
      </div>`).join('')}
    </div>
    <div class="hint" style="margin-top:14px">${esc(t('wiz.doneHint'))}</div>
  </div>`);
}

// ── Подсказки по интерфейсу ────────────────────────────────────────
// Затемнение с вырезом вокруг настоящего элемента: рассказывать про кнопку
// картинкой бесполезно, человек должен увидеть ту самую кнопку на своём экране.

const TOUR = [
  { sel: '.rail', key: 'rail', place: 'right' },
  { sel: '#quickRun', key: 'run', place: 'bottom' },
  { sel: '#btnBell', key: 'bell', place: 'bottom' },
  { sel: '#btnPalette', key: 'palette', place: 'bottom' },
  { sel: '.home-ready', key: 'ready', place: 'top' },
];

let tourAt = 0;
let tourBox = null;

function tour() {
  if (tourBox) return;
  // Последняя остановка - чек-лист на витрине, поэтому начинаем с неё.
  ctx.go('home');
  tourAt = 0;

  const scrim = ctx.h(`<div class="tour-scrim">
    <div class="tour-hole" id="tourHole"></div>
    <div class="tour-card glass" id="tourCard"></div>
  </div>`);
  document.body.appendChild(scrim);
  tourBox = scrim;

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeTour(); } };
  document.addEventListener('keydown', onKey, true);
  // Окно можно растянуть посреди подсказки - вырез поедет мимо кнопки.
  const onResize = () => paintTour(tourAt);
  window.addEventListener('resize', onResize);

  scrim._cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
  };

  // Даём витрине отрисоваться: до этого у элементов нет размеров, и вырез
  // встал бы в левый верхний угол.
  setTimeout(() => paintTour(0), 60);
}

async function closeTour() {
  if (!tourBox) return;
  tourBox._cleanup();
  tourBox.remove();
  tourBox = null;
  await ctx.saveSection('onboarding', { tourDone: true });
}

function paintTour(at) {
  if (!tourBox) return;
  if (at >= TOUR.length) { closeTour(); return; }
  tourAt = at;
  const stop = TOUR[at];
  const target = $(stop.sel);
  // Элемента может не быть - например, чек-лист скрыт, когда всё настроено.
  // Пропускаем такую остановку, а не показываем вырез в пустоте.
  if (!target) { paintTour(at + 1); return; }

  const r = target.getBoundingClientRect();
  const pad = 8;
  const hole = $('#tourHole', tourBox);
  hole.style.left = (r.left - pad) + 'px';
  hole.style.top = (r.top - pad) + 'px';
  hole.style.width = (r.width + pad * 2) + 'px';
  hole.style.height = (r.height + pad * 2) + 'px';

  const card = $('#tourCard', tourBox);
  card.innerHTML = `
    <div class="tc-step">${at + 1} / ${TOUR.length}</div>
    <b>${esc(t('tour.t.' + stop.key))}</b>
    <div class="tc-text">${esc(t('tour.d.' + stop.key))}</div>
    <div class="tc-acts">
      <button class="btn ghost" id="tourSkip">${esc(t('tour.skip'))}</button>
      <button class="btn primary" id="tourNext">${esc(t(at === TOUR.length - 1 ? 'tour.finish' : 'tour.next'))}</button>
    </div>`;

  // Карточку ставим после отрисовки: до неё у неё нет размеров, и в край
  // экрана она упиралась бы наугад.
  const cw = card.offsetWidth;
  const chH = card.offsetHeight;
  const gap = 14;
  let left = r.left;
  let top = r.bottom + gap;
  if (stop.place === 'right') { left = r.right + gap; top = r.top; }
  if (stop.place === 'top') { top = r.top - chH - gap; }
  card.style.left = Math.max(12, Math.min(window.innerWidth - cw - 12, left)) + 'px';
  card.style.top = Math.max(12, Math.min(window.innerHeight - chH - 12, top)) + 'px';

  $('#tourSkip', card).addEventListener('click', () => closeTour());
  $('#tourNext', card).addEventListener('click', () => paintTour(at + 1));
  ctx.wireRipples(card);
}

/**
 * Что показать при запуске. Мастер - только новичку, подсказки - сразу после
 * него. Тому, кто уже работает, ничего не показываем вовсе: всплывающий тур у
 * человека с настроенной рассылкой выглядит поломкой, а не заботой.
 */
async function greetIfNew() {
  const ob = (ctx.state.settings && ctx.state.settings.onboarding) || {};
  if (ob.done) return;
  const finished = await wizard();
  if (finished && !ob.tourDone) tour();
}

return { init, wizard, tour, greetIfNew };

})();
