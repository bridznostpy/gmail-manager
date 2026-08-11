'use strict';
/**
 * Обновление приложения с GitHub Releases.
 *
 * Ничего не качается само: приложение проверяет, вышла ли новая версия, и
 * говорит об этом окну. Скачивание начинается только после нажатия, и уже
 * скачанное ставится тоже по нажатию, с перезапуском. Человек, у которого идёт
 * прогон, не должен обнаружить, что приложение перезапустилось само.
 *
 * Состояние отдаётся рендеру одним каналом "update:state" с полем phase.
 * Держим его и здесь: окно может открыться позже проверки или перерисоваться,
 * и ему нужно откуда-то взять текущее состояние (см. update:state в ipc.js).
 *
 * Портативная сборка обновиться сама не может - установщика у неё нет. Для неё
 * фаза "unsupported" и ссылка на страницу загрузки: сказать о новой версии
 * честнее, чем молчать.
 */
const { app, shell } = require('electron');
const logger = require('./logger');
const { t } = require('./i18n');

// Первая проверка не сразу: на старте окно рисуется, тянутся профили и логи, и
// сетевой запрос в этот момент только мешает.
const FIRST_CHECK_MS = 4000;
const EVERY_MS = 6 * 60 * 60 * 1000;

const RELEASES_URL = 'https://github.com/bridznostpy/gmail-manager/releases/latest';

let autoUpdater = null;
let state = { phase: 'idle' };
let notify = () => {};
let timer = null;

function setState(next) {
  state = next;
  notify(state);
}

/** Идёт ли скачивание прямо сейчас - второй запрос в это время не нужен. */
function busy() {
  return state.phase === 'checking' || state.phase === 'progress';
}

/**
 * Портативная сборка. electron-builder ставит эту переменную только ей, и
 * только по ней портативный запуск отличается от установленного.
 */
function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_DIR;
}

function register(sendToWindow) {
  notify = sendToWindow;

  // В разработке проверять нечего: версия берётся из package.json, а релиза с
  // ней нет. Без этой проверки electron-updater пишет ошибку на каждом старте.
  if (!app.isPackaged) {
    setState({ phase: 'dev' });
    return;
  }

  if (isPortable()) {
    setState({ phase: 'idle', portable: true });
  }

  autoUpdater = require('electron-updater').autoUpdater;
  // Качаем только по нажатию - см. заголовок файла.
  autoUpdater.autoDownload = false;
  // Скачанное обновление ставится при выходе, даже если человек не нажал
  // "перезапустить": в следующий раз он откроет уже новую версию.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }));

  autoUpdater.on('update-available', (info) => {
    logger.info('system', t('upd.available', { version: info.version }));
    // Портативной сборке ставить обновление нечем: у неё нет установщика,
    // который заменил бы файл. Отдаём ссылку на страницу загрузки.
    if (isPortable()) {
      setState({ phase: 'unsupported', version: info.version, url: RELEASES_URL });
      return;
    }
    setState({ phase: 'available', version: info.version, notes: releaseNotes(info) });
  });

  autoUpdater.on('update-not-available', () => setState({ phase: 'none' }));

  autoUpdater.on('download-progress', (p) => setState({
    phase: 'progress',
    percent: Math.round(p.percent || 0),
    transferred: p.transferred || 0,
    total: p.total || 0,
    bytesPerSecond: p.bytesPerSecond || 0,
    version: state.version,
  }));

  autoUpdater.on('update-downloaded', (info) => {
    logger.success('system', t('upd.downloaded', { version: info.version }));
    setState({ phase: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    const message = (err && err.message) || String(err);
    logger.warn('system', t('upd.failed', { error: message }));
    setState({ phase: 'error', error: message });
  });

  timer = setTimeout(() => {
    check();
    timer = setInterval(check, EVERY_MS);
  }, FIRST_CHECK_MS);
}

/**
 * Описание релиза строкой. GitHub отдаёт его текстом, но у других провайдеров
 * это список объектов - берём только то, что точно текст, иначе в окно уехало
 * бы "[object Object]".
 */
function releaseNotes(info) {
  const notes = info && info.releaseNotes;
  return typeof notes === 'string' ? notes : '';
}

function check() {
  if (!autoUpdater || busy()) return state;
  autoUpdater.checkForUpdates().catch(() => {
    // Ошибку уже записал обработчик error - здесь ловим только отказ промиса,
    // чтобы он не всплыл необработанным и не уронил процесс.
  });
  return state;
}

function download() {
  if (!autoUpdater) return state;
  // Портативной сборке качать незачем - открываем страницу релиза.
  if (isPortable()) {
    shell.openExternal(RELEASES_URL);
    return state;
  }
  if (state.phase !== 'available') return state;
  setState({ phase: 'progress', percent: 0, version: state.version });
  autoUpdater.downloadUpdate().catch(() => {});
  return state;
}

/** Перезапуск с установкой. Возвращает управление только если ставить нечего. */
function install() {
  if (!autoUpdater || state.phase !== 'ready') return { ok: false };
  logger.info('system', t('upd.installing'));
  // Второй аргумент - "поставить молча": окно установщика поверх экрана
  // человеку ничего не сообщает, он уже нажал кнопку в приложении.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { ok: true };
}

function current() {
  return state;
}

function stop() {
  clearTimeout(timer);
  clearInterval(timer);
}

module.exports = { register, check, download, install, current, stop };
