'use strict';
/**
 * Electron entry point. Wires the store, profile store, Playwright browser
 * manager and the parser/sender engines, then opens the single-window UI.
 */
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { ProfileStore } = require('./profiles/profileStore');
const { ContactStore } = require('./contacts/contactStore');
const { DialogStore } = require('./dialogs/dialogStore');
const { StatsStore } = require('./stats/statsStore');
const { MessageStore } = require('./messages/messageStore');
const { PlaywrightManager } = require('./cdp/chromeManager');
const { ParserEngine } = require('./parser/parserEngine');
const { SenderEngine } = require('./sender/senderEngine');
const { TextSwapper } = require('./ai/textSwap');
const ipc = require('./ipc');
const autoScan = require('./profiles/autoScan');
const appearance = require('./appearance');
const logger = require('./logger');
const i18n = require('./i18n');

// Схему картинки фона регистрируем до готовности приложения - позже Electron
// её уже не примет.
appearance.registerScheme();

// Каталог данных выбираем до whenReady: настройки, профили и переписки читаются
// сразу после готовности, и менять путь позже было бы поздно.
const portableNote = applyPortableMode();

let mainWindow = null;
let ctx = null;

/**
 * Портативный режим.
 *
 * Обычно данные лежат там, куда их кладёт Electron - в AppData пользователя.
 * Если рядом с программой положен файл "portable.txt", всё уходит в каталог
 * "data" рядом с ней: тогда приложение переносится на другую машину папкой
 * целиком, вместе с настройками, профилями и перепиской.
 *
 * Только для собранного приложения: в разработке рядом с exe лежит
 * node_modules/electron, и данные уехали бы туда.
 *
 * Возвращает строку для лога - писать в него отсюда нельзя, язык логгера
 * ставится позже, уже из настроек.
 */
function applyPortableMode() {
  if (!app.isPackaged) return null;
  const dir = path.dirname(app.getPath('exe'));
  if (!fs.existsSync(path.join(dir, 'portable.txt'))) return null;
  const data = path.join(dir, 'data');
  try {
    // Каталог рядом с программой может быть закрыт на запись - например, если
    // её положили в Program Files. Тогда остаёмся на обычном пути: приложение
    // должно запуститься в любом случае, пусть и не портативным.
    fs.mkdirSync(data, { recursive: true });
    fs.accessSync(data, fs.constants.W_OK);
    app.setPath('userData', data);
    return { key: 'sys.portableOn', params: {} };
  } catch (e) {
    return { key: 'sys.portableFailed', params: { error: e.message } };
  }
}

function buildContext() {
  const userData = app.getPath('userData');
  const store = new Store(path.join(userData, 'settings.json'));
  const profileStore = new ProfileStore(path.join(userData, 'profiles.json'));
  const contactStore = new ContactStore(path.join(userData, 'contacts.json'));
  const dialogStore = new DialogStore(path.join(userData, 'dialogs.json'));
  const statsStore = new StatsStore(path.join(userData, 'stats.json'));
  const messageStore = new MessageStore(path.join(userData, 'messages.json'));
  const chrome = new PlaywrightManager(store, userData);
  const parser = new ParserEngine(store);
  const aiTexts = new TextSwapper(store);
  const sender = new SenderEngine({ store, profileStore, chrome, parser, contactStore, dialogStore, statsStore, messageStore, aiTexts });
  return { store, profileStore, contactStore, dialogStore, statsStore, messageStore, chrome, parser, sender, aiTexts, userData };
}

/** Иконка окна и панели задач. Генерируется скриптом `npm run icon`; если её
    нет, Electron просто возьмёт свою - падать из-за этого нечему. */
function appIcon() {
  const file = path.join(__dirname, '..', '..', 'assets', 'icon-256.png');
  return fs.existsSync(file) ? file : undefined;
}

/**
 * Снимок окна для проверки интерфейса: `electron . --shot`, путь в SHOT_PATH,
 * необязательный SHOT_JS выполняется в странице перед съёмкой.
 *
 * Живёт в коде постоянно, потому что скриншот рабочего стола для Electron не
 * работает: окно рисуется на GPU, и GDI-захват отдаёт ровную заливку цветом
 * фона. Единственный честный способ увидеть интерфейс - capturePage.
 *
 * SHOT_RUN_STATUS - подменённый ответ `run:status` (JSON). Нужен, чтобы
 * посмотреть экран работающего прогона, не запуская движок: настоящий запуск
 * поднимает Chrome и рассылает реальные письма, и делать это ради проверки
 * вёрстки нельзя. Подмена ставится ПОСЛЕ ipc.register - иначе регистрация
 * второго хендлера на то же имя роняет весь набор обработчиков.
 *
 * SHOT_UPDATE - подменённое состояние обновления (JSON). Карточка обновления
 * появляется только у собранного приложения, когда на GitHub правда лежит
 * версия новее: иначе её вёрстку нельзя было бы увидеть вообще. Отправляем
 * событием, а не подменой хендлера, - окно уже спросило состояние при запуске.
 */
function wireShotMode(win) {
  if (!process.argv.includes('--shot')) return;
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    console.log('[renderer]', level, msg, '@', src + ':' + line);
  });
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      if (process.env.SHOT_RUN_STATUS) {
        const { ipcMain } = require('electron');
        const fake = JSON.parse(process.env.SHOT_RUN_STATUS);
        ipcMain.removeHandler('run:status');
        ipcMain.handle('run:status', () => fake);
      }
      // Набор фильтров площадки. Настоящий приходит с /parser/schema по
      // платному ключу, поэтому вёрстку условий иначе не посмотреть.
      if (process.env.SHOT_PARSER_FIELDS) {
        const { ipcMain } = require('electron');
        const fake = JSON.parse(process.env.SHOT_PARSER_FIELDS);
        ipcMain.removeHandler('parser:filterFields');
        ipcMain.handle('parser:filterFields', () => fake);
      }
      if (process.env.SHOT_UPDATE) {
        win.webContents.send('update:state', JSON.parse(process.env.SHOT_UPDATE));
        await new Promise((r) => setTimeout(r, 300));
      }
      if (process.env.SHOT_JS) {
        try { await win.webContents.executeJavaScript(process.env.SHOT_JS); }
        catch (e) { console.log('[shot-js]', e.message); }
        await new Promise((r) => setTimeout(r, 900));
      }
      // Снимаем дважды. Первый вызов может вернуть кадр, скомпонованный до
      // наших изменений: у неактивного окна композитор засыпает, и в файл
      // попадал экран, который был открыт до SHOT_JS. Первый кадр будит
      // отрисовку, второй показывает то, что действительно на экране.
      await win.webContents.capturePage();
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.SHOT_PATH || 'shot.png', img.toPNG());
      console.log('[shot] saved');
      app.quit();
    }, 2500);
  });
}

/** Геометрия окна между запусками: растянул на второй монитор - пусть таким и
    останется. Проверяем, что окно попадает хоть на один экран: монитор могли
    отключить, и окно уехало бы за пределы видимого. */
function savedBounds(store) {
  const b = store.get('window');
  if (!b || !b.width || !b.height) return null;
  const { screen } = require('electron');
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
  return visible ? b : null;
}

function createWindow() {
  const saved = savedBounds(ctx.store);
  mainWindow = new BrowserWindow({
    icon: appIcon(),
    width: (saved && saved.width) || 1320,
    height: (saved && saved.height) || 860,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
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
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    mainWindow.webContents.send('window:state', { maximized });
    ctx.store.set('window', { maximized });
  };
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);

  // Размеры пишем с задержкой: во время перетаскивания событие сыплется
  // десятками раз в секунду, и на каждое писать файл незачем. Развёрнутое
  // окно не запоминаем - иначе восстановится на весь экран без рамки.
  const saveBounds = debounce(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
    ctx.store.set('window', mainWindow.getBounds());
  }, 500);
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  if (saved && saved.maximized) mainWindow.maximize();
  wireShotMode(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/**
 * Разовые переносы данных при обновлении приложения.
 *
 * Архив чатов появился позже самих чатов, и всё, что накопилось до него,
 * пользователь просил считать архивом: это переписки с профилей, которых уже
 * нет или которые больше не используются. Флаг в настройках взводится один
 * раз - иначе перенос повторялся бы на каждом запуске и утаскивал в архив
 * свежие переписки.
 */
function runMigrations(context) {
  const done = context.store.get('migrations') || {};
  if (!done.chatsArchived) {
    const n = context.messageStore.archiveAll();
    context.store.set('migrations', { ...done, chatsArchived: true });
    if (n) logger.info('system', i18n.t('sys.chatsArchived', { n }));
  }

  // Мастер первого запуска появился позже самого приложения, и без этой
  // проверки он встретил бы всех, кто уже работает: в их настройках отметки о
  // мастере просто нет. Наличие профилей означает, что человек всё настроил
  // руками и объяснять ему нечего.
  if (!done.onboardingChecked) {
    if (context.profileStore.list().length) {
      context.store.set('onboarding', { done: true, tourDone: true });
    }
    context.store.set('migrations', { ...context.store.get('migrations'), onboardingChecked: true });
  }
}

app.whenReady().then(() => {
  // Меню File/Edit/View рисуется поверх своей шапки и ломает вид - убираем.
  Menu.setApplicationMenu(null);
  ctx = buildContext();
  // Язык логов берём из настроек до первой записи, иначе стартовые строки
  // ушли бы на языке по умолчанию.
  i18n.setLanguage(ctx.store.get('language'));
  // Каталог данных пишем в лог всегда: это первый вопрос при разборе любой
  // жалобы - где лежат настройки этого запуска.
  if (portableNote) logger.info('system', i18n.t(portableNote.key, portableNote.params));
  logger.info('system', i18n.t('sys.dataDir', { path: ctx.userData }));
  appearance.init(ctx.userData);
  runMigrations(ctx);
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
  require('./updater').stop();
  // Задача парсинга живёт на стороне API и закрытие приложения переживает.
  // Брошенная не даст завести такую же в следующий раз (409), а возобновить её
  // нечем - идентификатор отдаётся один раз. Поэтому убираем за собой здесь же.
  try { ctx && ctx.parser.stop(); } catch (_e) {}
  try { ctx && (await ctx.chrome.stopAll()); } catch (_e) {}
});
