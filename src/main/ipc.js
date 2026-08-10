'use strict';
/**
 * All IPC handlers. The renderer only ever talks to main through these named
 * channels (see preload.js). Keeps the privileged surface small and explicit.
 */
const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const logger = require('./logger');
const i18n = require('./i18n');
const { t } = i18n;
const telegram = require('./telegram/telegram');
const { DEFAULTS } = require('./store');
const { resolveChrome } = require('./cdp/chromeManager');
const { scanAndPersist } = require('./profiles/autoScan');
const appearance = require('./appearance');

function register(ctx) {
  const { store, profileStore, contactStore, chrome, parser, sender, mainWindow } = ctx;

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

  ipcMain.handle('settings:loadTexts', (_e, json) => {
    store.set('texts', json);
    logger.success('system', t('sys.textsLoaded'));
    return store.get('texts');
  });

  // ── profiles ──────────────────────────────────────────────────────
  // Работает профиль или нет, знает менеджер браузеров, а не profiles.json:
  // в файле это снимок, который устаревает, стоит пользователю закрыть окно
  // Chrome самому. Отдаём в UI сверенное состояние, иначе профиль остаётся
  // "запущенным" до следующего запуска.
  const live = (p) => chrome.isRunning(p.id);
  const withRunState = (p) => {
    const running = live(p);
    return { ...p, running, port: running ? p.port : null };
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
   * переписок завязалось и сколько автоответов ушло. Считаем на лету по двум
   * журналам - отдельного хранилища для этого заводить незачем.
   */
  ipcMain.handle('profiles:metrics', () => {
    const out = {};
    for (const p of profileStore.list()) out[p.id] = { written: 0, dialogs: 0, replies: 0 };
    for (const c of (contactStore ? contactStore.list() : [])) {
      const row = out[c.profileId];
      if (row) row.written++;
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
    return profileStore.remove(id);
  });
  ipcMain.handle('profiles:launch', async (_e, { id, openGmail }) => {
    const p = profileStore.get(id);
    if (!p) throw new Error(t('err.profileNotFound'));
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
  ipcMain.handle('gmail:testSend', async (_e, { id, to, subject, body }) => {
    const p = profileStore.get(id);
    if (!p) throw new Error(t('err.profileNotFound'));
    return chrome.gmailCompose(id, { to, subject, body });
  });
  // Сухой прогон автоответа: скан непрочитанных без отправки.
  ipcMain.handle('gmail:dryRun', async (_e, { id }) => sender.dryRun(id));

  // ── integrations ──────────────────────────────────────────────────
  ipcMain.handle('telegram:test', (_e, { botToken }) => telegram.test(botToken));
  ipcMain.handle('cdp:detectChrome', () => resolveChrome(store.get('cdp').chromePath) || '');

  logger.info('system', t('sys.ipcReady'));
}

module.exports = { register };
