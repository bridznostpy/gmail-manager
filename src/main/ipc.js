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

function register(ctx) {
  const { store, profileStore, contactStore, chrome, parser, sender, mainWindow } = ctx;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // Stream log entries to the renderer.
  logger.onLog((entry) => send('log:entry', entry));

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
  ipcMain.handle('settings:loadTexts', (_e, json) => {
    store.set('texts', json);
    logger.success('system', t('sys.textsLoaded'));
    return store.get('texts');
  });

  // ── profiles ──────────────────────────────────────────────────────
  ipcMain.handle('profiles:list', () => profileStore.list());
  ipcMain.handle('profiles:stats', () => {
    const s = profileStore.stats();
    s.portsOpen = chrome.openPortsCount() || s.portsOpen;
    return s;
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
