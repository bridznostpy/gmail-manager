'use strict';
/**
 * Локализация main-процесса: сообщения логгера, тексты ошибок и уведомления
 * в Telegram. Интерфейс рендерера переводится отдельно (src/renderer/i18n.js) -
 * рендерер только показывает готовые строки отсюда, поэтому словари не
 * пересекаются и дублировать их не нужно.
 *
 * Язык берётся из настроек при старте (main.js) и обновляется, когда
 * пользователь переключает его в UI (ipc.js, settings:setSection).
 *
 * t('ключ', { name: 'X' }) подставляет {name}. Неизвестный ключ возвращается
 * как есть - промах виден в логе, но прогон не падает.
 */

const DICT = {
  ru: {
    // ── Система и IPC ───────────────────────────────────────
    'sys.started': 'Gmail Manager запущен',
    'sys.ipcReady': 'Обработчики IPC зарегистрированы',
    'sys.textsLoaded': 'Тексты рассылки загружены',
    'sys.profileCreated': 'Создан профиль "{label}"',
    'sys.languageChanged': 'Язык приложения переключён на {lang}',

    // ── Ошибки ──────────────────────────────────────────────
    'err.profileNotFound': 'Профиль не найден',
    'err.profileNotRunning': 'Профиль не запущен',
    'err.noLeadEmail': 'у лида нет адреса получателя',
    'err.noRecipient': 'не указан адрес получателя',
    'err.composeNotRendered': 'окно письма не открылось (аккаунт не залогинен?)',
    'err.composeNotOpened': 'мини-окно письма не появилось после нажатия "Написать"',
    'err.recipientNotSet': 'адрес {to} не попал в поле получателя, отправка отменена',
    'err.threadNotOpened': 'переписка не открылась',
    'err.replyBoxNotOpened': 'поле ответа не открылось',
    'err.noThreadId': 'нет идентификатора переписки',
    'err.devtoolsDown': 'DevTools на порту {port} не поднялся',
    'err.noFreePort': 'Нет свободного порта в диапазоне {start}-{end}',
    'err.chromeNotFound': 'Chrome не найден - укажите путь в настройках CDP',
    'err.attachFailed': 'Не удалось подключиться к цели {targetId}',
    'err.evalFailed': 'не удалось выполнить код на странице',

    // ── Chrome / CDP ────────────────────────────────────────
    'cdp.launching': 'Запускаю Chrome для "{label}" на порту {port}',
    'cdp.exited': 'Chrome для "{label}" завершился (код {code})',
    'cdp.fingerprintFailed': 'Не удалось установить фингерпринт для "{label}": {error}',
    'cdp.autoAttachFailed': 'Не удалось включить фингерпринт для новых вкладок "{label}": {error}',
    'cdp.live': 'Профиль "{label}" работает на порту {port}',
    'cdp.stopped': 'Профиль {id} остановлен',
    'cdp.launchFailed': 'Не удалось запустить "{label}": {error}',

    // ── Gmail ───────────────────────────────────────────────
    'gmail.scan': 'Сканирование "{id}": {status}{email}',
    'gmail.noTab': 'Gmail не открыт ни в одной вкладке профиля "{id}" - откройте mail.google.com',
    'gmail.composeBtnMissing': 'Кнопка "Написать" не найдена, шлю через отдельное окно письма',
    'gmail.tabSwitched': 'Профиль "{id}": скан переключён на вкладку с Gmail',
    'gmail.statusChanged': 'Профиль "{label}": {status}{email}',
    'gmail.sent': 'Письмо отправлено на {to}',
    'gmail.sendUnconfirmed': 'Отправка на {to} не подтверждена (окно письма осталось открытым)',
    'gmail.replySent': 'Автоответ отправлен в переписке {tid}',
    'gmail.replyUnconfirmed': 'Автоответ в переписке {tid} не подтверждён',
    'gmail.refreshMissing': 'Кнопка "Обновить" не найдена - читаю список писем как есть',

    // Статусы сканирования Gmail
    'gmailStatus.ready': 'готов',
    'gmailStatus.needs_login': 'нужен вход',
    'gmailStatus.unknown': 'неизвестно',

    // ── Прогон и отправка ───────────────────────────────────
    'run.noReady': 'Нет готовых профилей - запуск отменён',
    'run.started': 'Прогон запущен, готовых аккаунтов: {count}',
    'run.stopped': 'Прогон остановлен (инстансы Chrome оставлены открытыми, закрыть их можно на экране "Профили")',
    'run.allLimits': 'Все аккаунты достигли лимита отправки - остаёмся в режиме автоответа',
    'run.tgAllLimits': 'Все аккаунты Gmail достигли лимита отправки. Режим автоответа продолжает работать, пока вы не остановите прогон.',
    'send.failed': 'Ошибка отправки для "{label}": {error}',
    'send.message': '"{label}" -> {to} | тема: "{subject}"',
    'send.defaultSubject': 'Ваше объявление',
    'nudge.sending': 'Подталкиваю {email} из "{label}"',
    'nudge.sent': 'Письмо-подталкивание отправлено на {email}',
    'nudge.notFound': 'Подталкивание: {email} нет среди контактов рассылки',
    'nudge.noProfile': 'Подталкивание: профиль для {email} не найден',
    'nudge.profileStopped': 'Подталкивание: профиль "{label}" остановлен',
    'reply.pollError': 'Ошибка опроса ответов: {error}',
    'reply.disabled': 'Автоответ отключён в JSON с текстами',
    'reply.skipUnknown': 'Пропускаю {from} - не наш контакт рассылки, автоответ не шлю',
    'reply.poll': 'Опрос ответов по {count} аккаунтам (лимит {cap} на диалог)',
    'reply.unreadFailed': 'Не удалось прочитать непрочитанные для "{label}": {error}',
    'reply.sent': 'Отправлен автоответ в "{label}" ({n} из {cap})',
    'reply.failed': 'Автоответ не отправлен ({tid}): {error}',

    // ── Парсер ──────────────────────────────────────────────
    'parser.keyRotation': 'Достигнуто {n} сообщений - точка ротации ключа API (добавьте запасные ключи, чтобы менять их)',
    'parser.refill': 'В очереди {size} (меньше {threshold}) - забираю пачку из {batch}',
    'parser.added': 'Добавлено лидов: {count}, в очереди теперь {size}',
    'parser.fetchFailed': 'Не удалось забрать пачку: {error}',
    'parser.disabled': 'Парсер выключен в настройках - не запускаю',
    'parser.started': 'Парсер запущен ({type})',
    'parser.stopped': 'Парсер остановлен',

    // ── XProject ────────────────────────────────────────────
    'xp.taskActive': 'XProject: задача для {platform} уже активна (409) - остановите её на панели или подождите, без id возобновить нельзя',
    'xp.startFailed': 'XProject: не удалось запустить задачу (HTTP {status})',
    'xp.noKey': 'XProject: ключ API не задан',
    'xp.taskStarted': 'XProject: задача {taskId} запущена для {platform}',
    'xp.pageFailed': 'XProject: не удалось получить страницу (HTTP {status})',
    'xp.error': 'XProject: {error}',

    // ── VVS ─────────────────────────────────────────────────
    'vvs.noKey': 'VVS: ключ API не задан',
    'vvs.rateLimited': 'VVS: превышен лимит запросов (429) - жду',
    'vvs.noSubscription': 'VVS: нет активной подписки (402)',
    'vvs.badKey': 'VVS: неверный api-key (403)',
    'vvs.fetchFailed': 'VVS: запрос не удался (HTTP {status})',
    'vvs.listings': 'VVS: объявлений с почтой с {platform}: {count}',
    'vvs.error': 'VVS: {error}',

    // ── Haron Rent ──────────────────────────────────────────
    'haron.noKey': 'Haron Rent: ключ API не задан - использую заглушку ссылки',
    'haron.noMode': 'Haron Rent: режим ссылки (serviceCode) не задан - использую заглушку ссылки',
    'haron.createFailed': 'Haron Rent: createAd не удался ({message}) - использую заглушку ссылки',
    'haron.noUrl': 'Haron Rent: createAd не вернул url - использую заглушку ссылки',
    'haron.created': 'Haron Rent: ссылка создана (adId {adId})',
    'haron.error': 'Haron Rent: {error} - использую заглушку ссылки',

    // ── Telegram ────────────────────────────────────────────
    'tg.skipped': 'Уведомление пропущено - не задан токен или id чата',
    'tg.sent': 'Уведомление отправлено',
    'tg.failed': 'Не удалось отправить уведомление в Telegram',
  },

  en: {
    'sys.started': 'Gmail Manager started',
    'sys.ipcReady': 'IPC handlers registered',
    'sys.textsLoaded': 'Broadcast texts loaded',
    'sys.profileCreated': 'Created profile "{label}"',
    'sys.languageChanged': 'Application language switched to {lang}',

    'err.profileNotFound': 'Profile not found',
    'err.profileNotRunning': 'Profile is not running',
    'err.noLeadEmail': 'lead has no recipient email',
    'err.noRecipient': 'no recipient email',
    'err.composeNotRendered': 'compose window did not render (account not logged in?)',
    'err.composeNotOpened': 'the compose panel did not appear after clicking Compose',
    'err.recipientNotSet': 'address {to} did not land in the recipient field, send cancelled',
    'err.threadNotOpened': 'thread did not open',
    'err.replyBoxNotOpened': 'reply box did not open',
    'err.noThreadId': 'no thread id',
    'err.devtoolsDown': 'DevTools on port {port} did not come up',
    'err.noFreePort': 'No free port in range {start}-{end}',
    'err.chromeNotFound': 'Chrome executable not found - set it in CDP settings',
    'err.attachFailed': 'Could not attach to target {targetId}',
    'err.evalFailed': 'page evaluation failed',

    'cdp.launching': 'Launching Chrome for "{label}" on port {port}',
    'cdp.exited': 'Chrome for "{label}" exited (code {code})',
    'cdp.fingerprintFailed': 'Fingerprint install for "{label}" failed: {error}',
    'cdp.autoAttachFailed': 'Could not enable fingerprint for new tabs of "{label}": {error}',
    'cdp.live': 'Profile "{label}" is live on port {port}',
    'cdp.stopped': 'Stopped profile {id}',
    'cdp.launchFailed': 'Could not launch "{label}": {error}',

    'gmail.scan': 'Scan "{id}": {status}{email}',
    'gmail.noTab': 'Gmail is not open in any tab of profile "{id}" - open mail.google.com',
    'gmail.composeBtnMissing': 'Compose button not found, sending via a separate compose window',
    'gmail.tabSwitched': 'Profile "{id}": scan switched to the tab with Gmail',
    'gmail.statusChanged': 'Profile "{label}": {status}{email}',
    'gmail.sent': 'Message sent to {to}',
    'gmail.sendUnconfirmed': 'Send to {to} not confirmed (compose left open)',
    'gmail.replySent': 'Auto-reply sent in thread {tid}',
    'gmail.replyUnconfirmed': 'Auto-reply in thread {tid} not confirmed',
    'gmail.refreshMissing': 'Refresh button not found, reading the mail list as is',

    'gmailStatus.ready': 'ready',
    'gmailStatus.needs_login': 'needs login',
    'gmailStatus.unknown': 'unknown',

    'run.noReady': 'No READY profiles - start aborted',
    'run.started': 'Run started with {count} ready account(s)',
    'run.stopped': 'Run stopped (Chrome instances left open; stop them from Profiles if desired)',
    'run.allLimits': 'All accounts reached their send limit - staying in auto-reply mode',
    'run.tgAllLimits': 'All Gmail accounts reached their send limit. Auto-reply mode continues until you stop the run.',
    'send.failed': 'Send failed for "{label}": {error}',
    'send.message': '"{label}" -> {to} | subj: "{subject}"',
    'send.defaultSubject': 'Your listing',
    'nudge.sending': 'Nudging {email} from "{label}"',
    'nudge.sent': 'Nudge message sent to {email}',
    'nudge.notFound': 'Nudge: {email} is not among outreach contacts',
    'nudge.noProfile': 'Nudge: no profile found for {email}',
    'nudge.profileStopped': 'Nudge: profile "{label}" is stopped',
    'reply.pollError': 'Reply poll error: {error}',
    'reply.disabled': 'Auto-reply disabled in texts JSON',
    'reply.skipUnknown': 'Skipping {from} - not our outreach contact, no auto-reply',
    'reply.poll': 'Auto-reply poll over {count} account(s) (cap {cap}/dialog)',
    'reply.unreadFailed': 'Unread scan failed for "{label}": {error}',
    'reply.sent': 'Auto-replied in "{label}" thread ({n}/{cap})',
    'reply.failed': 'Auto-reply failed ({tid}): {error}',

    'parser.keyRotation': 'Reached {n} messages - API key rotation point (configure additional keys to rotate)',
    'parser.refill': 'Queue at {size} (< {threshold}) - fetching batch of {batch}',
    'parser.added': 'Added {count} leads - queue now {size}',
    'parser.fetchFailed': 'Batch fetch failed: {error}',
    'parser.disabled': 'Parser toggle is off - not starting',
    'parser.started': 'Parser started ({type})',
    'parser.stopped': 'Parser stopped',

    'xp.taskActive': 'XProject: task for {platform} already active (409) - stop it on the panel or wait; it cannot be resumed without its id',
    'xp.startFailed': 'XProject: start failed (HTTP {status})',
    'xp.noKey': 'XProject: no API key set',
    'xp.taskStarted': 'XProject: task {taskId} started for {platform}',
    'xp.pageFailed': 'XProject: page fetch failed (HTTP {status})',
    'xp.error': 'XProject: {error}',

    'vvs.noKey': 'VVS: no API key set',
    'vvs.rateLimited': 'VVS: rate limited (429) - backing off',
    'vvs.noSubscription': 'VVS: no active subscription (402)',
    'vvs.badKey': 'VVS: invalid api-key (403)',
    'vvs.fetchFailed': 'VVS: fetch failed (HTTP {status})',
    'vvs.listings': 'VVS: {count} listing(s) with email from {platform}',
    'vvs.error': 'VVS: {error}',

    'haron.noKey': 'Haron Rent: no API key - using placeholder link',
    'haron.noMode': 'Haron Rent: link mode (serviceCode) not set - using placeholder link',
    'haron.createFailed': 'Haron Rent: createAd failed ({message}) - using placeholder link',
    'haron.noUrl': 'Haron Rent: createAd returned no url - using placeholder link',
    'haron.created': 'Haron Rent: link created (adId {adId})',
    'haron.error': 'Haron Rent: {error} - using placeholder link',

    'tg.skipped': 'Notify skipped - token or chat id not set',
    'tg.sent': 'Notification sent',
    'tg.failed': 'Telegram notify failed',
  },
};

let lang = 'ru';

function setLanguage(next) {
  lang = DICT[next] ? next : 'ru';
  return lang;
}

function getLanguage() {
  return lang;
}

function t(key, params) {
  const table = DICT[lang] || DICT.ru;
  let str = table[key];
  if (str === undefined) str = DICT.ru[key];
  if (str === undefined) return key;
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined ? m : String(params[name])));
}

module.exports = { t, setLanguage, getLanguage };
