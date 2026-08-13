'use strict';
/**
 * All IPC handlers. The renderer only ever talks to main through these named
 * channels (see preload.js). Keeps the privileged surface small and explicit.
 */
const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const logger = require('./logger');
const i18n = require('./i18n');
const { t } = i18n;
const telegram = require('./telegram/telegram');
const { DEFAULTS } = require('./store');
const htmlTemplate = require('./htmlTemplate');
const { resolveChrome } = require('./cdp/chromeManager');
const { scanAndPersist } = require('./profiles/autoScan');
const appearance = require('./appearance');
const updater = require('./updater');
const parserFilters = require('./parser/filters');
const xproject = require('./parser/apis/xproject');
const vvs = require('./parser/apis/vvs');
const aiClient = require('./ai/aiClient');

// Данные для превью HTML-шаблона, когда контактов рассылки ещё нет. Ссылка
// заведомо нерабочая: настоящую выдаёт API только под реальный заказ.
const DEMO_CONTACT = {
  name: 'seller',
  title: 'Casio AE-1000W Digital Watch',
  price: '20',
  imageUrl: '',
  datePublication: '',
  listingUrl: '',
};
const DEMO_LINK = 'https://example.com/confirm/demo';

function register(ctx) {
  const { store, profileStore, contactStore, chrome, parser, sender, aiTexts, mainWindow, userData } = ctx;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // Stream log entries to the renderer.
  logger.onLog((entry) => send('log:entry', entry));

  // ── window (своя шапка вместо рамки Windows) ──────────────────────
  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('window:isMaximized', () => ({
    maximized: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()),
  }));

  // ── settings ──────────────────────────────────────────────────────
  ipcMain.handle('settings:getAll', () => store.all());
  // Значения по умолчанию отдаём из store.js, а не держим вторую копию в
  // рендере: иначе кнопка сброса возвращала бы устаревшие числа.
  ipcMain.handle('settings:defaults', () => DEFAULTS);
  ipcMain.handle('settings:setSection', (_e, { key, value }) => {
    const saved = store.set(key, value);
    // Язык логов переключаем сразу, чтобы новые записи шли на выбранном
    // языке без перезапуска. Уже накопленный буфер не переписываем.
    if (key === 'language') {
      i18n.setLanguage(saved);
      logger.info('system', t('sys.languageChanged', { lang: i18n.getLanguage() }));
    }
    return saved;
  });
  // ── appearance (фон, акцент, движение) ────────────────────────────
  ipcMain.handle('appearance:get', () => store.get('appearance'));
  ipcMain.handle('appearance:set', (_e, patch) => store.set('appearance', patch));
  ipcMain.handle('appearance:pick', () => appearance.pick(store, mainWindow));
  ipcMain.handle('appearance:clear', () => appearance.clear(store));

  // ── перенос настроек файлом ───────────────────────────────────────
  // Файл настроек лежит в каталоге данных, найти его руками умеет не каждый.
  // Эти три вызова закрывают перенос на другую машину и резервную копию, не
  // заставляя искать AppData.

  // Ключи API - самое ценное в файле, и уносить их в копию нужно не всегда:
  // настройками делятся, чтобы повторить лимиты и оформление, а не доступы.
  const SECRET_FIELDS = [['parser', 'apiKey'], ['link', 'apiKey'], ['telegram', 'botToken'], ['ai', 'apiKey']];

  ipcMain.handle('settings:export', async (_e, { withSecrets } = {}) => {
    const res = await dialog.showSaveDialog(mainWindow || null, {
      title: t('backup.dialogSave'),
      defaultPath: 'gmail-manager-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, reason: 'cancelled' };

    const data = JSON.parse(JSON.stringify(store.all()));
    if (!withSecrets) for (const [section, key] of SECRET_FIELDS) {
      if (data[section]) data[section][key] = '';
    }
    // Геометрия окна к настройкам не относится: на другой машине монитор
    // другой, и окно открылось бы за краем экрана.
    delete data.window;

    try {
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf-8');
      logger.success('system', t('backup.exported', { path: res.filePath }));
      return { ok: true, path: res.filePath };
    } catch (e) {
      logger.warn('system', t('backup.writeFailed', { error: e.message }));
      return { ok: false, reason: 'write_failed', error: e.message };
    }
  });

  ipcMain.handle('settings:import', async () => {
    const res = await dialog.showOpenDialog(mainWindow || null, {
      title: t('backup.dialogOpen'),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, reason: 'cancelled' };

    let obj = null;
    try {
      obj = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
    } catch (e) {
      logger.warn('system', t('backup.readFailed', { error: e.message }));
      return { ok: false, reason: 'read_failed', error: e.message };
    }
    // Массив или строка - это не файл настроек. Отдать такое в replaceAll
    // значило бы затереть настройки мусором.
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      logger.warn('system', t('backup.badFormat'));
      return { ok: false, reason: 'bad_format' };
    }
    delete obj.window;
    // Картинка фона лежит файлом в каталоге данных, и на новой машине её нет.
    // Без сброса приложение осталось бы с пустым фоном вместо градиента.
    if (obj.appearance && obj.appearance.bgFile && !appearance.hasFile(obj.appearance.bgFile)) {
      obj.appearance = { ...obj.appearance, bgType: 'gradient', bgFile: '' };
    }

    const saved = store.replaceAll(obj);
    i18n.setLanguage(saved.language);
    logger.success('system', t('backup.imported'));
    return { ok: true, settings: saved };
  });

  // Каталог данных целиком: настройки, профили, переписки, картинка фона.
  ipcMain.handle('settings:openDataDir', async () => {
    const error = await shell.openPath(userData);
    if (error) {
      logger.warn('system', t('backup.openFailed', { error }));
      return { ok: false, error };
    }
    return { ok: true, path: userData };
  });

  // ── тексты рассылки: файл ──────────────────────────────────────────
  // Main только читает и пишет файл. Разбор и проверка формата живут в
  // рендере, чтобы правила были в одном месте и для файла, и для вставки.
  ipcMain.handle('texts:openFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow || null, {
      title: t('texts.dialogOpen'),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json', 'txt'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, reason: 'cancelled' };
    try {
      return { ok: true, content: fs.readFileSync(res.filePaths[0], 'utf-8') };
    } catch (e) {
      logger.warn('system', t('texts.readFailed', { error: e.message }));
      return { ok: false, reason: 'read_failed', error: e.message };
    }
  });

  ipcMain.handle('texts:saveFile', async (_e, content) => {
    const res = await dialog.showSaveDialog(mainWindow || null, {
      title: t('texts.dialogSave'),
      defaultPath: 'texts.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, reason: 'cancelled' };
    try {
      fs.writeFileSync(res.filePath, String(content == null ? '' : content), 'utf-8');
      return { ok: true, path: res.filePath };
    } catch (e) {
      logger.warn('system', t('texts.writeFailed', { error: e.message }));
      return { ok: false, reason: 'write_failed', error: e.message };
    }
  });

  // ── авто-ответ: HTML-шаблон ────────────────────────────────────────
  // Собирает письмо тот же модуль, что и при настоящей отправке: превью,
  // собранное в рендере по своим правилам, отличалось бы от того, что уходит.
  ipcMain.handle('autoreply:defaultHtml', () => htmlTemplate.DEFAULT_HTML);
  ipcMain.handle('autoreply:preview', (_e, { html } = {}) => {
    // Данные для превью берём у настоящего контакта - сразу видно, подставилось
    // ли название товара и грузится ли фото. Контактов нет - демо-набор.
    const list = contactStore ? contactStore.list() : [];
    const real = list
      .filter((c) => c && c.imageUrl)
      .sort((a, b) => (b.lastSentAt || 0) - (a.lastSentAt || 0))[0]
      || list.sort((a, b) => (b.lastSentAt || 0) - (a.lastSentAt || 0))[0]
      || null;
    const contact = real || DEMO_CONTACT;
    const built = htmlTemplate.render({
      template: String(html == null ? '' : html) || htmlTemplate.DEFAULT_HTML,
      contact,
      url: DEMO_LINK,
    });
    return { ...built, source: real ? 'contact' : 'demo', title: contact.title || '' };
  });

  // Тексты пришли ОТ ЧЕЛОВЕКА (загрузил файл, поправил строку) - значит это и
  // есть эталон, от которого нейронка будет отталкиваться на каждом обновлении.
  // Своей выдачей эталон она не переписывает, см. ai/textSwap.js.
  ipcMain.handle('settings:loadTexts', (_e, json) => {
    store.set('texts', json);
    if (aiTexts) aiTexts.rememberBaseline(json);
    logger.success('system', t('sys.textsLoaded'));
    return store.get('texts');
  });

  // ── обновление текстов нейронкой ──────────────────────────────────
  // Ключ провайдера через мост не ходит - берём его из настроек здесь же.
  ipcMain.handle('ai:state', () => (aiTexts ? aiTexts.state() : null));
  ipcMain.handle('ai:test', () => aiClient.test(store.get('ai') || {}));
  // Адреса и известные модели провайдеров живут в клиенте: своей копии в окне
  // быть не должно, иначе список моделей однажды разойдётся с настоящим.
  ipcMain.handle('ai:providers', () => aiClient.PROVIDERS);
  ipcMain.handle('ai:swapNow', () => (aiTexts ? aiTexts.swap({ auto: false }) : { ok: false, reason: 'no_engine' }));
  ipcMain.handle('ai:restoreBaseline', () => (aiTexts ? aiTexts.restoreBaseline() : { ok: false, reason: 'no_engine' }));
  // Тексты могли смениться посреди рассылки - окно должно показать новые, а не
  // те, что оно прочитало при открытии раздела.
  if (aiTexts) aiTexts.onChange((payload) => send('texts:changed', payload));

  // ── profiles ──────────────────────────────────────────────────────
  // Работает профиль или нет, знает менеджер браузеров, а не profiles.json:
  // в файле это снимок, который устаревает, стоит пользователю закрыть окно
  // Chrome самому. Отдаём в UI сверенное состояние, иначе профиль остаётся
  // "запущенным" до следующего запуска.
  const live = (p) => chrome.isRunning(p.id);
  const withRunState = (p) => {
    const running = live(p);
    return {
      ...p,
      running,
      port: running ? p.port : null,
      // У погашенного профиля вкладок нет по определению: признак из файла
      // устарел бы, и интерфейс показывал бы готовые почты у закрытого Chrome.
      mailboxes: (p.mailboxes || []).map((m) => ({ ...m, hasTab: running && !!m.hasTab })),
    };
  };
  // Флаги, оставшиеся от прошлого запуска приложения, ничего не запускают -
  // снимаем их сразу, чтобы файл не расходился с действительностью.
  for (const p of profileStore.list()) {
    if (p.running && !live(p)) profileStore.update(p.id, { running: false, port: null });
  }
  // Пользователь закрыл окно Chrome сам - гасим профиль и в файле. Рендер
  // подхватит это своим опросом profiles:list, отдельный канал не нужен.
  chrome.onProfileClosed((id) => {
    if (profileStore.get(id)) profileStore.update(id, { running: false, port: null });
  });

  ipcMain.handle('profiles:list', () => profileStore.list().map(withRunState));
  ipcMain.handle('profiles:stats', () => profileStore.stats(live));
  /**
   * Счётчики по каждому профилю для карточек: скольким написали, сколько
   * переписок завязалось, сколько автоответов ушло и сколько ссылок создано.
   * Первые три считаем на лету по двум журналам - отдельного хранилища для
   * этого заводить незачем. Ссылки так посчитать нельзя: генератор ничего не
   * пишет в журналы, поэтому их счётчик живёт в самом профиле.
   */
  ipcMain.handle('profiles:metrics', () => {
    const out = {};
    for (const p of profileStore.list()) {
      out[p.id] = {
        written: 0, dialogs: 0, replies: 0, lastSentAt: 0, links: p.linksCreated || 0,
      };
    }
    // lastSentAt берём из контактов: там уже стоит время последней отправки, и
    // отдельный журнал ради строки "активность N минут назад" не нужен.
    for (const c of (contactStore ? contactStore.list() : [])) {
      const row = out[c.profileId];
      if (!row) continue;
      row.written++;
      row.lastSentAt = Math.max(row.lastSentAt, c.lastSentAt || 0);
    }
    for (const d of (ctx.dialogStore ? ctx.dialogStore.list() : [])) {
      const row = out[d.profileId];
      if (!row) continue;
      row.dialogs++;
      row.replies += d.replies || 0;
    }
    return out;
  });
  ipcMain.handle('profiles:create', async (_e, { label }) => {
    const p = profileStore.create(label);
    logger.success('system', t('sys.profileCreated', { label: p.label }));
    return p;
  });
  ipcMain.handle('profiles:remove', async (_e, { id }) => {
    await chrome.stop(id).catch(() => {});
    // Переписки профиля уводим в архив ДО удаления: после него метки профиля
    // уже не найти, а выбрасывать письма вместе с аккаунтом нельзя - это то,
    // что человек реально написал и получил.
    const p = profileStore.get(id);
    if (ctx.messageStore) {
      const n = ctx.messageStore.archiveProfile(id);
      if (n) {
        logger.info('system', t('sys.chatsArchivedProfile', { label: (p && p.label) || id, n }));
      }
    }
    return profileStore.remove(id);
  });
  ipcMain.handle('profiles:launch', async (_e, { id, openGmail }) => {
    const p = profileStore.get(id);
    if (!p) throw new Error(t('err.profileNotFound'));
    // Открываем общий адрес почты, без индекса аккаунта: остальные вкладки
    // пользователь открывает сам, приложение их не заводит (Rules 6).
    const url = openGmail ? 'https://mail.google.com/mail/' : undefined;
    const inst = await chrome.launch(p, { url });
    profileStore.update(id, { running: true, port: inst.port });
    return profileStore.get(id);
  });
  ipcMain.handle('profiles:stop', async (_e, { id }) => {
    await chrome.stop(id);
    profileStore.update(id, { running: false, port: null });
    return profileStore.get(id);
  });
  ipcMain.handle('profiles:scan', async (_e, { id }) => scanAndPersist(ctx, id));

  // ── run control ───────────────────────────────────────────────────
  ipcMain.handle('run:start', () => sender.start());
  ipcMain.handle('run:stop', () => sender.stop());
  ipcMain.handle('run:pause', () => sender.pause());
  ipcMain.handle('run:resume', () => sender.resume());
  ipcMain.handle('run:status', () => sender.status());
  // Тестовый лид: своё письмо уходит обычным путём рассылки, чтобы можно было
  // ответить с этого адреса и посмотреть автоответ целиком.
  ipcMain.handle('run:testLead', (_e, { email, title, price }) => {
    const addr = String(email || '').trim();
    if (!addr) return { ok: false, reason: 'no_email' };
    const lead = {
      id: 'test-' + Date.now(),
      email: addr,
      name: addr.split('@')[0],
      platform: 'test',
      listingUrl: '',
      // Название уходит темой письма, название и цена идут в ссылку Haron.
      meta: {
        title: String(title || '').trim() || 'Casio AE-1000W Digital Watch',
        price: String(price || '').trim() || '20',
        currency: '', imageUrl: '', datePublication: '',
      },
    };
    return { ok: !!parser.pushLead(lead), lead };
  });
  ipcMain.handle('logs:recent', (_e, n) => logger.recent(n || 200));

  // ── фильтры парсинга ──────────────────────────────────────────────
  /**
   * Какие фильтры можно задать текущей паре "тип API + площадка".
   *
   * У XProject список зависит от площадки и живёт на стороне API - пробуем
   * получить его и говорим окну, настоящий он или документированный минимум
   * (live). Ключ API берём из настроек: через мост он не ходит.
   */
  ipcMain.handle('parser:filterFields', async (_e, opts) => {
    const p = store.get('parser');
    let live = null;
    if (p.apiType === 'xproject') {
      live = await xproject.fetchSchema(p.apiKey, { force: !!(opts && opts.force) });
    }
    return {
      apiType: p.apiType,
      platform: p.platform,
      live: !!live,
      fields: parserFilters.fields(p.apiType, p.platform, live),
      // Готовые значения - ровно то, что уйдёт в запрос. Окно их только
      // показывает: правила приведения живут в одном месте (filters.js), и
      // повторять их в рендере значило бы однажды разойтись.
      prepared: parserFilters.forRun(p),
    };
  });

  /**
   * Проверка фильтров: один запрос теми же настройками, что и рассылка.
   *
   * Никакой отдельной "тестовой" ветки нет нарочно - проверять надо ровно тот
   * запрос, который потом пойдёт в прогон. Отличается только одно: курсор
   * XProject не двигается, иначе проверка забрала бы страницу у рассылки.
   *
   * Ошибку запроса клиент пишет в журнал и возвращает пустой список, поэтому
   * "ноль объявлений" - это и "фильтры слишком узкие", и "запрос не прошёл";
   * окно отправляет человека в журнал за подробностями.
   *
   * Первая пачка приходит не сразу: задача у XProject только заводится, и
   * страница в этот момент пуста. Поэтому спрашиваем несколько раз - иначе
   * проверка объявляла бы пустым любой первый запрос.
   */
  ipcMain.handle('parser:test', async () => {
    const p = store.get('parser');
    if (!p.apiKey) return { ok: false, reason: 'no_key' };
    const sys = store.get('system');
    const client = p.apiType === 'vvs' ? vvs : xproject;
    const filters = parserFilters.forRun(p);
    const at = Date.now();
    logger.info('parser', t('parser.testStarted', {
      platform: p.platform,
      filters: Object.keys(filters).length ? JSON.stringify(filters) : '-',
    }));
    try {
      // probe заводит задачу, ждёт первых объявлений и убирает её за собой -
      // брошенная задача не даст завести такую же в следующий раз (409).
      const leads = await client.probe({
        apiKey: p.apiKey,
        platform: p.platform,
        countries: p.countries,
        filters,
        limit: sys.parserBatchSize,
      });
      logger.success('parser', t('parser.testResult', { count: leads.length }));
      return { ok: true, count: leads.length, ms: Date.now() - at };
    } catch (e) {
      logger.error('parser', t('parser.testFailed', { error: e.message }));
      return { ok: false, reason: 'failed', error: e.message };
    }
  });

  // ── статистика ────────────────────────────────────────────────────
  ipcMain.handle('stats:overview', (_e, days) => {
    const stats = ctx.statsStore;
    return {
      daily: stats ? stats.recent(days || 14) : [],
      totals: stats ? stats.totals() : { sent: 0, replies: 0, errors: 0 },
    };
  });

  // ── диалоги ───────────────────────────────────────────────────────
  // Список переписок автоответчика, обогащённый данными контакта: у самой
  // переписки названия товара нет, оно живёт в contactStore.
  ipcMain.handle('dialogs:list', () => {
    const byId = new Map(profileStore.list().map((p) => [p.id, p.label]));
    return (ctx.dialogStore ? ctx.dialogStore.list() : []).map((d) => {
      const c = contactStore ? contactStore.get(d.email) : null;
      return {
        key: d.key,
        threadId: d.threadId,
        profileId: d.profileId,
        profileLabel: byId.get(d.profileId) || '',
        mailbox: d.mailbox || '',
        email: d.email || '',
        replies: d.replies || 0,
        firstReplyAt: d.firstReplyAt || 0,
        lastReplyAt: d.lastReplyAt || d.firstReplyAt || 0,
        title: c ? c.title : '',
        price: c ? c.price : '',
        currency: c ? c.currency : '',
        known: !!c,
      };
    }).sort((a, b) => b.lastReplyAt - a.lastReplyAt);
  });

  // ── чаты ──────────────────────────────────────────────────────────
  /**
   * Список переписок для экрана чатов: свод из журнала сообщений, обогащённый
   * данными профиля, контакта и счётчиком автоответов из dialogStore.
   *
   * Чаты без единого записанного письма не отдаём: журнал появился позже
   * первых прогонов, и такие переписки показать всё равно нечем.
   */
  ipcMain.handle('chats:list', () => {
    const profiles = new Map(profileStore.list().map((p) => [p.id, p]));
    return (ctx.messageStore ? ctx.messageStore.chats() : []).map((c) => {
      const p = profiles.get(c.profileId);
      const contact = contactStore ? contactStore.get(c.email) : null;
      return {
        ...c,
        profileLabel: p ? p.label : '',
        profileEmail: p ? p.email : '',
        profileRunning: p ? !!chrome.isRunning(p.id) : false,
        profileStatus: p ? p.gmailStatus : 'unknown',
        // Профиля больше нет: писать в такую переписку неоткуда, и экран
        // говорит об этом прямо, а не оставляет пустое место вместо имени.
        profileGone: !p,
        // Отвечать вручную можно только там, где автоответ уже сработал: такой
        // диалог легко найти в инбоксе, см. замысел экрана чатов.
        //
        // Считаем по журналу, а не по dialogStore: журнал знает, что письмо
        // действительно ушло, а счётчик диалога опирается на идентификатор
        // треда, который к первому письму ещё не привязан.
        replies: c.autoReplies,
        contact: contact ? {
          title: contact.title || '', price: contact.price, currency: contact.currency || '',
          listingUrl: contact.listingUrl || '', imageUrl: contact.imageUrl || '',
          name: contact.name || '', platform: contact.platform || '',
          datePublication: contact.datePublication || '', sellerUrl: contact.sellerUrl || '',
          firstSentAt: contact.firstSentAt || 0, nudged: !!contact.nudged,
        } : null,
      };
    });
  });

  ipcMain.handle('chats:messages', (_e, { chatKey }) => (
    ctx.messageStore ? ctx.messageStore.byChat(chatKey) : []
  ));

  // ── contacts / nudge ──────────────────────────────────────────────
  ipcMain.handle('contacts:list', () => (contactStore ? contactStore.list() : []));
  ipcMain.handle('contacts:nudge', async (_e, { email }) => sender.nudge(email));

  // ── gmail (manual test send against a live logged-in profile) ─────
  ipcMain.handle('gmail:testSend', async (_e, { id, mailbox, to, subject, body }) => {
    const p = profileStore.get(id);
    if (!p) throw new Error(t('err.profileNotFound'));
    // Почта не выбрана - берём первую с открытой вкладкой: у профиля их может
    // быть несколько, и отправлять "куда-нибудь" нельзя.
    const box = (mailbox && profileStore.getMailbox(id, mailbox))
      || profileStore.mailboxes(id).find((m) => m.hasTab)
      || null;
    return chrome.gmailCompose(id, { mailbox: box, to, subject, body });
  });
  // Сухой прогон автоответа: скан непрочитанных без отправки.
  ipcMain.handle('gmail:dryRun', async (_e, { id }) => sender.dryRun(id));

  // ── обновление приложения ─────────────────────────────────────────
  // Версию берём из package.json через Electron: на главной она была зашита
  // строкой и после первого же обновления показывала бы неправду.
  ipcMain.handle('app:version', () => require('electron').app.getVersion());
  ipcMain.handle('update:state', () => updater.current());
  // Из окна проверку всегда просит человек - о неудаче ей говорить прямо, в
  // отличие от проверки по расписанию (см. updater.js).
  ipcMain.handle('update:check', () => updater.check({ manual: true }));
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', () => updater.install());
  updater.register((payload) => send('update:state', payload));

  // ── integrations ──────────────────────────────────────────────────
  ipcMain.handle('telegram:test', (_e, { botToken }) => telegram.test(botToken));
  ipcMain.handle('cdp:detectChrome', () => resolveChrome(store.get('cdp').chromePath) || '');

  logger.info('system', t('sys.ipcReady'));
}

module.exports = { register };
