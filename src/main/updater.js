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
 *
 * Неудачная проверка - не происшествие. Сеть на старте поднимается позже окна,
 * а пока на GitHub нет опубликованного релиза, запрос вообще отвечает 404.
 * Раньше любой такой отказ уходил в журнал предупреждением "Не удалось
 * проверить обновление" на каждом запуске и выключал проверку на шесть часов.
 * Теперь автоматическая проверка повторяется несколько раз и говорит спокойной
 * строкой, а жалуется только та, которую человек запросил сам.
 */
const { app, shell } = require('electron');
const logger = require('./logger');
const { t } = require('./i18n');

// Первая проверка не сразу: на старте окно рисуется, тянутся профили и логи, и
// сетевой запрос в этот момент только мешает.
const FIRST_CHECK_MS = 4000;
const EVERY_MS = 6 * 60 * 60 * 1000;
// Задержки повторов после неудачной автоматической проверки. Две попытки
// покрывают обычный случай "интернет появился через минуту после запуска";
// дальше ждём общего расписания, чтобы не долбить GitHub впустую.
const RETRY_MS = [20 * 1000, 2 * 60 * 1000];

const RELEASES_URL = 'https://github.com/bridznostpy/gmail-manager/releases/latest';

let autoUpdater = null;
let state = { phase: 'idle' };
let notify = () => {};
let timer = null;
let retryTimer = null;
// Сколько повторов уже израсходовано и что идёт прямо сейчас. Обработчик
// "error" один на проверку и на скачивание, а сказать о них надо разное.
let retryAt = 0;
let stage = 'check';
let manual = false;

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

  autoUpdater.on('update-not-available', () => {
    retryAt = 0;
    setState({ phase: 'none' });
  });

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
    const reason = describe(err);
    // Скачивание человек начал сам и ждёт результата - о его отказе говорим
    // сразу и прямо.
    if (stage === 'download') {
      logger.warn('system', t('upd.downloadFailed', { error: reason }));
      setState({ phase: 'error', error: reason });
      return;
    }
    if (manual) {
      logger.warn('system', t('upd.failed', { error: reason }));
      setState({ phase: 'error', error: reason });
      return;
    }
    // Автоматическая проверка идёт сама, о ней никто не просил. Пишем спокойной
    // строкой и пробуем ещё раз: чаще всего сеть просто ещё не поднялась.
    logger.info('system', t('upd.checkRetry', { error: reason }));
    setState({ phase: 'error', error: reason, silent: true });
    scheduleRetry();
  });

  timer = setTimeout(() => {
    check();
    timer = setInterval(check, EVERY_MS);
  }, FIRST_CHECK_MS);
}

/**
 * Причина отказа человеческими словами.
 *
 * electron-updater отдаёт текст для разработчика ("HttpError: 404 Not Found...")
 * - в журнале приложения он не объясняет ничего. Разбираем два случая, из-за
 * которых проверка не проходит почти всегда, остальное оставляем как есть:
 * выдумывать объяснение к незнакомой ошибке хуже, чем показать её текст.
 */
function describe(err) {
  const message = (err && err.message) || String(err);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENETDOWN|net::ERR/i.test(message)) {
    return t('upd.errNetwork');
  }
  // 404 на /releases/latest означает ровно одно: опубликованного релиза нет
  // (черновик для GitHub не существует). Без latest.yml - то же самое.
  if (/404|Not Found|latest\.yml|no published|Unable to find latest version/i.test(message)) {
    return t('upd.errNoRelease');
  }
  return message;
}

/** Повтор неудачной автоматической проверки, пока попытки не кончились. */
function scheduleRetry() {
  if (retryAt >= RETRY_MS.length) return;
  const wait = RETRY_MS[retryAt++];
  clearTimeout(retryTimer);
  retryTimer = setTimeout(check, wait);
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

/**
 * Проверить обновление. Дожидаемся ответа, а не возвращаем состояние сразу:
 * окно спрашивает проверку по нажатию и показывает то, что вернулось, - раньше
 * оно успевало получить состояние прошлой проверки и говорило неправду.
 *
 * `manual` отличает нажатие человека от проверки по расписанию: у них разный
 * разговор при неудаче (см. обработчик error).
 */
async function check(opts) {
  if (!autoUpdater || busy()) return state;
  manual = !!(opts && opts.manual);
  stage = 'check';
  // Человек нажал сам - счётчик повторов начинаем заново и снимаем отложенный:
  // ответ нужен сейчас, а не по расписанию прошлых неудач.
  if (manual) {
    retryAt = 0;
    clearTimeout(retryTimer);
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (_e) {
    // Отказ промиса ловим только чтобы он не всплыл необработанным: саму
    // ошибку уже записал обработчик error, он же выставил состояние.
  }
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
  stage = 'download';
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
  // Отложенный повтор тоже снимаем: без этого он пережил бы остановку и
  // разбудил проверку уже после закрытия окна.
  clearTimeout(retryTimer);
}

module.exports = { register, check, download, install, current, stop };
