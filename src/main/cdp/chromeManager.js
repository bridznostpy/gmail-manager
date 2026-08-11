'use strict';
/**
 * Один Chrome на профиль. Каждый профиль = свой `--user-data-dir`, поэтому
 * куки и логины изолированы и переживают перезапуск.
 *
 * ГЛАВНОЕ ПРАВИЛО ЭТОГО МОДУЛЯ: пока пользователь входит в Gmail, к браузеру
 * не должно быть подключено НИЧЕГО.
 *
 * Google отклоняет вход, если браузером кто-то управляет: на отправке адреса
 * он уводит на /signin/rejected с "This browser or app may not be secure".
 * Проверено - обычный Chrome пускает, тот же Chrome под Playwright нет. При
 * этом сам Gmail к автоматизации претензий не имеет: запрет живёт только в
 * форме входа. Поэтому вход и работа разведены:
 *
 * 1. Профиль поднимается обычным `spawn`, без Playwright и без единого флага
 *    автоматизации - ровно так же, как если бы Chrome запустил человек.
 * 2. Статус входа читается по HTTP `/json` порта отладки: оттуда видно адрес
 *    и заголовок вкладки, а этого хватает. Подключения к странице нет.
 * 3. Playwright цепляется через `connectOverCDP` ЛЕНИВО - только когда реально
 *    нужно отправить или прочитать письмо, то есть уже после входа.
 *
 * Порт из диапазона [portStart, portEnd] нужен и для пункта 2, и для пункта 3,
 * и показывается в карточке профиля.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const fingerprint = require('./fingerprint');
const logger = require('../logger');
const { t } = require('../i18n');
const mailboxes = require('../mailbox');

// playwright-core тянем мягко: без него приложение должно открыться и сказать
// это словами, а не упасть на старте главного процесса.
let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (_e) { chromium = null; }

// Бюджеты ожидания. Взяты один в один с прежних циклов опроса
// (40 x 250 мс, 24 x 250 мс, 12 x 250 мс), чтобы поведение на живом Gmail
// не поехало после переноса.
//
// Это ПРЕДЕЛ, а не пауза: ждём мы появления самого элемента, а бюджет нужен
// только чтобы не висеть навечно, когда элемента нет. Растягивается настройкой
// system.waitScale, см. _t.
const T_LONG = 10000;
const T_MED = 6000;
const T_SHORT = 3000;

// Инбокс конкретной почты собирает mailbox.inboxUrl: при мультилогине адрес
// зависит от индекса аккаунта, и одного общего адреса больше нет.

// Как часто опрашиваем /json на предмет "во вкладке что-то изменилось".
// Дёшево: локальный HTTP, без подключения к странице.
const WATCH_MS = 2000;

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

// Версия читается с диска один раз на путь: она нужна до запуска браузера,
// значит спросить её у самого Chrome уже поздно.
const versionCache = new Map();

/**
 * Версия установленного Chrome - для UA профиля. Основной путь работает на всех
 * платформах: рядом с исполняемым файлом лежит папка, названная версией
 * ("...\Application\151.0.7922.77"). Запасной - `chrome --version`, но только
 * не на Windows: там Chrome в консоль ничего не пишет.
 */
function detectChromeVersion(exePath) {
  if (versionCache.has(exePath)) return versionCache.get(exePath);
  let version = '';
  try {
    const dirs = fs.readdirSync(path.dirname(exePath))
      .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
      // Во время обновления рядом лежат две папки - берём старшую. Сравнение
      // строкой тут не годится: "9.0" оказалась бы больше "151.0".
      .sort((a, b) => {
        const x = a.split('.').map(Number);
        const y = b.split('.').map(Number);
        for (let i = 0; i < 4; i++) { if (x[i] !== y[i]) return x[i] - y[i]; }
        return 0;
      });
    if (dirs.length) version = dirs[dirs.length - 1];
  } catch (_e) { /* нестандартная раскладка установки */ }
  if (!version && process.platform !== 'win32') {
    try {
      const out = execFileSync(exePath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
      const m = /(\d+\.\d+\.\d+\.\d+)/.exec(out || '');
      if (m) version = m[1];
    } catch (_e) { /* остаёмся на запасной версии из фингерпринта */ }
  }
  versionCache.set(exePath, version);
  return version;
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

/** Вкладки профиля по HTTP, без подключения к страницам. */
async function listTargets(port) {
  const list = await httpJson(`http://127.0.0.1:${port}/json`);
  return (list || []).filter(
    (x) => x && x.type === 'page' && !/^(devtools|chrome-extension):/.test(x.url || ''),
  );
}

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;

/**
 * Статус входа по одной вкладке - ТОЛЬКО по её адресу и заголовку. Ровно это
 * отдаёт `/json`, и ради этого не надо подключаться к странице, а значит и
 * попадаться Google на управлении браузером во время входа.
 *
 * Заголовок залогиненного Gmail несёт адрес аккаунта: "Входящие (2) -
 * user@gmail.com - Gmail". Он не зависит от языка интерфейса - на этом же
 * признаке держалась и прежняя проба по DOM.
 *
 * TODO(gmail-dom): проверять на живом залогиненном Gmail, догадками не
 * расширять (Rules 4/6).
 */
function probeTarget(target) {
  const href = target.url || '';
  const title = target.title || '';
  const onMail = /^https:\/\/mail\.google\.com\/mail\//.test(href);
  // Страницу входа определяем по хосту: у залогиненного инбокса в адресе
  // остаются flowName=GlifWebSignIn и flowEntry=AccountChooser, по подстрокам
  // он считался бы страницей входа.
  const onSignIn = /^https:\/\/accounts\.google\.com\//.test(href);
  const m = EMAIL_RE.exec(title);
  const email = m ? m[0] : '';
  // Индекс аккаунта в адресе вкладки: при мультилогине именно он отличает почты
  // друг от друга (/mail/u/0/, /mail/u/1/).
  const userIndex = onMail ? mailboxes.userIndexFromUrl(href) : null;
  if (onSignIn) return { status: 'needs_login', email: '', href, userIndex: null };
  // Пока инбокс грузится, заголовок ещё "Gmail" без адреса - это уже вход.
  if (onMail && (email || /Gmail/i.test(title))) return { status: 'ready', email, href, userIndex };
  return { status: 'unknown', email: '', href, userIndex };
}

// TODO(gmail-dom): эвристика статуса входа по DOM. Используется только на
// подключённом профиле, когда идёт работа с почтой. Функция выполняется
// В СТРАНИЦЕ, поэтому ничего снаружи она видеть не должна.
function gmailProbeFn() {
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
    var RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;
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
    return { href: location.href, signedIn: signedIn, signIn: signIn, email: email };
  } catch (e) {
    return { href: '', signedIn: false, signIn: false, email: '' };
  }
}

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
  row: 'tr.zA',
  unreadRow: 'tr.zA.zE',
  // Поле ввода в открытом окне ответа: своего мини-окна у него нет.
  replyBox: 'div[role=textbox][g_editable="true"][aria-label*=Body], div[role=textbox][aria-label*=Body], div[role=textbox]',
  // Признак раскрытой переписки.
  thread: 'div.adn, div[role=listitem]',
};

/**
 * Кнопки, у которых важен ПОРЯДОК перебора, поэтому они списками, а не одной
 * строкой через запятую.
 *
 * Через запятую нельзя: и `document.querySelector`, и локатор Playwright берут
 * первый элемент в порядке ДОКУМЕНТА, а не в порядке селекторов. У кнопок
 * ответа контейнер `div.amn` - родитель обеих кнопок, в DOM он идёт раньше
 * самих кнопок, и список через запятую всегда выбирал его. Клик по контейнеру
 * ответ не открывает.
 */
const SEL_ORDERED = {
  // Ответить. span.ams.bkH - сама кнопка; bkG рядом это "Переслать", в неё
  // попадать нельзя.
  replyBtn: [
    'span.ams.bkH[role="link"]',
    'div.amn span.ams.bkH',
    'div[role="button"][aria-label^="Reply"]',
  ],
  // Отправить ответ. Класс aoO не зависит от языка интерфейса.
  replySend: [
    'div[role="button"].aoO',
    'div[role="button"][data-tooltip^="Send"]',
    'div[role="button"][aria-label^="Send"]',
  ],
  // Назад к списку писем. div.ar6 - иконка стрелки внутри кнопки, клик по ней
  // всплывает до кнопки. Берём её первой: подпись кнопки зависит от языка.
  backToInbox: [
    'div.ar6',
    'div[role="button"][aria-label^="Back to"]',
  ],
  // Выбросить черновик в окне ответа. Класс oh от языка не зависит. Нужен,
  // когда ответ не удался: иначе неудачные попытки копятся черновиками.
  discard: [
    'div[role="button"].oh',
    'div[role="button"][aria-label^="Discard"]',
  ],
};

/**
 * Строки списка писем с отправителем. Выполняется В СТРАНИЦЕ. Логика выбора
 * адреса перенесена из расширения: в треде участников несколько, и нужен тот,
 * кто ответил последним, - первый span[email] строки часто сам аккаунт ("me").
 * Берём последний span.zF, запасной путь - span.yP, письма от mailer-daemon
 * отбрасываем.
 */
function gmailRowsFn(arg) {
  var bad = /mailer-daemon@/i;
  function pickEmail(row) {
    var zf = row.querySelectorAll('span.zF[email]');
    for (var i = zf.length - 1; i >= 0; i--) {
      var e = zf[i].getAttribute('email');
      if (e && !bad.test(e)) return e;
    }
    var yp = row.querySelector('span.yP[email]');
    var y = yp ? yp.getAttribute('email') : '';
    return (y && !bad.test(y)) ? y : '';
  }
  var rows = document.querySelectorAll(arg.unreadOnly ? arg.unreadRow : arg.row);
  var out = [];
  for (var i = 0; i < rows.length && out.length < arg.max; i++) {
    var r = rows[i];
    // id треда и id строки - разные вещи. Первый годится для адреса, второй
    // живёт только в текущем рендере списка и нужен, чтобы кликнуть строку.
    var holder = r.querySelector('[data-legacy-thread-id]');
    var tid = r.getAttribute('data-legacy-thread-id')
      || (holder ? holder.getAttribute('data-legacy-thread-id') : '') || '';
    var rid = r.getAttribute('id') || '';
    // Идентификатор ПОСЛЕДНЕГО письма треда. На нём держится весь учёт
    // автоответчика: изменился - значит в переписке появилось новое письмо.
    var mh = r.querySelector('[data-legacy-last-message-id]');
    var mid = r.getAttribute('data-legacy-last-message-id')
      || (mh ? mh.getAttribute('data-legacy-last-message-id') : '') || '';
    var s = r.querySelector('.bog, .y6 span');
    // Обрывок письма из строки списка. Полного текста тут нет, но он даётся
    // даром - открывать переписку ради него не нужно.
    var sn = r.querySelector('.y2');
    var snippet = sn ? sn.textContent : '';
    out.push({
      threadId: tid || rid, legacyId: tid, rowId: rid, lastMessageId: mid,
      unread: r.classList.contains('zE'),
      from: pickEmail(r), subject: s ? s.textContent : '',
      // Gmail отделяет обрывок от темы длинным тире с пробелами - убираем.
      snippet: snippet.replace(/^\s*[-–—]\s*/, '').trim(),
    });
  }
  return out;
}

// ── Условия ожидания, выполняются В СТРАНИЦЕ ─────────────────────────
// Все они отвечают на вопрос "нужный элемент уже на месте?". Ожидание по такому
// условию заменяет ожидание по времени: как только Gmail дорисовал нужное,
// работа продолжается, а не через фиксированную паузу.

/**
 * Первый ВИДИМЫЙ элемент из упорядоченного списка селекторов.
 *
 * Порядок именно списком, а не одной строкой через запятую: querySelectorAll
 * отдаёт элементы в порядке документа, а не в порядке селекторов (см.
 * SEL_ORDERED). Видимость обязательна - Gmail держит неприменимые пункты меню в
 * разметке со style="display:none", и проверка "элемент есть в DOM" на них
 * проходит.
 *
 * Возвращает НОМЕР селектора плюс единица: waitForFunction ждёт правдивого
 * значения, а ноль правдивым не является.
 */
function anyVisibleFn(list) {
  for (var i = 0; i < list.length; i++) {
    var nodes = document.querySelectorAll(list[i]);
    for (var j = 0; j < nodes.length; j++) {
      var r = nodes[j].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return i + 1;
    }
  }
  return 0;
}

/**
 * Получатель закреплён плашкой?
 *
 * Набранный в поле текст получателем не считаем: именно его Gmail и не
 * признаёт, а при отправке отвечает, что адрес не указан. Текст блока
 * получателей значение input не включает, так что попадание в него - это уже
 * плашка. Плашка известного контакта показывает имя, а не адрес, поэтому
 * дополнительно смотрим атрибуты.
 *
 * Своё мини-окно ищем так же, как _widget: диалог-предок якоря, а при его
 * отсутствии сам якорь. Вспомогательную функцию вынести нельзя - в страницу
 * уходит только сама эта функция.
 */
function gmailRecipientFn(arg) {
  var anchor = document.querySelector('[data-compose-id="' + arg.cid + '"]');
  if (!anchor) return false;
  var w = (anchor.closest && anchor.closest('div[role="dialog"]')) || anchor;
  var box = w.querySelector('[name="to"]');
  if (!box) return false;
  if ((box.innerText || box.textContent || '').toLowerCase().indexOf(arg.needle) >= 0) return true;
  var nodes = box.querySelectorAll('[data-hovercard-id],[email],[title],[aria-label]');
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.tagName === 'INPUT') continue;
    var s = ((n.getAttribute('data-hovercard-id') || '') + ' ' + (n.getAttribute('email') || '')
          + ' ' + (n.getAttribute('title') || '') + ' ' + (n.getAttribute('aria-label') || '')).toLowerCase();
    if (s.indexOf(arg.needle) >= 0) return true;
  }
  return false;
}

/**
 * Идентификатор последнего письма треда в строке списка, если он ИЗМЕНИЛСЯ.
 *
 * После нашего ответа он меняется на наш ответ - по нему автоответчик и
 * понимает, что изменение принесли мы сами, а не продавец. Строку ищем так же,
 * как _rowLocator: по своему id, при промахе (список перерисовался) по адресу
 * отправителя.
 */
function gmailRowMessageFn(arg) {
  var r = arg.rowId ? document.getElementById(arg.rowId) : null;
  if (r && !(r.matches && r.matches(arg.row))) r = null;
  if (!r && arg.from) {
    var rows = document.querySelectorAll(arg.row);
    for (var i = 0; i < rows.length && !r; i++) {
      var s = rows[i].querySelectorAll('span[email]');
      for (var j = 0; j < s.length; j++) {
        if ((s[j].getAttribute('email') || '').toLowerCase() === arg.from) { r = rows[i]; break; }
      }
    }
  }
  if (!r) return null;
  var h = r.querySelector('[data-legacy-last-message-id]');
  var id = r.getAttribute('data-legacy-last-message-id')
    || (h ? h.getAttribute('data-legacy-last-message-id') : '') || '';
  return id && id !== arg.was ? id : null;
}

/**
 * Положить письмо в поле ввода Gmail. Выполняется в странице.
 *
 * Порядок попыток выстроен по живому разбору: письмо приходило продавцу одной
 * слипшейся простынёй без жирного, без ссылок и без картинки.
 *
 * 1. execCommand('insertHTML') - тот же путь, каким Gmail вставляет из буфера.
 *    Он МОЛЧА вставляет пусто, если дать ему документ целиком (с doctype и
 *    head), и при этом не бросает исключение. Поэтому мало поймать ошибку -
 *    надо посмотреть, что реально оказалось в поле.
 * 2. Прямая запись innerHTML. Поле ввода это обычный contenteditable, и Gmail
 *    забирает его содержимое как есть.
 * 3. Текст. Переводы строк ОБЯЗАНЫ стать <br>: в разметке они схлопываются в
 *    пробел, и письмо приходит одним абзацем - ровно то, что и увидел продавец.
 */
function putBodyFn(node, put) {
  // Поле ОТВЕТА не пустое: в нём уже лежит цитата исходного письма. Поэтому
  // судить об успехе по "в поле что-то есть" нельзя - так осечка вставки
  // выглядела как успех, и продавцу уходило письмо с одной цитатой. Меряем
  // прирост: сколько добавилось именно нами.
  var before = node.innerHTML.length;
  // Проба текста: по ней судим об успехе. Одной длины разметки мало - Gmail
  // сам переписывает поле (подпись, свои обёртки), и она может не вырасти,
  // хотя письмо на месте. Поэтому смотрим по существу: наш текст в поле?
  var probe = String(put.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  function grew() {
    if (node.innerHTML.length > before) return true;
    if (!probe) return false;
    var have = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ');
    return have.indexOf(probe) >= 0;
  }

  node.focus();
  // Курсор ставим в начало поля сами. Без выделения внутри узла execCommand
  // вставляет в никуда, а письмо надо положить ПЕРЕД цитатой.
  try {
    var sel = window.getSelection();
    var range = document.createRange();
    range.setStart(node, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { /* без выделения остаётся запасной путь ниже */ }

  var ok = false;
  var how = 'none';
  if (put.html) {
    try { document.execCommand('insertHTML', false, put.html); } catch (e2) { /* ниже */ }
    ok = grew();
    if (ok) how = 'insertHTML';
    if (!ok) {
      // Дописываем в начало, а НЕ переписываем поле целиком: innerHTML стёр бы
      // цитату, на которую отвечаем.
      try {
        node.insertAdjacentHTML('afterbegin', put.html);
        ok = grew();
        if (ok) how = 'insertAdjacentHTML';
      } catch (e3) { ok = false; }
    }
  }
  // Обычный текст кладём КОМАНДОЙ РЕДАКТИРОВАНИЯ, а не правкой DOM. Gmail
  // следит за командами и забирает их результат в черновик; прямое изменение
  // разметки для него чужое - письмо уходило с пустым телом при заполненной
  // теме. Прямая правка остаётся последним запасным путём.
  if (!ok && put.text) {
    try { document.execCommand('insertText', false, put.text); } catch (e4) { /* ниже */ }
    ok = grew();
    if (ok) how = 'insertText';
  }
  if (!ok && put.text) {
    var safe = String(put.text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\r?\n/g, '<br>');
    try {
      node.insertAdjacentHTML('afterbegin', safe);
      ok = grew();
      if (ok) how = 'rawText';
    } catch (e5) { ok = false; }
  }
  node.dispatchEvent(new InputEvent('input', { bubbles: true }));
  // Пробу содержимого возвращаем наружу: по журналу должно быть видно, что
  // реально оказалось в поле, а не только "получилось или нет".
  return {
    ok: ok,
    how: how,
    sample: String(node.innerHTML || '').slice(0, 200),
    before: before,
    after: node.innerHTML.length,
    hadHtml: !!put.html,
    hadText: !!put.text,
  };
}

/**
 * Список писем дорисован и с ним можно работать: строки есть, а полоса загрузки
 * Gmail ушла.
 *
 * TODO(gmail-dom): #loading - блок "Загрузка..." самого Gmail. Он скрывается
 * стилем, поэтому смотрим на размеры, а не на наличие в разметке.
 */
function gmailListReadyFn(arg) {
  var rows = document.querySelectorAll(arg.row);
  if (!rows.length) return false;
  var loading = document.getElementById('loading');
  if (loading) {
    var r = loading.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return false;
  }
  return true;
}

/** Вход в аккаунт приоритетнее страницы входа: инбокс может нести оба признака. */
function probeStatus(parsed) {
  if (parsed && parsed.signedIn) return 'ready';
  if (parsed && parsed.signIn) return 'needs_login';
  return 'unknown';
}

const STATUS_RANK = { ready: 3, needs_login: 2, unknown: 1 };

/** Значение для CSS-селектора по атрибуту. */
function attrValue(v) {
  return String(v == null ? '' : v).replace(/["\\]/g, '\\$&');
}

class PlaywrightManager {
  constructor(store, dataDir) {
    this.store = store;
    this.dataDir = dataDir; // base dir for chrome user-data folders
    this.instances = new Map(); // profileId -> { context, port, page, queue, mac }
    this.activityWatchers = new Set(); // cb(profileId) - вкладка сменила адрес
    this.closeWatchers = new Set(); // cb(profileId) - профиль погас
  }

  /**
   * Подписка на "профиль погас". Нужна, чтобы снять флаг running в
   * profiles.json: пользователь может закрыть окно Chrome сам, и тогда о
   * событии никто, кроме менеджера, не узнает - в карточке профиль так и
   * висел бы запущенным.
   */
  onProfileClosed(cb) {
    this.closeWatchers.add(cb);
    return () => this.closeWatchers.delete(cb);
  }

  _notifyClosed(profileId) {
    for (const cb of this.closeWatchers) {
      try { cb(profileId); } catch (_e) { /* подписчик не должен ронять менеджер */ }
    }
  }

  /**
   * Подписка на "в профиле что-то изменилось": пользователь перешёл по адресу
   * или открыл новую вкладку. Момент входа в Gmail приложению больше ниоткуда
   * не приходит, а ждать следующего тика таймера долго.
   */
  onProfileActivity(cb) {
    this.activityWatchers.add(cb);
    return () => this.activityWatchers.delete(cb);
  }

  _notifyActivity(profileId) {
    for (const cb of this.activityWatchers) {
      try { cb(profileId); } catch (_e) { /* подписчик не должен ронять менеджер */ }
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
   * Поднять Chrome профиля ОБЫЧНЫМ запуском - так же, как его запустил бы
   * человек. Ни Playwright, ни одного флага автоматизации: пользователю здесь
   * входить в Gmail руками, а управляемый браузер Google на входе отклоняет.
   * Playwright подключится позже и сам, см. _connect.
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
    const fp = profile.fingerprint;

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${udd}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      `--window-size=${fp.screen.width - 100},${fp.screen.height - 120}`,
      // UA ставим флагом, а не через Playwright: он должен действовать с первой
      // секунды, в том числе пока мы не подключены. Версию берём у реально
      // установленного Chrome.
      `--user-agent=${fingerprint.userAgentFor(fp, detectChromeVersion(chromePath))}`,
      `--lang=${fp.languages[0]}`,
    ];
    if (url) args.push(url);

    logger.info('cdp', t('cdp.launching', { label: profile.label, port }));
    const proc = spawn(chromePath, args, { detached: false, stdio: 'ignore' });

    const inst = {
      proc, port, profileId: profile.id, fingerprint: fp, label: profile.label,
      // Профиль с mac-фингерпринтом: Gmail в нём ждёт Cmd+Enter вместо
      // Ctrl+Enter. Смотрим на platform, а не на UA: UA собирается под
      // установленный браузер и хранимым значением не является.
      mac: fp.platform === 'MacIntel' || /Mac OS X|Macintosh/.test(fp.userAgent || ''),
      // Цепочка задач по вкладке почты, см. _serial.
      queue: Promise.resolve(),
      // Playwright появится здесь только при первой работе с почтой.
      // Вкладки почт: адрес -> страница и индекс u/N -> страница, см.
      // _resolveMailPages.
      browser: null, context: null, pages: new Map(), pagesByIndex: new Map(),
      watch: null, seenKey: '', closing: false,
    };
    this.instances.set(profile.id, inst);

    proc.on('exit', () => {
      if (inst.closing) return;
      this._teardown(inst);
      this.instances.delete(profile.id);
      logger.warn('cdp', t('cdp.closed', { label: profile.label }));
      this._notifyClosed(profile.id);
    });

    try {
      await waitForDevtools(port);
    } catch (e) {
      this.instances.delete(profile.id);
      try { proc.kill(); } catch (_e) {}
      throw e;
    }

    // "Пользователь вошёл в почту" со стороны приложения выглядит как смена
    // адреса или заголовка вкладки. Раньше это ловилось событиями CDP, но
    // подключаться сейчас нельзя - опрашиваем /json, это дёшево и подключением
    // не является. Заодно снова ловим смену ОДНОГО заголовка без навигации.
    inst.watch = setInterval(async () => {
      try {
        const targets = await listTargets(port);
        const key = targets.map((x) => (x.url || '') + '|' + (x.title || '')).join('\n');
        if (key === inst.seenKey) return;
        inst.seenKey = key;
        this._notifyActivity(profile.id);
      } catch (_e) { /* браузер закрывается - обработает proc.on('exit') */ }
    }, WATCH_MS);

    logger.success('cdp', t('cdp.live', { label: profile.label, port }));
    return inst;
  }

  /**
   * Подключить Playwright к уже поднятому профилю. Вызывается ЛЕНИВО, только
   * из работы с почтой: пока идёт вход, подключения быть не должно.
   */
  async _connect(inst) {
    if (inst.context) return inst.context;
    if (!chromium) throw new Error(t('err.playwrightMissing'));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${inst.port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error(t('err.profileNotRunning'));
    context.setDefaultTimeout(this._t(T_LONG));
    inst.browser = browser;
    inst.context = context;
    // Фингерпринт ставим здесь: до подключения его поставить нечем. На уже
    // открытые вкладки он ляжет со следующей навигацией, а работа с почтой
    // всегда начинается с перехода в список писем.
    try {
      await context.addInitScript(fingerprint.injectionScript(inst.fingerprint));
    } catch (e) {
      logger.warn('cdp', t('cdp.fingerprintFailed', { label: inst.label, error: e.message }));
    }
    logger.debug('cdp', t('cdp.attached', { label: inst.label }));
    return context;
  }

  /** Отпустить Playwright и таймер опроса, не трогая сам браузер. */
  _teardown(inst) {
    if (inst.watch) { clearInterval(inst.watch); inst.watch = null; }
    const browser = inst.browser;
    inst.browser = null;
    inst.context = null;
    inst.pages = new Map();
    inst.pagesByIndex = new Map();
    if (browser) { try { browser.close(); } catch (_e) {} }
  }

  // ── Общие помощники по странице ──────────────────────────────────────

  /**
   * Множитель бюджетов ожидания из настроек. Перечитываем на каждом ожидании,
   * чтобы правка настройки применялась без перезапуска приложения - так же, как
   * это сделано с интервалом автоскана.
   */
  _waitScale() {
    const sys = this.store.get('system') || {};
    const n = Number(sys.waitScale);
    if (!Number.isFinite(n) || n <= 0) return 1;
    // Границы обязательны: ноль превратил бы любое ожидание в мгновенный отказ,
    // а слишком большое значение подвесило бы прогон на минуты.
    return Math.min(10, Math.max(0.5, n));
  }

  /** Бюджет ожидания с поправкой на настройку "терпение". */
  _t(base) {
    return Math.round(base * this._waitScale());
  }

  /**
   * Локатор первого ВИДИМОГО совпадения.
   *
   * Обычный `.first()` берёт первый элемент в порядке документа, и если он
   * скрыт, ожидание видимости на нём проваливается, хотя ниже на странице есть
   * подходящий. У Gmail так бывает постоянно: неприменимые пункты меню и
   * свёрнутые окна остаются в разметке скрытыми.
   */
  _visible(page, selector) {
    return page.locator(selector).filter({ visible: true }).first();
  }

  /** То же внутри своего мини-окна письма, а не по всей странице. */
  _visibleIn(scope, selector) {
    return scope.locator(selector).filter({ visible: true }).first();
  }

  /** Есть ли видимый элемент прямо сейчас (без ожидания). */
  async _exists(page, selector) {
    try { return (await this._visible(page, selector).count()) > 0; } catch (_e) { return false; }
  }

  /**
   * Дождаться элемента. По умолчанию именно видимого: почти всё, чего мы ждём,
   * дальше нажимается или читается, а скрытый элемент для этого не годится.
   */
  async _wait(page, selector, timeout = this._t(T_LONG), { visible = true } = {}) {
    try {
      const locator = visible ? this._visible(page, selector) : page.locator(selector).first();
      // Локатор уже отфильтрован по видимости, поэтому ждать нужно факт
      // совпадения: "attached" на нём означает "видимый элемент появился".
      await locator.waitFor({ state: 'attached', timeout });
      return true;
    } catch (_e) { return false; }
  }

  /**
   * Дождаться выполнения условия в странице. Проверка идёт на каждый кадр
   * отрисовки, а не по таймеру: условия дешёвые, а реакция получается
   * мгновенной.
   */
  async _waitFn(page, fn, arg, timeout = this._t(T_LONG)) {
    try {
      const handle = await page.waitForFunction(fn, arg, { timeout, polling: 'raf' });
      return handle ? await handle.jsonValue() : true;
    } catch (_e) { return false; }
  }

  /** Кликнуть, если видимый элемент есть. Возвращает, случился ли клик. */
  async _clickIf(page, selector, timeout = this._t(T_SHORT)) {
    try {
      await this._visible(page, selector).click({ timeout });
      return true;
    } catch (_e) { return false; }
  }

  /**
   * Кликнуть по первому селектору из списка, который виден. Именно перебором по
   * очереди, а не одним селектором через запятую, - см. SEL_ORDERED.
   *
   * Сначала ОДНО ожидание на весь список, и только потом клик по тому, что
   * нашлось. Прежний перебор кликами тратил на каждый селектор полный таймаут,
   * то есть до трёх бюджетов подряд там, где элемента просто нет.
   */
  async _clickOrdered(page, selectors, timeout = this._t(T_SHORT)) {
    const hit = await this._waitFn(page, anyVisibleFn, selectors, timeout);
    if (!hit) return null;
    // Начинаем с найденного, остальные остаются запасным путём: между
    // ожиданием и кликом Gmail мог перерисовать окно.
    const order = [selectors[hit - 1], ...selectors.filter((_s, i) => i !== hit - 1)];
    for (const selector of order) {
      if (await this._clickIf(page, selector, this._t(T_SHORT))) return selector;
    }
    return null;
  }

  // ── Вкладка с Gmail ──────────────────────────────────────────────────

  /** Все живые вкладки профиля: сначала похожие на Gmail, потом на страницу входа. */
  _pages(inst) {
    const pages = inst.context.pages().filter(
      (p) => !p.isClosed() && !/^(devtools|chrome-extension):/.test(p.url() || ''),
    );
    const weight = (p) => {
      const u = p.url() || '';
      if (/^https:\/\/mail\.google\.com\//.test(u)) return 0;
      if (/^https:\/\/accounts\.google\.com\//.test(u)) return 1;
      return 2;
    };
    return pages.sort((a, b) => weight(a) - weight(b));
  }

  /**
   * Разложить вкладки профиля по почтам.
   *
   * Одной вкладки на профиль больше нет: при мультилогине у каждой почты своя
   * вкладка, и работать надо ровно в её вкладке. Опознаём по адресу из пробы, а
   * индекс u/N держим вторым ключом - он полезен, когда заголовок вкладки ещё
   * не устоялся и адреса в нём нет.
   */
  async _resolveMailPages(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst) throw new Error(t('err.profileNotRunning'));
    await this._connect(inst);
    const byEmail = new Map();
    const byIndex = new Map();
    for (const page of this._pages(inst)) {
      let parsed = null;
      // Страница могла уйти в навигацию или закрыться прямо во время пробы.
      try { parsed = await page.evaluate(gmailProbeFn); } catch (_e) { continue; }
      if (probeStatus(parsed) !== 'ready') continue;
      const href = (parsed && parsed.href) || page.url() || '';
      const index = mailboxes.userIndexFromUrl(href);
      if (!byIndex.has(index)) byIndex.set(index, page);
      const email = (parsed && parsed.email) || '';
      if (email) {
        const key = mailboxes.normalizeEmail(email);
        if (!byEmail.has(key)) byEmail.set(key, page);
      }
    }
    inst.pages = byEmail;
    inst.pagesByIndex = byIndex;
    return { byEmail, byIndex };
  }

  /**
   * Статус входа в Gmail. Ходит ТОЛЬКО по HTTP /json и НИ К ЧЕМУ НЕ
   * ПОДКЛЮЧАЕТСЯ - это и есть та самая проверка, которая крутится, пока
   * пользователь вводит пароль. Подключись мы здесь, Google отклонил бы вход.
   *
   * Перебирает все вкладки профиля: Gmail может быть открыт не в стартовой.
   */
  async scanGmail(profileId, { quiet = false } = {}) {
    const inst = this.instances.get(profileId);
    if (!inst) throw new Error(t('err.profileNotRunning'));
    let targets = [];
    try { targets = await listTargets(inst.port); } catch (_e) { targets = []; }
    // Вкладку с почтой смотрим первой, страницу входа - следом.
    const weight = (x) => {
      const u = x.url || '';
      if (/^https:\/\/mail\.google\.com\//.test(u)) return 0;
      if (/^https:\/\/accounts\.google\.com\//.test(u)) return 1;
      return 2;
    };
    let best = null;
    // Перебираем ВСЕ вкладки, а не останавливаемся на первой готовой: при
    // мультилогине каждая почта живёт в своей вкладке, и нужен весь список.
    const found = [];
    const seen = new Set();
    for (const target of targets.sort((a, b) => weight(a) - weight(b))) {
      const probe = probeTarget(target);
      if (!best || STATUS_RANK[probe.status] > STATUS_RANK[best.status]) best = probe;
      if (probe.status !== 'ready' || !probe.email) continue;
      // Адрес пока не прочитан (инбокс ещё грузится) - почту не заводим:
      // опознать её нечем, следующий скан её подхватит.
      const key = mailboxes.normalizeEmail(probe.email);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ email: probe.email, userIndex: probe.userIndex || 0, href: probe.href });
    }
    const res = best || { status: 'unknown', email: '', href: '' };
    // Основной почтой профиля считаем первую найденную: на ней держатся аватар
    // и заголовки карточек.
    const out = {
      status: res.status,
      email: (found[0] && found[0].email) || res.email || '',
      href: res.href || '',
      mailboxes: found,
    };
    if (!quiet) {
      if (out.status === 'unknown') logger.warn('gmail', t('gmail.noTab', { id: profileId }));
      logger.info('gmail', t('gmail.scan', {
        id: profileId,
        status: t('gmailStatus.' + out.status),
        email: found.length
          ? ' (' + found.map((m) => m.email).join(', ') + ')'
          : (out.email ? ' (' + out.email + ')' : ''),
      }));
    }
    return out;
  }

  /**
   * Вкладка НУЖНОЙ почты профиля. Здесь и только здесь Playwright подключается к
   * браузеру: работа с почтой идёт уже после входа, а до неё профиль остаётся
   * неуправляемым.
   *
   * Вкладки приложение не открывает - это условие пользователя. Нет вкладки у
   * почты - отказываемся с пометкой `no_tab`, и движок исключает эту почту до
   * следующего скана.
   */
  async _mailPage(profileId, mailbox) {
    const inst = this.instances.get(profileId);
    if (!inst) throw new Error(t('err.profileNotRunning'));
    const mb = typeof mailbox === 'string' ? { email: mailbox } : (mailbox || {});
    await this._connect(inst);
    const { byEmail, byIndex } = await this._resolveMailPages(profileId);

    let page = null;
    if (mb.email) page = byEmail.get(mailboxes.normalizeEmail(mb.email)) || null;
    // Запасной путь по индексу: заголовок вкладки мог ещё не устояться, и адреса
    // в пробе нет. Индекс при этом виден прямо в адресе.
    if (!page && mb.userIndex != null) page = byIndex.get(Number(mb.userIndex)) || null;
    // Почта не названа вовсе (ручная проверка отправки) - берём любую готовую.
    if (!page && !mb.email && mb.userIndex == null) {
      page = byEmail.values().next().value || byIndex.values().next().value || null;
    }
    if (!page || page.isClosed()) {
      const err = new Error(t('err.mailboxNoTab', { email: mailboxes.label(mb) }));
      err.code = 'no_tab';
      throw err;
    }
    return { inst, page, userIndex: mb.userIndex != null ? Number(mb.userIndex) : mailboxes.userIndexFromUrl(page.url()) };
  }

  // ── Gmail automation ─────────────────────────────────────────────────
  // TODO(gmail-dom): all selectors above are best-effort and must be validated
  // against a live logged-in Gmail. We only drive stable, non-reversed Gmail
  // mechanisms (compose panel + Ctrl+Enter, DOM read of unread rows). No Gmail
  // API, no credentials - the user logs in by hand (Rules 4/6).

  /**
   * Провести задачу через очередь профиля. Рассылка и автоответ работают на
   * ОДНОЙ вкладке почты: пока идёт отправка, у профиля открыто мини-окно
   * письма, а автоответ в это же время уводит вкладку на тред - письмо
   * теряется, а текст ответа улетает не в то поле. Поэтому все действия по
   * Gmail выстраиваем в цепочку, как в расширении.
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
  async _refreshInbox(page) {
    if (await this._clickIf(page, SEL.refreshBtn)) {
      // Ждём не "какое-то время", а состояние: строки на месте, полоса загрузки
      // Gmail ушла. Пока она висит, список дорисовывается, и читать его рано.
      return !!(await this._waitFn(page, gmailListReadyFn, { row: SEL.row }, this._t(T_MED)));
    }
    // Кнопку не нашли или она не нажалась. Читать список "как есть" НЕЛЬЗЯ:
    // он может быть протухшим, и тогда уже отвеченная переписка снова выглядит
    // непрочитанной - именно так уходил второй автоответ в ту же переписку.
    // Перезагружаем страницу: это медленнее, зато список заведомо свежий.
    logger.debug('gmail', t('gmail.refreshMissing'));
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (_e) {
      return false;
    }
    return !!(await this._waitFn(page, gmailListReadyFn, { row: SEL.row }, this._t(T_LONG)));
  }

  /**
   * Горячая клавиша отправки. У профилей с mac-фингерпринтом Gmail ждёт
   * Cmd+Enter, а не Ctrl+Enter - подпись на кнопке в таком профиле так и
   * выглядит ("Send (⌘Enter)").
   */
  async _sendShortcut(page, inst, focusLocator) {
    const target = focusLocator || page.locator(SEL.replyBox).first();
    await target.evaluate((el) => el.focus()).catch(() => {});
    await page.keyboard.press(inst && inst.mac ? 'Meta+Enter' : 'Control+Enter');
  }

  // ── Мини-окно письма ─────────────────────────────────────────────────

  /**
   * Своё мини-окно письма по его data-compose-id: поднимаемся до диалога -
   * шапка с кнопками "свернуть/закрыть" лежит выше блока с полями, а нажатий по
   * чужому окну быть не должно, их на странице может висеть несколько. Если
   * диалога-предка нет, работаем с самим блоком.
   */
  _widget(page, cid) {
    const anchor = page.locator(`[data-compose-id="${attrValue(cid)}"]`);
    const dialog = page.locator('div[role="dialog"]').filter({ has: anchor });
    return dialog.or(anchor).first();
  }

  /** data-compose-id всех открытых мини-окон письма. */
  async _composeIds(page) {
    try {
      return await page.$$eval('[data-compose-id]',
        (nodes) => nodes.map((n) => n.getAttribute('data-compose-id')));
    } catch (_e) { return []; }
  }

  /**
   * Нажать "Написать" и дождаться СВОЕГО мини-окна. Каждое нажатие открывает
   * ещё одно окно, поэтому запоминаем уже открытые и берём появившееся.
   */
  async _openCompose(page) {
    const before = await this._composeIds(page);
    if (!(await this._clickIf(page, SEL.composeBtn, this._t(T_MED)))) return null;
    const appeared = await this._waitFn(page, (known) => {
      var n = document.querySelectorAll('[data-compose-id]');
      for (var i = 0; i < n.length; i++) {
        if (known.indexOf(n[i].getAttribute('data-compose-id')) < 0) return true;
      }
      return false;
    }, before, this._t(T_LONG));
    if (!appeared) return null;
    const fresh = (await this._composeIds(page)).filter((id) => before.indexOf(id) < 0);
    return fresh.length ? fresh[fresh.length - 1] : null;
  }

  /** Прочитать значение поля внутри своего мини-окна. */
  async _readField(widget, selector) {
    const el = this._visibleIn(widget, selector);
    if (!(await el.count())) return null;
    return el.evaluate((node) => String(node.value == null ? (node.innerText || '') : node.value))
      .catch(() => null);
  }

  /**
   * Навести фокус на поле внутри своего мини-окна и напечатать текст.
   * Печатаем клавиатурой: поле адресата - виджет Google, который слушает
   * настоящие события ввода, а не подстановку value. Результат проверяем и при
   * осечке подставляем значение напрямую.
   */
  async _typeInto(page, widget, selector, text) {
    const value = String(text == null ? '' : text);
    const el = this._visibleIn(widget, selector);
    if (!(await this._waitLocator(el, this._t(T_MED)))) return false;
    const focused = await el.evaluate((node) => {
      node.focus();
      if (node.select) { try { node.select(); } catch (e) {} }
      return true;
    }).catch(() => false);
    if (!focused) return false;
    await page.keyboard.insertText(value);

    if ((await this._readField(widget, selector)) === value) return true;
    // Запасной путь: значение напрямую плюс события, на которые виджет подписан.
    await el.evaluate((node, put) => {
      node.focus();
      if ('value' in node) node.value = put; else node.textContent = put;
      node.dispatchEvent(new InputEvent('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, value).catch(() => {});
    return (await this._readField(widget, selector)) === value;
  }

  /**
   * Дождаться конкретного локатора (без бросания исключения). Ждём видимости:
   * поля скрытого окна письма ни прочитать, ни заполнить нельзя.
   */
  async _waitLocator(locator, timeout = this._t(T_LONG)) {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch (_e) { return false; }
  }

  /**
   * Дождаться, пока адрес закрепится плашкой получателя. Условие целиком
   * живёт в странице (gmailRecipientFn), поэтому ждём именно появления плашки,
   * а не отмеряем паузу после нажатия.
   */
  async _waitRecipient(page, cid, address, timeout = this._t(T_SHORT)) {
    return !!(await this._waitFn(page, gmailRecipientFn, {
      cid: String(cid), needle: String(address || '').toLowerCase(),
    }, timeout));
  }

  /**
   * Вписать получателя и закрепить его. Просто набранный текст Gmail за
   * получателя не считает - при отправке он отвечает, что адрес не указан.
   * Закрепляем Tab, при осечке повторяем с запятой; Enter не годится - он
   * выберет подсказку из списка контактов, а это может быть чужой адрес.
   */
  async _setRecipient(page, widget, cid, to) {
    const commits = [
      () => page.keyboard.press('Tab'),
      () => page.keyboard.insertText(','),
    ];
    for (const commit of commits) {
      const typed = await this._typeInto(page, widget, SEL.to, to);
      if (!typed) continue;
      await commit();
      if (await this._waitRecipient(page, cid, to)) return true;
    }
    return false;
  }

  /**
   * Тело письма - contenteditable, перевод строки нужен настоящий.
   *
   * TODO(gmail-dom): проверено на живом аккаунте. execCommand('insertHTML')
   * молча вставляет ПУСТО, если ему дать документ целиком - разметку приводит к
   * пригодному виду htmlTemplate.mailSafe. Порядок попыток описан в putBodyFn.
   */
  async _fillBody(widget, text, { html = '', page = null, inst = null } = {}) {
    const el = this._visibleIn(widget, SEL.body);
    if (!(await this._waitLocator(el, this._t(T_MED)))) return false;
    const body = { html: String(html == null ? '' : html), text: String(text == null ? '' : text) };
    // Буфер обмена - основной путь для разметки: письмо разбирает сам Gmail,
    // ровно как при вставке руками. См. _pasteBody.
    const pasted = page ? await this._pasteBody(page, inst, el, body) : null;
    if (pasted) return this._notePut(pasted);
    const res = await el.evaluate(putBodyFn, body).catch(() => null);
    return this._notePut(res);
  }

  /**
   * Положить письмо через буфер обмена.
   *
   * execCommand('insertHTML') зависит от того, как поле относится к разметке, и
   * на живом аккаунте это уже подводило: письмо уходило то голым текстом, то
   * пустым. Вставка из буфера идёт через собственный обработчик Gmail - тот
   * самый, которым письмо вставляет человек, - и разметка доезжает так же.
   *
   * Возвращает null, если путь недоступен (нет разрешения на буфер, нечего
   * вставлять, вставка не прижилась) - тогда работает запасной putBodyFn.
   */
  async _pasteBody(page, inst, locator, body) {
    if (!body.html) return null;
    // Без разрешения Chrome отклоняет запись в буфер из скрипта: жеста
    // пользователя здесь нет.
    try {
      await inst.context.grantPermissions(['clipboard-read', 'clipboard-write'],
        { origin: 'https://mail.google.com' });
    } catch (_e) { /* не дали - поймём по результату ниже */ }

    // Вставка идёт настоящим нажатием клавиш, а его принимает активная
    // вкладка. Осечку это не исключает - тогда просто отработает запасной путь.
    await page.bringToFront().catch(() => {});

    const wrote = await page.evaluate(async (put) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([put.html], { type: 'text/html' }),
          'text/plain': new Blob([put.text], { type: 'text/plain' }),
        })]);
        return true;
      } catch (e) { return false; }
    }, body).catch(() => false);
    if (!wrote) return null;

    // Курсор в начало поля: в ответе там уже лежит цитата, и письмо должно
    // встать перед ней.
    const before = await locator.evaluate((node) => {
      node.focus();
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStart(node, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* вставка пойдёт в текущую позицию */ }
      return node.innerHTML.length;
    }).catch(() => null);
    if (before == null) return null;

    await page.keyboard.press(inst && inst.mac ? 'Meta+V' : 'Control+V');

    // Gmail разбирает вставку не мгновенно, поэтому ждём прирост, а не
    // проверяем сразу после нажатия.
    for (let i = 0; i < 20; i++) {
      const now = await locator.evaluate((node) => ({
        len: node.innerHTML.length,
        sample: String(node.innerHTML || '').slice(0, 200),
      })).catch(() => null);
      if (now && now.len > before) return { ok: true, how: 'clipboard', sample: now.sample };
      await page.waitForTimeout(100);
    }
    return null;
  }

  /**
   * Записать в журнал, чем и что легло в поле письма.
   *
   * Без этого осечку вставки нельзя было отличить от успеха: письмо уходило
   * пустым или голым текстом, а в логах об этом не было ни слова.
   */
  _notePut(res) {
    if (!res) {
      logger.error('gmail', t('gmail.bodyCrashed'));
      return false;
    }
    if (!res.ok) {
      // На осечке подробности обязательны: без них разбирать приходится по
      // скриншотам из почты, а это стоит человеку живых писем.
      logger.error('gmail', t('gmail.bodyFailed', {
        html: res.hadHtml ? '+' : '-',
        text: res.hadText ? '+' : '-',
        before: res.before,
        after: res.after,
        sample: res.sample,
      }));
      return false;
    }
    logger.debug('gmail', t('gmail.bodyPut', { how: res.how, sample: res.sample }));
    return true;
  }

  /**
   * Отправить первое письмо из запущенного профиля через мини-окно на самой
   * вкладке почты: нажимаем "Написать" (gh="cm"), заполняем поля своего окна и
   * жмём "Отправить". Отдельное окно ?view=cm остаётся запасным путём.
   */
  async gmailCompose(profileId, { mailbox, to, subject, body } = {}) {
    return this._serial(profileId, () => this._gmailCompose(profileId, { mailbox, to, subject, body }));
  }

  async _gmailCompose(profileId, { mailbox, to, subject, body } = {}) {
    if (!to) throw new Error(t('err.noRecipient'));
    const { inst, page, userIndex } = await this._mailPage(profileId, mailbox);

    // Уводим вкладку только на СВОЙ инбокс: чужой индекс u/N увёл бы вкладку
    // другой почты, и та осталась бы без своей страницы.
    if (!mailboxes.sameMailbox(page.url(), userIndex)) {
      await page.goto(mailboxes.inboxUrl(userIndex), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }

    if (!(await this._wait(page, SEL.composeBtn, this._t(T_LONG)))) {
      logger.warn('gmail', t('gmail.composeBtnMissing'));
      return this._composeViaWindow(inst, { to, subject, body, userIndex });
    }

    const cid = await this._openCompose(page);
    if (!cid) throw new Error(t('err.composeNotOpened'));
    const widget = this._widget(page, cid);

    let sent = false;
    try {
      // Не жмём "Отправить" вслепую: без закреплённого получателя Gmail выдаёт
      // свой алерт, окно остаётся висеть, а в логе - невнятное "не подтверждено".
      if (!(await this._setRecipient(page, widget, cid, to))) {
        throw new Error(t('err.recipientNotSet', { to }));
      }
      if (subject) await this._typeInto(page, widget, SEL.subject, subject);
      // Первое письмо уходит обычным текстом, разметки у него нет - буфер тут
      // не нужен, но page с inst передаём для единообразия пути.
      //
      // Результат проверяем обязательно: раньше он игнорировался, и письмо
      // уходило даже после записи "тело не легло" - продавец получал пустое.
      if (body && !(await this._fillBody(widget, body, { page, inst }))) {
        throw new Error(t('err.bodyNotFilled'));
      }

      let clicked = false;
      try {
        await this._visibleIn(widget, SEL.send).click({ timeout: this._t(T_SHORT) });
        clicked = true;
      } catch (_e) { clicked = false; }
      if (!clicked) {
        await this._sendShortcut(page, inst, this._visibleIn(widget, SEL.body));
      }

      // Отправленное окно закрывается само. Отдельно ловим подтверждение Gmail
      // со ссылкой отмены - её id не зависит от языка интерфейса.
      sent = await this._waitFn(page, (id) => {
        if (!document.querySelector('[data-compose-id="' + id + '"]')) return true;
        return !!document.getElementById('link_undo');
      }, String(cid), this._t(T_MED));
      if (sent) logger.success('gmail', t('gmail.sent', { to }));
      else logger.warn('gmail', t('gmail.sendUnconfirmed', { to }));
      return { ok: !!sent };
    } finally {
      // Своё окно за собой закрываем, иначе неудачные попытки копятся на
      // странице стопкой черновиков.
      if (!sent) {
        await this._visibleIn(widget, SEL.close).click({ timeout: this._t(T_SHORT) }).catch(() => {});
      }
    }
  }

  /**
   * Запасной путь: отдельная вкладка ?view=cm, если кнопки "Написать" нет.
   * Индекс аккаунта обязателен - иначе письмо ушло бы с первой почты профиля.
   */
  async _composeViaWindow(inst, { to, subject, body, userIndex = 0 } = {}) {
    const q = (s) => encodeURIComponent(String(s == null ? '' : s));
    const url = `https://mail.google.com/mail/u/${Number(userIndex) || 0}/?view=cm&fs=1&tf=1`
      + `&to=${q(to)}&su=${q(subject)}&body=${q(body)}`;

    const page = await inst.context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      if (!(await this._wait(page, SEL.send, this._t(T_LONG)))) {
        throw new Error(t('err.composeNotRendered'));
      }
      if (!(await this._clickIf(page, SEL.send, this._t(T_SHORT)))) {
        await this._sendShortcut(page, inst);
      }
      const sent = await this._waitFn(page, (sel) => {
        if (!document.querySelector(sel)) return true;
        return !!document.getElementById('link_undo');
      }, SEL.send, this._t(T_MED));
      if (sent) logger.success('gmail', t('gmail.sent', { to }));
      else logger.warn('gmail', t('gmail.sendUnconfirmed', { to }));
      return { ok: !!sent };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Строки списка писем для автоответчика.
   *
   * По умолчанию берём ВСЕ строки, а не только непрочитанные: решение "надо ли
   * отвечать" принимается по своему учёту диалогов (dialogStore) и по
   * lastMessageId строки, а не по прочитанности - она чужое состояние и
   * подводила уже дважды.
   */
  async gmailListThreads(profileId, { mailbox, unreadOnly = false, max = 25 } = {}) {
    return this._serial(profileId, () => this._listRows(profileId, { mailbox, unreadOnly, max }));
  }

  /** Прочитать строки списка писем на вкладке нужной почты. */
  async _listRows(profileId, { mailbox, unreadOnly = true, max = 25 } = {}) {
    const { page, userIndex } = await this._mailPage(profileId, mailbox);
    await this._ensureInbox(page, userIndex);
    // Свежесть списка обязательна. Не удалось обновить - лучше вернуть пусто,
    // чем отдать протухшие строки: по ним автоответ уйдёт повторно в переписку,
    // на которую уже отвечали. Так же поступает и расширение.
    if (!(await this._refreshInbox(page))) {
      logger.warn('gmail', t('gmail.listStale'));
      return [];
    }
    let list = [];
    try {
      list = await page.evaluate(gmailRowsFn, {
        unreadOnly: !!unreadOnly,
        max: Number(max) || 25,
        row: SEL.row,
        unreadRow: SEL.unreadRow,
      });
    } catch (_e) { list = []; }
    return (list || []).filter((x) => x && x.threadId);
  }

  /**
   * Вернуть вкладку в список писем. Признак списка - строки tr.zA: они есть и в
   * инбоксе, и в ярлыке, где пользователь мог остаться сам. Уводим на инбокс
   * только когда строк нет (открытый тред, другой сайт, окно письма).
   */
  async _ensureInbox(page, userIndex = 0) {
    // Своя вкладка почты: возвращать её надо на СВОЙ инбокс, чужой индекс u/N
    // увёл бы вкладку другого аккаунта.
    if (mailboxes.sameMailbox(page.url(), userIndex)) {
      if (await this._exists(page, SEL.row)) return true;
      // Из открытой переписки возвращаемся стрелкой "Назад", как это сделал бы
      // человек: Gmail тут одностраничный, и перезагрузка ради возврата в
      // список - лишние секунды на каждом ответе.
      if (await this._clickOrdered(page, SEL_ORDERED.backToInbox, this._t(T_SHORT))) {
        if (await this._wait(page, SEL.row, this._t(T_MED))) return true;
      }
    }
    await page.goto(mailboxes.inboxUrl(userIndex), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return this._wait(page, SEL.row, this._t(T_MED));
  }

  /**
   * Ответить в переписку. Используется автоответчиком.
   *
   * `payload` - строка (обычный текст) либо { text, html }: в режиме HTML в
   * письмо уходит разметка, а text остаётся запасным путём и текстовой
   * проекцией для журнала.
   */
  async gmailReply(profileId, mailbox, thread, payload) {
    const body = typeof payload === 'string' ? { text: payload, html: '' } : (payload || {});
    return this._serial(profileId, () => this._gmailReply(profileId, mailbox, thread, body));
  }

  /** Строка списка писем как локатор: по своему id, при промахе - по отправителю. */
  async _rowLocator(page, item) {
    const rid = String(item.rowId || '');
    if (rid) {
      const byId = page.locator(`${SEL.row}[id="${attrValue(rid)}"]`).first();
      if (await byId.count()) return byId;
    }
    const from = String(item.from || '').toLowerCase();
    if (from) {
      // Флаг "i" - адрес в разметке может быть в другом регистре.
      const byFrom = page.locator(SEL.row)
        .filter({ has: page.locator(`span[email="${attrValue(from)}" i]`) }).first();
      if (await byFrom.count()) return byFrom;
    }
    return null;
  }

  /**
   * Пункт "Ответить" в контекстном меню строки.
   *
   * TODO(gmail-dom): разметка снята с живого Gmail. Меню - div.J-M[role=menu],
   * пункты - div.J-N[role=menuitem], иконка внутри пункта это DIV, а не img:
   * div.J-N-JX.aDE.<класс>. Классы иконок соседних пунктов различаются одной
   * буквой, и промах молча увёл бы ответ не туда:
   *
   *   BS - Ответить        BR - Ответить всем
   *   BQ - Переслать       In - Переслать как вложение
   *   sX - Отметить как прочитанное   iA7v7d - Отметить как непрочитанное
   *
   * Пункты, неприменимые к строке, остаются в разметке со style="display:none",
   * поэтому и меню, и пункт берём только видимые.
   */
  async _clickReplyMenuItem(page) {
    const menu = page.locator('div[role="menu"]:visible').first();
    if (!(await this._waitLocator(menu, this._t(T_MED)))) return false;
    const items = menu.locator('div[role="menuitem"]:visible');
    try {
      await items.filter({ has: page.locator('div.J-N-JX.BS') }).first()
        .click({ timeout: this._t(T_SHORT) });
      return true;
    } catch (_e) { /* вёрстка поменялась - идём по подписи */ }
    // Запасной путь по подписи, строго целиком: рядом стоит "Ответить всем".
    // Матчим ТЕКСТ пункта, а не доступное имя - оно может склеиваться из
    // подписи и альтернативного текста иконки.
    for (const label of [/^Reply$/i, /^Ответить$/i]) {
      try {
        await items.filter({ hasText: label }).first().click({ timeout: this._t(T_SHORT) });
        return true;
      } catch (_e) { /* следующий язык */ }
    }
    return false;
  }

  /**
   * Открыть окно ответа ПРЯМО ИЗ СПИСКА писем: правый клик по строке ->
   * "Ответить". Gmail открывает обычное окно письма (data-compose-id) с уже
   * подставленными получателем и темой "Re: ...".
   *
   * Так лучше, чем заходить в переписку: вкладка остаётся на списке, возвращать
   * её не надо, и список не успевает протухнуть между ответами.
   *
   * Возвращает data-compose-id своего окна или null, если путь не сработал -
   * тогда вызывающий уходит на запасной путь через открытие переписки.
   */
  async _openReplyWidget(page, item) {
    const row = await this._rowLocator(page, item);
    if (!row) return null;
    const before = await this._composeIds(page);
    try {
      await row.click({ button: 'right', timeout: this._t(T_MED) });
    } catch (_e) { return null; }
    if (!(await this._clickReplyMenuItem(page))) {
      // Меню могло открыться, но нужного пункта мы не нашли - закрываем его,
      // иначе оно перекроет список для следующих действий.
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }
    const appeared = await this._waitFn(page, (known) => {
      var n = document.querySelectorAll('[data-compose-id]');
      for (var i = 0; i < n.length; i++) {
        if (known.indexOf(n[i].getAttribute('data-compose-id')) < 0) return true;
      }
      return false;
    }, before, this._t(T_LONG));
    if (!appeared) return null;
    const fresh = (await this._composeIds(page)).filter((id) => before.indexOf(id) < 0);
    return fresh.length ? fresh[fresh.length - 1] : null;
  }

  /**
   * Открыть переписку. Основной путь - клик по строке списка, как в расширении:
   * у строки инбокса есть только её собственный id вида ":15o", он живёт в
   * текущем рендере и адресом треда не является - переход на #inbox/:15o
   * никуда не ведёт. Строку ищем по id, при промахе (список перерисовался) - по
   * адресу отправителя. Настоящий data-legacy-thread-id, если он есть, остаётся
   * запасным путём через адрес.
   */
  async _openThread(page, item, userIndex = 0) {
    await this._ensureInbox(page, userIndex);
    const clicked = await page.evaluate((arg) => {
      var r = arg.rowId ? document.getElementById(arg.rowId) : null;
      if (r && !(r.matches && r.matches(arg.row))) r = null;
      if (!r && arg.from) {
        var rows = document.querySelectorAll(arg.row);
        for (var i = 0; i < rows.length && !r; i++) {
          var s = rows[i].querySelectorAll('span[email]');
          for (var j = 0; j < s.length; j++) {
            if ((s[j].getAttribute('email') || '').toLowerCase() === arg.from) { r = rows[i]; break; }
          }
        }
      }
      if (!r) return false;
      r.click();
      return true;
    }, {
      rowId: String(item.rowId || ''),
      from: String(item.from || '').toLowerCase(),
      row: SEL.row,
    }).catch(() => false);

    if (clicked && (await this._wait(page, SEL.thread, this._t(T_LONG)))) return true;

    // Запасной путь - адрес треда, но только если это настоящий id, а не id
    // строки: иначе получится заведомо мёртвая ссылка.
    if (!item.legacyId) return false;
    await page.goto(mailboxes.inboxUrl(userIndex) + '/' + encodeURIComponent(item.legacyId),
      { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return this._wait(page, SEL.thread, this._t(T_LONG));
  }

  /**
   * Ответить окном письма, открытым прямо из списка. Получатель и тема в нём уже
   * стоят от Gmail, наше дело - текст и "Отправить".
   */
  async _replyViaWidget(page, inst, item, tid, body) {
    const cid = await this._openReplyWidget(page, item);
    if (!cid) return null;
    const widget = this._widget(page, cid);

    let sent = false;
    try {
      if (!(await this._fillBody(widget, body.text, { html: body.html, page, inst }))) return null;

      let clicked = false;
      try {
        await this._visibleIn(widget, SEL.send).click({ timeout: this._t(T_SHORT) });
        clicked = true;
      } catch (_e) { clicked = false; }
      if (!clicked) {
        await this._sendShortcut(page, inst, this._visibleIn(widget, SEL.body));
      }

      sent = await this._waitFn(page, (id) => {
        if (!document.querySelector('[data-compose-id="' + id + '"]')) return true;
        return !!document.getElementById('link_undo');
      }, String(cid), this._t(T_MED));
      if (sent) logger.success('gmail', t('gmail.replySent', { tid }));
      else logger.warn('gmail', t('gmail.replyUnconfirmed', { tid }));
      // Своё письмо стало последним в треде. Отдаём его идентификатор наверх,
      // чтобы учёт диалогов не принял наш же ответ за новое письмо продавца.
      const lastMessageId = sent
        ? await this._waitRowMessageChanged(page, item, item.lastMessageId || '')
        : '';
      return { ok: !!sent, lastMessageId };
    } finally {
      // Неудачную попытку за собой убираем, иначе копятся черновики.
      if (!sent) await this._clickOrdered(page, SEL_ORDERED.discard, this._t(T_SHORT));
    }
  }

  /**
   * Идентификатор последнего письма треда в строке списка. После нашего ответа
   * он меняется на наш ответ - по нему автоответчик и понимает, что изменение
   * принесли мы сами, а не продавец.
   *
   * Ждём именно смены идентификатора, условием в самой странице: прежний цикл
   * перечитывал строку раз в 400 мс и в лучшем случае терял на этом почти
   * полсекунды на каждом ответе.
   */
  async _waitRowMessageChanged(page, item, was, timeout = this._t(T_MED)) {
    const id = await this._waitFn(page, gmailRowMessageFn, {
      rowId: String(item.rowId || ''),
      from: String(item.from || '').toLowerCase(),
      row: SEL.row,
      was: String(was || ''),
    }, timeout);
    return typeof id === 'string' ? id : '';
  }

  async _gmailReply(profileId, mailbox, thread, body) {
    const { inst, page, userIndex } = await this._mailPage(profileId, mailbox);
    const item = typeof thread === 'string' ? { threadId: thread } : (thread || {});
    const tid = item.threadId;
    if (!tid) throw new Error(t('err.noThreadId'));

    // Основной путь - ответить прямо из списка, не заходя в переписку.
    await this._ensureInbox(page, userIndex);
    const viaWidget = await this._replyViaWidget(page, inst, item, tid, body);
    if (viaWidget) return viaWidget;
    logger.debug('gmail', t('gmail.replyWidgetFallback'));

    const opened = await this._openThread(page, item, userIndex);
    if (!opened) {
      // Вкладку оставлять на треде нельзя: без списка писем следующий скан
      // ничего не найдёт, а отправка не найдёт кнопку "Написать".
      await this._ensureInbox(page, userIndex).catch(() => {});
      throw new Error(t('err.threadNotOpened'));
    }

    try {
      // Форма ответа может быть уже раскрыта - тогда кнопки "Ответить" нет и
      // жать нечего. Ошибкой это не считаем, проверяем по самому полю ввода.
      if (!(await this._exists(page, SEL.replyBox))) {
        if (!(await this._clickOrdered(page, SEL_ORDERED.replyBtn, this._t(T_MED)))) {
          logger.warn('gmail', t('gmail.replyBtnMissing'));
        }
      }
      if (!(await this._wait(page, SEL.replyBox, this._t(T_LONG)))) {
        throw new Error(t('err.replyBoxNotOpened'));
      }

      // Поле ответа берём видимое: SEL.replyBox это список селекторов через
      // запятую, и первым в документе может оказаться скрытый textbox.
      const box = this._visible(page, SEL.replyBox);
      const payload = {
        html: String((body && body.html) || ''),
        text: String((body && body.text) || ''),
      };
      const put = await this._pasteBody(page, inst, box, payload)
        || await box.evaluate(putBodyFn, payload).catch(() => null);
      // Пустое письмо продавцу хуже, чем неотправленное: оно занимает попытку
      // в диалоге и выглядит поломкой. Не легло тело - не отправляем.
      if (!this._notePut(put)) return { ok: false };

      // Сначала настоящая кнопка "Отправить" - она в форме ответа есть
      // (div[role=button].aoO). Горячая клавиша остаётся запасным путём, с
      // поправкой на mac-фингерпринт профиля.
      if (!(await this._clickOrdered(page, SEL_ORDERED.replySend, this._t(T_SHORT)))) {
        await this._sendShortcut(page, inst, box);
      }

      const sent = await this._waitFn(page,
        () => !document.querySelector('div[role=textbox][aria-label*=Body]'), null, this._t(T_MED));
      if (sent) logger.success('gmail', t('gmail.replySent', { tid }));
      else logger.warn('gmail', t('gmail.replyUnconfirmed', { tid }));
      return { ok: !!sent };
    } finally {
      // Возврат в список писем обязателен и при осечке - иначе вкладка так и
      // останется на треде и автоответ заглохнет до перезапуска.
      await this._ensureInbox(page, userIndex).catch(() => {});
    }
  }

  async stop(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst) return;
    // Флаг гасит обработчик context.on('close'): это наша остановка, а не
    // закрытие окна пользователем, и лог про неё уже свой.
    inst.closing = true;
    this.instances.delete(profileId);
    this._teardown(inst);
    try { inst.proc.kill(); } catch (_e) {}
    logger.info('cdp', t('cdp.stopped', { id: profileId }));
    this._notifyClosed(profileId);
  }

  async stopAll() {
    for (const id of [...this.instances.keys()]) {
      await this.stop(id);
    }
  }
}

module.exports = { PlaywrightManager, resolveChrome };
