'use strict';
/**
 * Launches and controls one Chrome instance per profile through Playwright.
 *
 * Браузер - настоящий системный Chrome (`executablePath`), а не сборка
 * Playwright: пользователь входит в Gmail руками, и профиль должен выглядеть
 * обычным. Каждый профиль = свой `--user-data-dir`, поэтому куки и логины
 * изолированы и переживают перезапуск.
 *
 * Порт из диапазона [portStart, portEnd] выделяется по-прежнему и уходит в
 * `--remote-debugging-port`: он показывается в карточке профиля и позволяет
 * подцепиться к инстансу devtools вручную.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const fingerprint = require('./fingerprint');
const logger = require('../logger');
const { t } = require('../i18n');

// playwright-core тянем мягко: без него приложение должно открыться и сказать
// это словами, а не упасть на старте главного процесса.
let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (_e) { chromium = null; }

// Бюджеты ожидания. Взяты один в один с прежних циклов опроса
// (40 x 250 мс, 24 x 250 мс, 12 x 250 мс), чтобы поведение на живом Gmail
// не поехало после переноса.
const T_LONG = 10000;
const T_MED = 6000;
const T_SHORT = 3000;

const INBOX_URL = 'https://mail.google.com/mail/u/0/#inbox';

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

// TODO(gmail-dom): эвристика статуса входа по DOM. Проверять на живом
// залогиненном Gmail, догадками не расширять (Rules 4/6). Функция выполняется
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
  replyBtn: 'span.ams.bkH[role="link"], div[role="button"][aria-label^="Reply"], div.amn',
  row: 'tr.zA',
  unreadRow: 'tr.zA.zE',
  // Поле ввода в открытом окне ответа: своего мини-окна у него нет.
  replyBox: 'div[role=textbox][aria-label*=Body], div[role=textbox]',
  // Признак раскрытой переписки.
  thread: 'div.adn, div[role=listitem]',
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
    var s = r.querySelector('.bog, .y6 span');
    out.push({
      threadId: tid || rid, legacyId: tid, rowId: rid,
      from: pickEmail(r), subject: s ? s.textContent : '',
    });
  }
  return out;
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
   * Launch Chrome for a profile, apply the fingerprint to every tab of the
   * context, and (optionally) navigate to an initial URL (gmail.com on first
   * run for manual login).
   */
  async launch(profile, { url } = {}) {
    if (this.instances.has(profile.id)) {
      return this.instances.get(profile.id);
    }
    if (!chromium) throw new Error(t('err.playwrightMissing'));
    const chromePath = resolveChrome(this.store.get('cdp').chromePath);
    if (!chromePath) {
      throw new Error(t('err.chromeNotFound'));
    }
    const port = await this.allocatePort();
    const udd = this.userDataDir(profile.id);
    fs.mkdirSync(udd, { recursive: true });
    const fp = profile.fingerprint;

    logger.info('cdp', t('cdp.launching', { label: profile.label, port }));
    const context = await chromium.launchPersistentContext(udd, {
      executablePath: chromePath,
      // Обязательно: у Playwright headless по умолчанию ВКЛЮЧЁН, а профиль
      // должен открываться настоящим окном - пользователь входит в Gmail
      // руками (Rules 6).
      headless: false,
      // Тоже обязательно: у playwright песочница по умолчанию ВЫКЛЮЧЕНА, и он
      // подставляет --no-sandbox. Chrome на этот флаг вешает жёлтую плашку
      // "You are using an unsupported command-line flag" поверх страницы, а
      // профиль должен выглядеть обычным браузером. Заодно не отключаем защиту.
      chromiumSandbox: true,
      // Playwright по умолчанию поднимает Chrome с --enable-automation. Вход в
      // Google пользователь делает руками (Rules 6), а на такой браузер Google
      // отвечает "этот браузер небезопасен" - флаг снимаем.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        // Порт нужен не Playwright (он говорит по трубе), а нам: он виден в
        // карточке профиля и по нему можно подцепиться devtools вручную.
        `--remote-debugging-port=${port}`,
        '--disable-features=Translate,MediaRouter',
        `--window-size=${fp.screen.width - 100},${fp.screen.height - 120}`,
        `--lang=${fp.languages[0]}`,
      ],
      ...fingerprint.contextOptions(fp),
    });
    context.setDefaultTimeout(T_LONG);

    const inst = {
      context, port, profileId: profile.id,
      // Профиль с mac-фингерпринтом: Gmail в нём ждёт Cmd+Enter вместо Ctrl+Enter.
      mac: /Mac OS X|Macintosh/.test(fp.userAgent || ''),
      // Цепочка задач по вкладке почты, см. _serial.
      queue: Promise.resolve(),
      page: null,
      closing: false,
    };
    this.instances.set(profile.id, inst);

    // Одна строка вместо прежней связки Target.setAutoAttach +
    // waitForDebuggerOnStart: init-скрипт получают ВСЕ вкладки контекста, в том
    // числе те, что пользователь откроет потом. Вход в Gmail часто
    // заканчивается в отдельной вкладке, и без этого она шла бы с настоящими
    // platform/screen/WebGL, отличными от карточки профиля.
    try {
      await context.addInitScript(fingerprint.injectionScript(fp));
    } catch (e) {
      logger.warn('cdp', t('cdp.fingerprintFailed', { label: profile.label, error: e.message }));
    }

    // Вкладка сменила адрес - повод пересканировать профиль: именно так
    // выглядит "пользователь вошёл в почту" со стороны браузера.
    const wire = (page) => {
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) this._notifyActivity(profile.id);
      });
      page.on('load', () => this._notifyActivity(profile.id));
    };
    context.pages().forEach(wire);
    context.on('page', (page) => { wire(page); this._notifyActivity(profile.id); });

    // Пользователь может закрыть окно Chrome сам - профиль должен погаснуть и
    // в приложении, иначе рассылка продолжит стучаться в мёртвый контекст.
    context.on('close', () => {
      if (inst.closing) return;
      this.instances.delete(profile.id);
      logger.warn('cdp', t('cdp.closed', { label: profile.label }));
      this._notifyClosed(profile.id);
    });

    if (url) {
      const page = context.pages()[0] || (await context.newPage());
      inst.page = page;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    } else {
      inst.page = context.pages()[0] || null;
    }

    logger.success('cdp', t('cdp.live', { label: profile.label, port }));
    return inst;
  }

  // ── Общие помощники по странице ──────────────────────────────────────

  /** Есть ли элемент прямо сейчас (без ожидания). */
  async _exists(page, selector) {
    try { return (await page.locator(selector).first().count()) > 0; } catch (_e) { return false; }
  }

  /** Дождаться появления элемента. Как прежний _waitFor - по факту наличия в DOM. */
  async _wait(page, selector, timeout = T_LONG) {
    try {
      await page.locator(selector).first().waitFor({ state: 'attached', timeout });
      return true;
    } catch (_e) { return false; }
  }

  /** Дождаться выполнения предиката в странице. */
  async _waitFn(page, fn, arg, timeout = T_LONG) {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 250 });
      return true;
    } catch (_e) { return false; }
  }

  /** Кликнуть, если элемент есть. Возвращает, случился ли клик. */
  async _clickIf(page, selector, timeout = T_SHORT) {
    try {
      await page.locator(selector).first().click({ timeout });
      return true;
    } catch (_e) { return false; }
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
   * Найти среди вкладок профиля ту, где реально открыт Gmail, и запомнить её в
   * `inst.page`. Вход пользователь часто заканчивает в другой вкладке, а не в
   * той, что была открыта при запуске, - без этого скан читал бы чужую страницу.
   */
  async _resolveGmailPage(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.context) throw new Error(t('err.profileNotRunning'));
    let best = null;
    for (const page of this._pages(inst)) {
      let parsed = null;
      // Страница могла уйти в навигацию или закрыться прямо во время пробы.
      try { parsed = await page.evaluate(gmailProbeFn); } catch (_e) { continue; }
      const probe = {
        page,
        status: probeStatus(parsed),
        email: (parsed && parsed.email) || '',
        href: (parsed && parsed.href) || page.url() || '',
      };
      if (!best || STATUS_RANK[probe.status] > STATUS_RANK[best.status]) best = probe;
      if (best.status === 'ready') break;
    }
    if (!best) return { status: 'unknown', email: '', href: '' };

    if (best.status !== 'unknown' && best.page !== inst.page) {
      inst.page = best.page;
      logger.info('cdp', t('gmail.tabSwitched', { id: profileId }));
    } else if (!inst.page || inst.page.isClosed()) {
      inst.page = best.page;
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
    if (!inst || !inst.context) throw new Error(t('err.profileNotRunning'));
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

  /** Вкладка почты профиля, уже привязанная к залогиненному Gmail. */
  async _mailPage(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst || !inst.context) throw new Error(t('err.profileNotRunning'));
    await this._resolveGmailPage(profileId).catch(() => {});
    if (!inst.page || inst.page.isClosed()) throw new Error(t('err.profileNotRunning'));
    return { inst, page: inst.page };
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
    if (!(await this._clickIf(page, SEL.refreshBtn))) {
      logger.debug('gmail', t('gmail.refreshMissing'));
      return false;
    }
    // Список перерисовывается не мгновенно; ждём появления строк.
    await this._wait(page, SEL.row, T_SHORT);
    return true;
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
    if (!(await this._clickIf(page, SEL.composeBtn, T_MED))) return null;
    const appeared = await this._waitFn(page, (known) => {
      var n = document.querySelectorAll('[data-compose-id]');
      for (var i = 0; i < n.length; i++) {
        if (known.indexOf(n[i].getAttribute('data-compose-id')) < 0) return true;
      }
      return false;
    }, before, T_LONG);
    if (!appeared) return null;
    const fresh = (await this._composeIds(page)).filter((id) => before.indexOf(id) < 0);
    return fresh.length ? fresh[fresh.length - 1] : null;
  }

  /** Прочитать значение поля внутри своего мини-окна. */
  async _readField(widget, selector) {
    const el = widget.locator(selector).first();
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
    const el = widget.locator(selector).first();
    if (!(await this._waitLocator(el, T_MED))) return false;
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

  /** Дождаться конкретного локатора (без бросания исключения). */
  async _waitLocator(locator, timeout = T_LONG) {
    try {
      await locator.waitFor({ state: 'attached', timeout });
      return true;
    } catch (_e) { return false; }
  }

  /**
   * Получатель есть только тогда, когда адрес закреплён плашкой. Набранный в
   * поле текст не считаем: именно его Gmail и не признаёт получателем. Текст
   * блока получателей значение input не включает, так что попадание в него -
   * это уже плашка. Плашка известного контакта показывает имя, а не адрес,
   * поэтому дополнительно смотрим атрибуты.
   */
  async _hasRecipient(widget, address) {
    const box = widget.locator('[name="to"]').first();
    if (!(await box.count())) return false;
    return box.evaluate((node, needle) => {
      if ((node.innerText || node.textContent || '').toLowerCase().indexOf(needle) >= 0) return true;
      var nodes = node.querySelectorAll('[data-hovercard-id],[email],[title],[aria-label]');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.tagName === 'INPUT') continue;
        var s = ((n.getAttribute('data-hovercard-id') || '') + ' ' + (n.getAttribute('email') || '')
              + ' ' + (n.getAttribute('title') || '') + ' ' + (n.getAttribute('aria-label') || '')).toLowerCase();
        if (s.indexOf(needle) >= 0) return true;
      }
      return false;
    }, String(address || '').toLowerCase()).catch(() => false);
  }

  /**
   * Вписать получателя и закрепить его. Просто набранный текст Gmail за
   * получателя не считает - при отправке он отвечает, что адрес не указан.
   * Закрепляем Tab, при осечке повторяем с запятой; Enter не годится - он
   * выберет подсказку из списка контактов, а это может быть чужой адрес.
   */
  async _setRecipient(page, widget, to) {
    const commits = [
      () => page.keyboard.press('Tab'),
      () => page.keyboard.insertText(','),
    ];
    for (const commit of commits) {
      const typed = await this._typeInto(page, widget, SEL.to, to);
      if (typed) {
        await commit();
        if (await this._hasRecipient(widget, to)) return true;
      }
      await page.waitForTimeout(400);
    }
    return false;
  }

  /** Тело письма - contenteditable, перевод строки нужен настоящий. */
  async _fillBody(widget, text) {
    const el = widget.locator(SEL.body).first();
    if (!(await this._waitLocator(el, T_MED))) return false;
    return el.evaluate((node, put) => {
      node.focus();
      try { document.execCommand('insertText', false, put); }
      catch (e) { node.textContent = put; }
      node.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return true;
    }, String(text == null ? '' : text)).catch(() => false);
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
    if (!to) throw new Error(t('err.noRecipient'));
    const { inst, page } = await this._mailPage(profileId);

    if (!/mail\.google\.com/.test(page.url() || '')) {
      await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }

    if (!(await this._wait(page, SEL.composeBtn, T_LONG))) {
      logger.warn('gmail', t('gmail.composeBtnMissing'));
      return this._composeViaWindow(inst, { to, subject, body });
    }

    const cid = await this._openCompose(page);
    if (!cid) throw new Error(t('err.composeNotOpened'));
    const widget = this._widget(page, cid);

    let sent = false;
    try {
      // Не жмём "Отправить" вслепую: без закреплённого получателя Gmail выдаёт
      // свой алерт, окно остаётся висеть, а в логе - невнятное "не подтверждено".
      if (!(await this._setRecipient(page, widget, to))) {
        throw new Error(t('err.recipientNotSet', { to }));
      }
      if (subject) await this._typeInto(page, widget, SEL.subject, subject);
      if (body) await this._fillBody(widget, body);

      let clicked = false;
      try {
        await widget.locator(SEL.send).first().click({ timeout: T_SHORT });
        clicked = true;
      } catch (_e) { clicked = false; }
      if (!clicked) {
        await this._sendShortcut(page, inst, widget.locator(SEL.body).first());
      }

      // Отправленное окно закрывается само. Отдельно ловим подтверждение Gmail
      // со ссылкой отмены - её id не зависит от языка интерфейса.
      sent = await this._waitFn(page, (id) => {
        if (!document.querySelector('[data-compose-id="' + id + '"]')) return true;
        return !!document.getElementById('link_undo');
      }, String(cid), T_MED);
      if (sent) logger.success('gmail', t('gmail.sent', { to }));
      else logger.warn('gmail', t('gmail.sendUnconfirmed', { to }));
      return { ok: !!sent };
    } finally {
      // Своё окно за собой закрываем, иначе неудачные попытки копятся на
      // странице стопкой черновиков.
      if (!sent) {
        await widget.locator(SEL.close).first().click({ timeout: T_SHORT }).catch(() => {});
      }
    }
  }

  /** Запасной путь: отдельная вкладка ?view=cm, если кнопки "Написать" нет. */
  async _composeViaWindow(inst, { to, subject, body } = {}) {
    const q = (s) => encodeURIComponent(String(s == null ? '' : s));
    const url = 'https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1'
      + `&to=${q(to)}&su=${q(subject)}&body=${q(body)}`;

    const page = await inst.context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      if (!(await this._wait(page, SEL.send, T_LONG))) {
        throw new Error(t('err.composeNotRendered'));
      }
      if (!(await this._clickIf(page, SEL.send, T_SHORT))) {
        await this._sendShortcut(page, inst);
      }
      const sent = await this._waitFn(page, (sel) => {
        if (!document.querySelector(sel)) return true;
        return !!document.getElementById('link_undo');
      }, SEL.send, T_MED);
      if (sent) logger.success('gmail', t('gmail.sent', { to }));
      else logger.warn('gmail', t('gmail.sendUnconfirmed', { to }));
      return { ok: !!sent };
    } finally {
      await page.close().catch(() => {});
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
    const { page } = await this._mailPage(profileId);
    await this._ensureInbox(page);
    await this._refreshInbox(page);
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
  async _ensureInbox(page) {
    if (/mail\.google\.com/.test(page.url() || '')) {
      if (await this._exists(page, SEL.row)) return true;
    }
    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return this._wait(page, SEL.row, T_MED);
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
  async _openThread(page, item) {
    await this._ensureInbox(page);
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

    if (clicked && (await this._wait(page, SEL.thread, T_LONG))) return true;

    // Запасной путь - адрес треда, но только если это настоящий id, а не id
    // строки: иначе получится заведомо мёртвая ссылка.
    if (!item.legacyId) return false;
    await page.goto('https://mail.google.com/mail/u/0/#inbox/' + encodeURIComponent(item.legacyId),
      { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return this._wait(page, SEL.thread, T_LONG);
  }

  async _gmailReply(profileId, thread, text) {
    const { inst, page } = await this._mailPage(profileId);
    const item = typeof thread === 'string' ? { threadId: thread } : (thread || {});
    const tid = item.threadId;
    if (!tid) throw new Error(t('err.noThreadId'));

    const opened = await this._openThread(page, item);
    if (!opened) {
      // Вкладку оставлять на треде нельзя: без списка писем следующий скан
      // ничего не найдёт, а отправка не найдёт кнопку "Написать".
      await this._ensureInbox(page).catch(() => {});
      throw new Error(t('err.threadNotOpened'));
    }

    try {
      await this._clickIf(page, SEL.replyBtn, T_SHORT);
      if (!(await this._wait(page, SEL.replyBox, T_LONG))) {
        throw new Error(t('err.replyBoxNotOpened'));
      }

      const box = page.locator(SEL.replyBox).first();
      await box.evaluate((node, put) => {
        node.focus();
        try { document.execCommand('insertText', false, put); }
        catch (e) { node.textContent = put; }
        node.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }, String(text == null ? '' : text)).catch(() => {});
      // Кнопки "Отправить" в окне ответа может не быть на виду - шлём горячей
      // клавишей, с поправкой на mac-фингерпринт профиля.
      await this._sendShortcut(page, inst, box);

      const sent = await this._waitFn(page,
        () => !document.querySelector('div[role=textbox][aria-label*=Body]'), null, T_MED);
      if (sent) logger.success('gmail', t('gmail.replySent', { tid }));
      else logger.warn('gmail', t('gmail.replyUnconfirmed', { tid }));
      return { ok: !!sent };
    } finally {
      // Возврат в список писем обязателен и при осечке - иначе вкладка так и
      // останется на треде и автоответ заглохнет до перезапуска.
      await this._ensureInbox(page).catch(() => {});
    }
  }

  async stop(profileId) {
    const inst = this.instances.get(profileId);
    if (!inst) return;
    // Флаг гасит обработчик context.on('close'): это наша остановка, а не
    // закрытие окна пользователем, и лог про неё уже свой.
    inst.closing = true;
    this.instances.delete(profileId);
    try { await inst.context.close(); } catch (_e) {}
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
