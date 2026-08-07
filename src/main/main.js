'use strict';
/**
 * Electron entry point. Wires the store, profile store, Chrome/CDP manager and
 * the parser/sender engines, then opens the single-window UI.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

const { Store } = require('./store');
const { ProfileStore } = require('./profiles/profileStore');
const { ChromeManager } = require('./cdp/chromeManager');
const { ParserEngine } = require('./parser/parserEngine');
const { SenderEngine } = require('./sender/senderEngine');
const ipc = require('./ipc');
const logger = require('./logger');

let mainWindow = null;
let ctx = null;

function buildContext() {
  const userData = app.getPath('userData');
  const store = new Store(path.join(userData, 'settings.json'));
  const profileStore = new ProfileStore(path.join(userData, 'profiles.json'));
  const chrome = new ChromeManager(store, userData);
  const parser = new ParserEngine(store);
  const sender = new SenderEngine({ store, profileStore, chrome, parser });
  return { store, profileStore, chrome, parser, sender, userData };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#16181d',
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
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  ctx = buildContext();
  createWindow();
  ipc.register(ctx);
  logger.success('system', 'Gmail Manager started');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  try { ctx && (await ctx.chrome.stopAll()); } catch (_e) {}
});
