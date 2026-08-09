'use strict';
/**
 * All IPC handlers. The renderer only ever talks to main through these named
 * channels (see preload.js). Keeps the privileged surface small and explicit.
 */
const { ipcMain } = require('electron');
const logger = require('./logger');
const i18n = require('./i18n');
const { t } = i18n;
const telegram = require('./telegram/telegram');
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
