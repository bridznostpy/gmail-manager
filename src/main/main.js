'use strict';
/**
 * Electron entry point. Wires the store, profile store, Playwright browser
 * manager and the parser/sender engines, then opens the single-window UI.
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

const { Store } = require('./store');
const { ProfileStore } = require('./profiles/profileStore');
const { ContactStore } = require('./contacts/contactStore');
const { DialogStore } = require('./dialogs/dialogStore');
const { PlaywrightManager } = require('./cdp/chromeManager');
const { ParserEngine } = require('./parser/parserEngine');
const { SenderEngine } = require('./sender/senderEngine');
const ipc = require('./ipc');
const autoScan = require('./profiles/autoScan');
const appearance = require('./appearance');
const logger = require('./logger');
const i18n = require('./i18n');

// Схему картинки фона регистрируем до готовности приложения - позже Electron
// её уже не примет.
appearance.registerScheme();

let mainWindow = null;
let ctx = null;

function buildContext() {
  const userData = app.getPath('userData');
  const store = new Store(path.join(userData, 'settings.json'));
  const profileStore = new ProfileStore(path.join(userData, 'profiles.json'));
  const contactStore = new ContactStore(path.join(userData, 'contacts.json'));
  const dialogStore = new DialogStore(path.join(userData, 'dialogs.json'));
  const chrome = new PlaywrightManager(store, userData);
  const parser = new ParserEngine(store);
  const sender = new SenderEngine({ store, profileStore, chrome, parser, contactStore, dialogStore });
  return { store, profileStore, contactStore, dialogStore, chrome, parser, sender, userData };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    // Своя шапка вместо рамки Windows: она же тащит окно и держит кнопки
    // свернуть/развернуть/закрыть (см. window:* в ipc.js).
    frame: false,
    backgroundColor: '#0b0d11',
    title: 'Gmail Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  ctx.mainWindow = mainWindow;
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  // Окно можно развернуть и мимо нашей кнопки (двойной клик по шапке, Win+Up,
  // Snap), поэтому иконку в UI ведём от событий окна, а не от своего флага.
  const sendState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // Меню File/Edit/View рисуется поверх своей шапки и ломает вид - убираем.
  Menu.setApplicationMenu(null);
  ctx = buildContext();
  // Язык логов берём из настроек до первой записи, иначе стартовые строки
  // ушли бы на языке по умолчанию.
  i18n.setLanguage(ctx.store.get('language'));
  appearance.init(ctx.userData);
  createWindow();
  ipc.register(ctx);
  // Статус Gmail подтягиваем сами: вход пользователь делает руками в браузере,
  // и никакого события об этом приложению не приходит.
  autoScan.startAutoScan(ctx);
  logger.success('system', i18n.t('sys.started'));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  autoScan.stopAutoScan();
  try { ctx && (await ctx.chrome.stopAll()); } catch (_e) {}
});
