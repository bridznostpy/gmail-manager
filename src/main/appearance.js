'use strict';
/**
 * Картинка фона приложения.
 *
 * Выбранный файл КОПИРУЕТСЯ в userData/appearance - оригинал пользователь
 * волен потом удалить или перенести, а фон должен пережить перезапуск.
 *
 * Отдаётся рендеру не по file://, а через свою схему appbg: политика
 * безопасности окна (`default-src 'self'`) файловые ссылки не пускает, а
 * ослаблять её ради одной картинки не хочется. Обработчик схемы отдаёт ТОЛЬКО
 * файлы из этого каталога - имя из URL нормализуется и сверяется с ним.
 */
const fs = require('fs');
const path = require('path');
const { dialog, net, protocol } = require('electron');
const logger = require('./logger');
const { t } = require('./i18n');

const SCHEME = 'appbg';
const DIR_NAME = 'appearance';
const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];

let dirPath = null;

/** Регистрация схемы. Обязана быть вызвана ДО app.whenReady(). */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function init(userData) {
  dirPath = path.join(userData, DIR_NAME);
  fs.mkdirSync(dirPath, { recursive: true });
  protocol.handle(SCHEME, (request) => {
    const file = resolveSafe(new URL(request.url).pathname);
    if (!file) return new Response('', { status: 404 });
    return net.fetch('file://' + file.split(path.sep).join('/'));
  });
}

/**
 * Абсолютный путь к файлу фона по имени из URL. Возвращает null на всём, что
 * выходит за каталог: путь склеиваем и сверяем с каталогом уже нормализованным,
 * чтобы "../.." не увели наружу.
 */
function resolveSafe(name) {
  if (!dirPath || !name) return null;
  const base = path.basename(decodeURIComponent(name));
  if (!base || !ALLOWED_EXT.includes(path.extname(base).toLowerCase())) return null;
  const full = path.resolve(dirPath, base);
  if (path.dirname(full) !== path.resolve(dirPath)) return null;
  return fs.existsSync(full) ? full : null;
}

function removeFile(name) {
  const full = resolveSafe(name);
  if (full) { try { fs.unlinkSync(full); } catch (_e) {} }
}

/**
 * Диалог выбора картинки. Возвращает { ok, file } - имя нового файла внутри
 * каталога, уже с меткой времени, чтобы браузер не показал старую из кеша.
 */
async function pick(store, parentWindow) {
  const res = await dialog.showOpenDialog(parentWindow || null, {
    title: t('appear.dialogTitle'),
    properties: ['openFile'],
    filters: [{ name: t('appear.dialogFilter'), extensions: ALLOWED_EXT.map((e) => e.slice(1)) }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, reason: 'cancelled' };

  const src = res.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return { ok: false, reason: 'bad_format' };

  const name = 'bg-' + Date.now() + ext;
  try {
    fs.copyFileSync(src, path.join(dirPath, name));
  } catch (e) {
    logger.error('system', t('appear.copyFailed', { error: e.message }));
    return { ok: false, reason: 'copy_failed' };
  }
  const prev = store.get('appearance').bgFile;
  if (prev && prev !== name) removeFile(prev);
  const saved = store.set('appearance', { bgType: 'image', bgFile: name });
  logger.success('system', t('appear.picked'));
  return { ok: true, appearance: saved };
}

/** Сброс на градиент: файл удаляем, чтобы каталог не копил старые картинки. */
function clear(store) {
  const prev = store.get('appearance').bgFile;
  if (prev) removeFile(prev);
  const saved = store.set('appearance', { bgType: 'gradient', bgFile: '' });
  logger.info('system', t('appear.cleared'));
  return { ok: true, appearance: saved };
}

module.exports = { registerScheme, init, pick, clear, SCHEME };
