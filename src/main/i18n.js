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
    'sys.chatsArchived': 'Переписки убраны в архив чатов: {n}',
    'sys.chatsArchivedProfile': 'Переписки профиля "{label}" убраны в архив: {n}',
    'sys.dataDir': 'Данные приложения: {path}',
    'sys.portableOn': 'Портативный режим: данные лежат рядом с программой',
    'sys.portableFailed': 'Портативный режим не включён, каталог рядом с программой недоступен на запись: {error}',

    // ── Оформление ──────────────────────────────────────────
    'texts.dialogOpen': 'Выберите файл с текстами рассылки',
    'texts.dialogSave': 'Сохранить тексты рассылки',
    'texts.readFailed': 'Не удалось прочитать файл с текстами: {error}',
    'texts.writeFailed': 'Не удалось сохранить файл с текстами: {error}',
    'appear.dialogTitle': 'Выберите картинку для фона',
    'appear.dialogFilter': 'Изображения',
    'appear.picked': 'Фон обновлён',
    'appear.cleared': 'Фон сброшен на градиент',
    'appear.copyFailed': 'Не удалось скопировать картинку фона: {error}',

    // ── Перенос настроек файлом ─────────────────────────────
    'backup.dialogSave': 'Сохранить настройки в файл',
    'backup.dialogOpen': 'Выберите файл с настройками',
    'backup.exported': 'Настройки сохранены в файл: {path}',
    'backup.imported': 'Настройки загружены из файла',
    'backup.badFormat': 'Это не файл настроек - внутри должен быть объект JSON',
    'backup.readFailed': 'Не удалось прочитать файл настроек: {error}',
    'backup.writeFailed': 'Не удалось сохранить файл настроек: {error}',
    'backup.openFailed': 'Не удалось открыть каталог данных: {error}',

    // ── Обновление ──────────────────────────────────────────
    'upd.available': 'Вышла версия {version}',
    'upd.downloaded': 'Версия {version} скачана, можно перезапускать',
    'upd.installing': 'Перезапуск для установки обновления',
    'upd.failed': 'Не удалось проверить обновление: {error}',
    'upd.checkRetry': 'Обновление проверить не вышло ({error}), попробуем ещё раз',
    'upd.downloadFailed': 'Не удалось скачать обновление: {error}',
    // Причины отказа человеческими словами - см. describe() в updater.js.
    'upd.errNetwork': 'нет связи с GitHub',
    'upd.errNoRelease': 'на GitHub нет опубликованного релиза',

    // ── Ошибки ──────────────────────────────────────────────
    'err.profileNotFound': 'Профиль не найден',
    'err.profileNotRunning': 'Профиль не запущен',
    'err.mailboxNoTab': 'У почты {email} нет открытой вкладки Gmail',
    'err.noLeadEmail': 'у лида нет адреса получателя',
    'err.noRecipient': 'не указан адрес получателя',
    'err.composeNotRendered': 'окно письма не открылось (аккаунт не залогинен?)',
    'err.composeNotOpened': 'мини-окно письма не появилось после нажатия "Написать"',
    'err.recipientNotSet': 'адрес {to} не попал в поле получателя, отправка отменена',
    'err.bodyNotFilled': 'текст письма не попал в поле ввода, отправка отменена',
    'err.threadNotOpened': 'переписка не открылась',
    'err.replyBoxNotOpened': 'поле ответа не открылось',
    'err.noThreadId': 'нет идентификатора переписки',
    'err.devtoolsDown': 'Порт отладки {port} не поднялся',
    'err.noFreePort': 'Нет свободного порта в диапазоне {start}-{end}',
    'err.chromeNotFound': 'Chrome не найден - укажите путь в настройках CDP',
    'err.playwrightMissing': 'Playwright не установлен - выполните npm install в папке приложения',

    // ── Chrome / Playwright ─────────────────────────────────
    'cdp.launching': 'Запускаю Chrome для "{label}" на порту {port}',
    'cdp.closed': 'Chrome профиля "{label}" закрыт',
    'cdp.attached': 'Профиль "{label}": подключаюсь для работы с почтой',
    'cdp.fingerprintFailed': 'Не удалось установить фингерпринт для "{label}": {error}',
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
    'gmail.refreshMissing': 'Кнопка "Обновить" не найдена - перезагружаю список писем',
    'gmail.listStale': 'Список писем не обновился - пропускаю проход, чтобы не ответить повторно',
    'gmail.replyBtnMissing': 'Кнопка "Ответить" не найдена - жду поле ответа как есть',
    'gmail.replyWidgetFallback': 'Ответ из списка не открылся - захожу в переписку',
    'gmail.bodyFailed': 'Текст письма не попал в поле ввода - письмо не отправляем, оно ушло бы пустым',
    'gmail.markReadFallback': 'Переписка осталась непрочитанной - открываю её, чтобы не ответить повторно',

    // Статусы сканирования Gmail
    'gmailStatus.ready': 'готов',
    'gmailStatus.needs_login': 'нужен вход',
    'gmailStatus.unknown': 'неизвестно',

    // ── Прогон и отправка ───────────────────────────────────
    'run.noReady': 'Нет готовых профилей - запуск отменён',
    'run.started': 'Прогон запущен, готовых аккаунтов: {count}',
    'run.stopped': 'Прогон остановлен (инстансы Chrome оставлены открытыми, закрыть их можно на экране "Профили")',
    'run.paused': 'Пауза: новые письма не уходят, автоответчик продолжает работать',
    'run.resumed': 'Пауза снята, отправка продолжается',
    'run.allLimits': 'Все аккаунты достигли лимита отправки - остаёмся в режиме автоответа',
    'run.tgAllLimits': 'Все аккаунты Gmail достигли лимита отправки. Режим автоответа продолжает работать, пока вы не остановите прогон.',
    'run.noTab': 'Без вкладки Gmail и потому вне рассылки: {list}. Откройте вкладку почты в профиле, и она подхватится сама.',
    'send.failed': 'Ошибка отправки для "{label}": {error}',
    'send.message': '"{label}" -> {to} | тема: "{subject}"',
    'send.defaultSubject': 'Ваше объявление',
    'send.mailboxGone': 'Вкладка почты {email} в профиле "{label}" пропала - лид возвращён в очередь, почта исключена до следующего скана',
    'nudge.sending': 'Подталкиваю {email} из "{label}"',
    'nudge.sent': 'Письмо-подталкивание отправлено на {email}',
    'nudge.notFound': 'Подталкивание: {email} нет среди контактов рассылки',
    'nudge.noProfile': 'Подталкивание: профиль для {email} не найден',
    'nudge.profileStopped': 'Подталкивание: профиль "{label}" остановлен',
    'nudge.mailboxGuess': 'Подталкивание {email}: почта первого письма не записана, пишу из {mailbox}',
    'nudge.noMailbox': 'Подталкивание {email}: в профиле "{label}" нет почты с открытой вкладкой',
    'reply.pollError': 'Ошибка опроса ответов: {error}',
    'reply.disabled': 'Автоответ отключён в JSON с текстами',
    'reply.htmlMode': 'Автоответ уходит HTML-шаблоном из настроек',
    'reply.mailboxGone': 'Вкладка почты {email} в профиле "{label}" пропала - пропускаю её в этом проходе',
    'reply.skipUnknown': 'Пропускаю {from} - не наш контакт рассылки, автоответ не шлю',
    'reply.capReached': 'Переписка {tid}: лимит {cap} ответов исчерпан, больше не отвечаю',
    'reply.ownMessage': 'Переписка {tid}: последнее письмо - наш же ответ, ждём продавца',
    'reply.notConfirmed': 'отправка не подтверждена',
    // Вердикты автоответчика, видны в сухом прогоне.
    'verdict.new': 'первый ответ продавца - отвечаем ({n} из {cap})',
    'verdict.reply': 'продавец написал снова - отвечаем ({n} из {cap})',
    'verdict.own': 'последнее письмо наше - ждём продавца ({n} из {cap})',
    'verdict.same': 'нового письма нет - пропускаем ({n} из {cap})',
    'verdict.limit': 'лимит исчерпан - пропускаем ({n} из {cap})',
    'reply.poll': 'Опрос ответов по {count} аккаунтам (лимит {cap} на диалог)',
    'reply.unreadFailed': 'Не удалось прочитать непрочитанные для "{label}": {error}',
    'reply.sent': 'Отправлен автоответ в "{label}" ({n} из {cap})',
    'reply.failed': 'Автоответ не отправлен ({tid}): {error}',
    'dry.title': 'Сухой прогон "{label}": непрочитанных писем {count}',
    'dry.row': '"{subject}" | отправитель: {from} | {contact}',
    'dry.verdict': '   -> {verdict}',
    'dry.known': 'наш контакт, автоответ уйдёт',
    'dry.unknown': 'не наш контакт, будет пропущено',
    'dry.empty': 'Непрочитанных писем нет',
    'dry.profileStopped': 'Сухой прогон: профиль "{label}" остановлен',
    'dry.noMailbox': 'Сухой прогон: в профиле "{label}" нет почты с открытой вкладкой Gmail',

    // ── Парсер ──────────────────────────────────────────────
    'parser.leadPushed': 'Тестовый лид {email} поставлен в начало очереди (в очереди {size})',
    'parser.keyRotation': 'Достигнуто {n} сообщений - точка ротации ключа API (добавьте запасные ключи, чтобы менять их)',
    'parser.refill': 'В очереди {size} (меньше {threshold}) - забираю пачку из {batch}',
    'parser.added': 'Добавлено лидов: {count}, в очереди теперь {size}',
    'parser.fetchFailed': 'Не удалось забрать пачку: {error}',
    'parser.unknownPlatform': 'Площадка "{platform}" не поддерживается этим парсером - собираю с {used}',
    'parser.testStarted': 'Проверка фильтров: один запрос к {platform}, условия {filters}',
    'parser.testResult': 'Проверка фильтров: объявлений с почтой в ответе - {count}',
    'parser.testFailed': 'Проверка фильтров не удалась: {error}',
    'parser.disabled': 'Парсер выключен в настройках - не запускаю',
    'parser.started': 'Парсер запущен ({type})',
    'parser.stopped': 'Парсер остановлен',

    // ── XProject ────────────────────────────────────────────
    'xp.taskActive': 'XProject: задача для {platform} уже активна (409) - остановите её на панели или подождите, без id возобновить нельзя',
    'xp.startFailed': 'XProject: не удалось запустить задачу (HTTP {status})',
    'xp.noKey': 'XProject: ключ API не задан',
    'xp.taskStarted': 'XProject: задача {taskId} запущена для {platform}',
    'xp.taskStopped': 'XProject: задача {taskId} остановлена',
    'xp.stopFailed': 'XProject: не удалось остановить задачу {taskId}: {error}',
    'xp.pageFailed': 'XProject: не удалось получить страницу (HTTP {status})',
    'xp.filtersRejected': 'XProject: площадка {platform} не приняла фильтры (422): {filters} - поправьте их в настройках',
    'xp.filtersSkipped': 'XProject: площадка {platform} не принимает такие условия, отправляю без них: {filters}',
    'xp.countriesSkipped': 'XProject: площадка {platform} не работает в этих странах, пропускаю: {countries}',
    'xp.schemaFailed': 'XProject: не удалось получить список фильтров (HTTP {status})',
    'xp.schemaError': 'XProject: не удалось получить список фильтров: {error}',
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
    'haron.noMode': 'Haron Rent: услугу не определить - у объявления нет площадки или страны, а режим ссылки в настройках пуст. Использую заглушку ссылки',
    'haron.autoService': 'Haron Rent: услуга по объявлению - {code}',
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
    'sys.chatsArchived': 'Messages moved to the chat archive: {n}',
    'sys.chatsArchivedProfile': 'Messages of profile "{label}" moved to the archive: {n}',
    'sys.dataDir': 'Application data: {path}',
    'sys.portableOn': 'Portable mode: data lives next to the program',
    'sys.portableFailed': 'Portable mode is off, the folder next to the program is not writable: {error}',

    'texts.dialogOpen': 'Pick an outreach texts file',
    'texts.dialogSave': 'Save the outreach texts',
    'texts.readFailed': 'Could not read the texts file: {error}',
    'texts.writeFailed': 'Could not save the texts file: {error}',
    'appear.dialogTitle': 'Pick a background image',
    'appear.dialogFilter': 'Images',
    'appear.picked': 'Background updated',
    'appear.cleared': 'Background reset to gradient',
    'appear.copyFailed': 'Could not copy the background image: {error}',

    'backup.dialogSave': 'Save settings to a file',
    'backup.dialogOpen': 'Pick a settings file',
    'backup.exported': 'Settings saved to: {path}',
    'backup.imported': 'Settings loaded from file',
    'backup.badFormat': 'Not a settings file - it must contain a JSON object',
    'backup.readFailed': 'Could not read the settings file: {error}',
    'backup.writeFailed': 'Could not save the settings file: {error}',
    'backup.openFailed': 'Could not open the data folder: {error}',

    'upd.available': 'Version {version} is out',
    'upd.downloaded': 'Version {version} downloaded, ready to restart',
    'upd.installing': 'Restarting to install the update',
    'upd.failed': 'Could not check for updates: {error}',
    'upd.checkRetry': 'Update check did not go through ({error}), trying again later',
    'upd.downloadFailed': 'Could not download the update: {error}',
    'upd.errNetwork': 'no connection to GitHub',
    'upd.errNoRelease': 'there is no published release on GitHub',

    'err.profileNotFound': 'Profile not found',
    'err.profileNotRunning': 'Profile is not running',
    'err.mailboxNoTab': 'Mailbox {email} has no open Gmail tab',
    'err.noLeadEmail': 'lead has no recipient email',
    'err.noRecipient': 'no recipient email',
    'err.composeNotRendered': 'compose window did not render (account not logged in?)',
    'err.composeNotOpened': 'the compose panel did not appear after clicking Compose',
    'err.recipientNotSet': 'address {to} did not land in the recipient field, send cancelled',
    'err.bodyNotFilled': 'the message text did not land in the body field, send cancelled',
    'err.threadNotOpened': 'thread did not open',
    'err.replyBoxNotOpened': 'reply box did not open',
    'err.noThreadId': 'no thread id',
    'err.devtoolsDown': 'Debugging port {port} did not come up',
    'err.noFreePort': 'No free port in range {start}-{end}',
    'err.chromeNotFound': 'Chrome executable not found - set it in CDP settings',
    'err.playwrightMissing': 'Playwright is not installed - run npm install in the app folder',

    'cdp.launching': 'Launching Chrome for "{label}" on port {port}',
    'cdp.closed': 'Chrome for profile "{label}" was closed',
    'cdp.attached': 'Profile "{label}": attaching for mail work',
    'cdp.fingerprintFailed': 'Fingerprint install for "{label}" failed: {error}',
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
    'gmail.refreshMissing': 'Refresh button not found, reloading the mail list',
    'gmail.listStale': 'Mail list did not refresh - skipping this pass to avoid a duplicate reply',
    'gmail.replyBtnMissing': 'Reply button not found, waiting for the reply box as is',
    'gmail.replyWidgetFallback': 'Reply from the list did not open - opening the thread instead',
    'gmail.bodyFailed': 'The message text did not land in the input - not sending, it would go out empty',
    'gmail.markReadFallback': 'Thread stayed unread - opening it so we do not reply twice',

    'gmailStatus.ready': 'ready',
    'gmailStatus.needs_login': 'needs login',
    'gmailStatus.unknown': 'unknown',

    'run.noReady': 'No READY profiles - start aborted',
    'run.started': 'Run started with {count} ready account(s)',
    'run.stopped': 'Run stopped (Chrome instances left open; stop them from Profiles if desired)',
    'run.paused': 'Paused: no new first-messages, the auto-responder keeps running',
    'run.resumed': 'Resumed, sending continues',
    'run.allLimits': 'All accounts reached their send limit - staying in auto-reply mode',
    'run.tgAllLimits': 'All Gmail accounts reached their send limit. Auto-reply mode continues until you stop the run.',
    'run.noTab': 'No Gmail tab and therefore out of the run: {list}. Open the mailbox tab in the profile and it is picked up on its own.',
    'send.failed': 'Send failed for "{label}": {error}',
    'send.mailboxGone': 'The Gmail tab of {email} in profile "{label}" is gone - the lead went back to the queue, the mailbox is excluded until the next scan',
    'send.message': '"{label}" -> {to} | subj: "{subject}"',
    'send.defaultSubject': 'Your listing',
    'nudge.sending': 'Nudging {email} from "{label}"',
    'nudge.sent': 'Nudge message sent to {email}',
    'nudge.notFound': 'Nudge: {email} is not among outreach contacts',
    'nudge.noProfile': 'Nudge: no profile found for {email}',
    'nudge.profileStopped': 'Nudge: profile "{label}" is stopped',
    'nudge.mailboxGuess': 'Nudge {email}: the mailbox of the first mail is not recorded, sending from {mailbox}',
    'nudge.noMailbox': 'Nudge {email}: profile "{label}" has no mailbox with an open tab',
    'reply.pollError': 'Reply poll error: {error}',
    'reply.disabled': 'Auto-reply disabled in texts JSON',
    'reply.htmlMode': 'Auto-reply is sent as the HTML template from settings',
    'reply.mailboxGone': 'The Gmail tab of {email} in profile "{label}" is gone - skipping it in this pass',
    'reply.skipUnknown': 'Skipping {from} - not our outreach contact, no auto-reply',
    'reply.capReached': 'Thread {tid}: reply cap of {cap} reached, not replying again',
    'reply.ownMessage': 'Thread {tid}: last message is our own reply, waiting for the seller',
    'reply.notConfirmed': 'send not confirmed',
    'verdict.new': 'first seller reply - replying ({n}/{cap})',
    'verdict.reply': 'seller wrote again - replying ({n}/{cap})',
    'verdict.own': 'last message is ours - waiting for the seller ({n}/{cap})',
    'verdict.same': 'nothing new - skipping ({n}/{cap})',
    'verdict.limit': 'cap reached - skipping ({n}/{cap})',
    'reply.poll': 'Auto-reply poll over {count} account(s) (cap {cap}/dialog)',
    'reply.unreadFailed': 'Unread scan failed for "{label}": {error}',
    'reply.sent': 'Auto-replied in "{label}" thread ({n}/{cap})',
    'reply.failed': 'Auto-reply failed ({tid}): {error}',
    'dry.title': 'Dry run "{label}": {count} unread message(s)',
    'dry.row': '"{subject}" | sender: {from} | {contact}',
    'dry.verdict': '   -> {verdict}',
    'dry.known': 'our contact, auto-reply would be sent',
    'dry.unknown': 'not our contact, would be skipped',
    'dry.empty': 'No unread messages',
    'dry.profileStopped': 'Dry run: profile "{label}" is stopped',
    'dry.noMailbox': 'Dry run: profile "{label}" has no mailbox with an open Gmail tab',

    'parser.leadPushed': 'Test lead {email} pushed to the front of the queue (queue size {size})',
    'parser.keyRotation': 'Reached {n} messages - API key rotation point (configure additional keys to rotate)',
    'parser.refill': 'Queue at {size} (< {threshold}) - fetching batch of {batch}',
    'parser.added': 'Added {count} leads - queue now {size}',
    'parser.fetchFailed': 'Batch fetch failed: {error}',
    'parser.unknownPlatform': 'Platform "{platform}" is not supported by this parser - collecting from {used} instead',
    'parser.testStarted': 'Filter check: one request to {platform}, conditions {filters}',
    'parser.testResult': 'Filter check: listings with an email in the response - {count}',
    'parser.testFailed': 'Filter check failed: {error}',
    'parser.disabled': 'Parser toggle is off - not starting',
    'parser.started': 'Parser started ({type})',
    'parser.stopped': 'Parser stopped',

    'xp.taskActive': 'XProject: task for {platform} already active (409) - stop it on the panel or wait; it cannot be resumed without its id',
    'xp.startFailed': 'XProject: start failed (HTTP {status})',
    'xp.noKey': 'XProject: no API key set',
    'xp.taskStarted': 'XProject: task {taskId} started for {platform}',
    'xp.taskStopped': 'XProject: task {taskId} stopped',
    'xp.stopFailed': 'XProject: could not stop task {taskId}: {error}',
    'xp.pageFailed': 'XProject: page fetch failed (HTTP {status})',
    'xp.filtersRejected': 'XProject: platform {platform} rejected the filters (422): {filters} - fix them in settings',
    'xp.filtersSkipped': 'XProject: platform {platform} does not take these conditions, sending without them: {filters}',
    'xp.countriesSkipped': 'XProject: platform {platform} does not operate in these countries, skipping: {countries}',
    'xp.schemaFailed': 'XProject: could not fetch the filter list (HTTP {status})',
    'xp.schemaError': 'XProject: could not fetch the filter list: {error}',
    'xp.error': 'XProject: {error}',

    'vvs.noKey': 'VVS: no API key set',
    'vvs.rateLimited': 'VVS: rate limited (429) - backing off',
    'vvs.noSubscription': 'VVS: no active subscription (402)',
    'vvs.badKey': 'VVS: invalid api-key (403)',
    'vvs.fetchFailed': 'VVS: fetch failed (HTTP {status})',
    'vvs.listings': 'VVS: {count} listing(s) with email from {platform}',
    'vvs.error': 'VVS: {error}',

    'haron.noKey': 'Haron Rent: no API key - using placeholder link',
    'haron.noMode': 'Haron Rent: cannot resolve the service - the listing has no platform or country and the link mode in settings is empty. Using placeholder link',
    'haron.autoService': 'Haron Rent: service for this listing - {code}',
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
