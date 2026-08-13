'use strict';
/**
 * Sender engine - orchestrates the whole run.
 *
 * Scenario (from the spec):
 *   • On start, every profile with a READY Gmail account gets its Chrome
 *     instance launched (one Chrome = one account).
 *   • The parser gradually fills the lead queue.
 *   • Accounts are filled SEQUENTIALLY: the current account sends first-messages
 *     until it reaches `mailsPerAccount`, then we move to the next account.
 *   • The auto-responder runs the WHOLE time (during send and after all limits
 *     are hit), polling every `checkIntervalSec` for seller replies and sending
 *     the configured auto-reply, capped at `maxRepliesPerDialog`. Плюс к
 *     таймеру проход делается сразу после КАЖДОГО отправленного письма, по той
 *     почте, с которой оно ушло: список там всё равно надо обновить, а ответ
 *     продавца иначе ждал бы общего прохода.
 *   • When every account has hit its limit, the user is notified via Telegram
 *     and the system stays alive in auto-reply-only mode until stopped.
 *
 * NOTE: the concrete Gmail "compose + send" and "read replies" steps are driven
 * by Playwright against the logged-in Gmail tab. The DOM automation hooks are
 * marked TODO(gmail-dom) - they depend on Gmail's current DOM and are best
 * finalized against a live logged-in profile. The orchestration, limits,
 * sequencing, queue and auto-reply loop are all real and complete.
 */
const logger = require('../logger');
const { t } = require('../i18n');
const haron = require('../link/haronRent');
const telegram = require('../telegram/telegram');
const texts = require('../texts');
const htmlTemplate = require('../htmlTemplate');
const mailboxes = require('../mailbox');

class SenderEngine {
  constructor({ store, profileStore, chrome, parser, contactStore, dialogStore, statsStore, messageStore, aiTexts }) {
    this.store = store;
    this.profileStore = profileStore;
    this.chrome = chrome;
    this.parser = parser;
    this.contactStore = contactStore;
    // Учёт переписок автоответчика: сколько раз отвечали и какие письма уже
    // разобрали. Своё состояние вместо прочитанности Gmail, см. _pollReplies.
    this.dialogStore = dialogStore;
    // Журнал по дням для графика статистики. Счётчик в профиле накопительный и
    // исчезает вместе с профилем, а история должна оставаться.
    this.statsStore = statsStore;
    // Журнал переписки для экрана чатов: dialogStore хранит только решения
    // автоответчика, тексты писем нужны отдельно.
    this.messageStore = messageStore;
    // Обновление текстов нейронкой по счётчику писем. Движок только считает
    // отправленные письма, всё остальное - забота ai/textSwap.js.
    this.aiTexts = aiTexts || null;
    this.running = false;
    // Пауза - это остановленная ОТПРАВКА при живом прогоне: автоответчик
    // продолжает опрашивать почту, аптайм идёт, очередь не теряется.
    this.paused = false;
    this.startedAt = null;
    // Письма, ушедшие с момента старта ПРОГОНА. Счётчик в профиле
    // накопительный и переживает перезапуски, поэтому темп и прогноз по нему
    // считать нельзя - для них нужен именно сессионный счёт.
    this.sentThisSession = 0;
    // Ответы и ссылки за прогон - по той же причине, что и письма: на экране
    // прогона показываются цифры текущего запуска, а не всё за историю.
    this.repliesThisSession = 0;
    this.linksThisSession = 0;
    this._sendTimer = null;
    this._replyTimer = null;
    this._notifiedAllLimits = false;
    // Идёт проход автоответа - новые письма в это время не шлём, см. _sendLoop.
    this._replying = false;
    // Указатель круговой отправки по почтам, см. _nextMailbox.
    this._rr = 0;
  }

  /**
   * Состояние прогона для интерфейса. Все счётчики - за ТЕКУЩИЙ запуск: экран
   * прогона отвечает на вопрос "что происходит сейчас", а накопленные за всю
   * историю числа лежат на своих экранах (профили, обзор).
   *
   * Очередь у остановленного прогона показываем нулём: лиды в памяти ещё
   * лежат, но следующий запуск начинает с чистой очереди (см. start), и
   * показывать число, которое всё равно исчезнет, - врать.
   */
  status() {
    return {
      running: this.running,
      paused: this.running && this.paused,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      queueSize: this.running ? this.parser.queueSize() : 0,
      sentThisSession: this.sentThisSession,
      repliesThisSession: this.repliesThisSession,
      linksThisSession: this.linksThisSession,
      // Все почты добрали лимит: писем больше не будет, приложение осталось на
      // аккаунтах и отвечает на ответы. Кнопка остановки говорит именно об
      // этом, см. paintRunControls в рендере.
      autoReplyOnly: this.running && this._allLimitsReached(),
    };
  }

  _readyProfiles() {
    return this.profileStore.list().filter((p) => p.gmailStatus === 'ready');
  }

  /** Профили с живым Chrome: только в них есть вкладки, с которыми можно работать. */
  _runningReady() {
    return this._readyProfiles().filter((p) => this.chrome.isRunning(p.id));
  }

  /**
   * Все почты, с которыми можно работать прямо сейчас: плоский список пар
   * "профиль + почта". Почта участвует, только если у неё есть своя вкладка -
   * приложение вкладок не открывает, это делает пользователь (Rules 6).
   */
  _mailboxes() {
    const out = [];
    for (const profile of this._runningReady()) {
      for (const mailbox of this.profileStore.mailboxes(profile.id)) {
        if (mailbox && mailbox.hasTab) out.push({ profile, mailbox });
      }
    }
    return out;
  }

  /** Почты профилей, у которых вкладки нет: о них надо сказать пользователю. */
  _mailboxesWithoutTab() {
    const out = [];
    for (const profile of this._runningReady()) {
      for (const mailbox of this.profileStore.mailboxes(profile.id)) {
        if (mailbox && !mailbox.hasTab) out.push({ profile, mailbox });
      }
    }
    return out;
  }

  _allLimitsReached() {
    const limit = this.store.get('system').mailsPerAccount;
    const slots = this._mailboxes();
    return slots.length > 0 && slots.every(({ mailbox }) => (mailbox.sentCount || 0) >= limit);
  }

  /**
   * Следующая почта по кругу: письмо в каждую по очереди, а не пачкой с одной.
   * Так лимиты выбираются равномерно, и ни один ящик не пишет подряд десятки
   * писем. Указатель круга живёт между заходами, а список почт может меняться на
   * ходу (скан нашёл новую вкладку, старую закрыли) - поэтому идём по остатку от
   * длины, а не по сохранённому индексу.
   */
  _nextMailbox() {
    const limit = this.store.get('system').mailsPerAccount;
    const slots = this._mailboxes();
    if (!slots.length) return null;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[(this._rr + i) % slots.length];
      if ((slot.mailbox.sentCount || 0) < limit) {
        this._rr = (this._rr + i + 1) % slots.length;
        return slot;
      }
    }
    return null;
  }

  async start() {
    if (this.running) return { ok: false, reason: 'already_running' };
    const ready = this._readyProfiles();
    if (!ready.length) {
      logger.warn('sender', t('run.noReady'));
      return { ok: false, reason: 'no_ready_profiles' };
    }
    this.running = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.sentThisSession = 0;
    this.repliesThisSession = 0;
    this.linksThisSession = 0;
    this._notifiedAllLimits = false;
    this._rr = 0;
    // Счётчик писем до обновления текстов - про текущий прогон, а не про всю
    // историю: между запусками человек мог поменять и тексты, и настройку.
    if (this.aiTexts) this.aiTexts.reset();
    // Очередь начинаем с чистого листа: лиды прошлого прогона собраны под
    // прошлую цель рассылки, а парсер дольёт свежие за первые же секунды.
    this.parser.clear();
    logger.success('system', t('run.started', { count: ready.length }));

    // Поднимаем Chrome каждому готовому профилю, если он ещё не запущен. Адрес
    // первой почты: остальные вкладки открывает пользователь сам.
    for (const p of ready) {
      try {
        if (!this.chrome.isRunning(p.id)) {
          const inst = await this.chrome.launch(p, { url: mailboxes.inboxUrl(0) });
          this.profileStore.update(p.id, { running: true, port: inst.port });
        }
      } catch (e) {
        logger.error('cdp', t('cdp.launchFailed', { label: p.label, error: e.message }));
      }
    }

    // Почты без своей вкладки в рассылке не участвуют. Молчать об этом нельзя:
    // человек вошёл в аккаунт и ждёт, что с него тоже пишут.
    const noTab = this._mailboxesWithoutTab();
    if (noTab.length) {
      logger.warn('sender', t('run.noTab', {
        list: noTab.map(({ profile, mailbox }) => profile.label + ' / ' + mailboxes.label(mailbox)).join(', '),
      }));
    }

    this.parser.start();
    this._sendLoop();
    this._replyLoop();
    return {
      ok: true,
      mailboxes: this._mailboxes().length,
      withoutTab: noTab.map(({ profile, mailbox }) => ({
        profileId: profile.id, profileLabel: profile.label, email: mailbox.email,
      })),
    };
  }

  async _sendLoop() {
    if (!this.running) return;
    // Пока идёт автоответ - никаких новых писем. Ответ может прийти прямо
    // посреди рассылки, а вкладка почты у профиля ОДНА: отправка вклинилась бы
    // между открытием переписки и её отправкой. Очередь в менеджере делает
    // атомарной каждую задачу по отдельности, но проход автоответа - это
    // несколько задач подряд (скан, затем ответ на каждое письмо), и разрывать
    // его нельзя.
    // На паузе лид из очереди НЕ вынимаем - иначе он потерялся бы, пока
    // пользователь думает. Просто ждём снятия паузы.
    if (this._replying || this.paused) {
      this._sendTimer = setTimeout(() => this._sendLoop(), 1000);
      return;
    }
    const slot = this._nextMailbox();
    if (!slot) {
      if (this._allLimitsReached() && !this._notifiedAllLimits) {
        this._notifiedAllLimits = true;
        logger.warn('system', t('run.allLimits'));
        await telegram.notify(this.store, '✅ ' + t('run.tgAllLimits'));
      }
      this._sendTimer = setTimeout(() => this._sendLoop(), 5000);
      return;
    }
    const lead = this.parser.take();
    if (!lead) {
      // Queue empty - wait for the parser to refill.
      this._sendTimer = setTimeout(() => this._sendLoop(), 2000);
      return;
    }
    const { profile, mailbox } = slot;
    let sent = false;
    try {
      await this._sendFirstMessage(slot, lead);
      sent = true;
      this.profileStore.bumpMailbox(profile.id, mailbox.email);
      this.sentThisSession++;
      // Сохраняем контакт с данными товара и почтой, с которой ушло письмо:
      // подталкивать человека надо из того же ящика.
      if (this.contactStore) this.contactStore.recordSent({ lead, profile, mailbox });
      if (this.statsStore) this.statsStore.note('sent');
      this.parser.noteSent();
      // Тексты обновляются по счётчику отправленных писем. Ждать обновление
      // здесь нельзя: рассылка продолжает идти, пока модель думает.
      if (this.aiTexts) this.aiTexts.noteSent();
    } catch (e) {
      if (e && e.code === 'no_tab') {
        // Вкладку почты закрыли посреди прогона. Лид возвращаем в очередь - он
        // ничей вины не потерял, - а почту исключаем до следующего скана.
        this.parser.pushLead(lead);
        this.profileStore.setMailboxTab(profile.id, mailbox.email, false);
        logger.warn('sender', t('send.mailboxGone', {
          label: profile.label, email: mailboxes.label(mailbox),
        }));
      } else {
        if (this.statsStore) this.statsStore.note('errors');
        logger.error('sender', t('send.failed', {
          label: profile.label + ' / ' + mailboxes.label(mailbox), error: e.message,
        }));
      }
    }
    // Письмо ушло - сразу нажимаем "Обновить" в ЭТОЙ вкладке, ждём, пока уйдёт
    // "Loading...", и разбираем новые письма. Проход стоит ЗА пределами try
    // отправки нарочно: его отказ не должен выглядеть отказом отправки и
    // возвращать уже отправленный лид обратно в очередь.
    if (sent) await this._pollAfterSend(slot);
    // Пауза между письмами - из настроек. Ждём именно здесь, после отправки:
    // очередь и лимиты уже сошлись, и следующий заход начнётся с чистого места.
    this._sendTimer = setTimeout(() => this._sendLoop(), this._sendDelayMs());
  }

  /**
   * Проход автоответа по одной почте сразу после отправки с неё письма.
   *
   * Флаг `_replying` держим на всё время: пока разбираем список, отправка с
   * этой же вкладки идти не должна, и проход по таймеру тоже (иначе один и тот
   * же тред разобрали бы дважды и ответили на него два раза).
   */
  async _pollAfterSend(slot) {
    const cfg = this._replyConfig();
    if (!cfg) return;
    this._replying = true;
    try {
      await this._pollMailbox(slot, cfg);
    } catch (e) {
      logger.error('sender', t('reply.pollError', { error: e.message }));
    } finally {
      this._replying = false;
    }
  }

  /**
   * Пауза между двумя первыми письмами, мс. Минимум секунда: ноль в настройках
   * означал бы отправку в упор, а это самый быстрый способ схватить ограничение
   * от самого Gmail.
   */
  _sendDelayMs() {
    const sec = Number((this.store.get('system') || {}).sendDelaySec);
    return Math.max(1, Number.isFinite(sec) ? sec : 2) * 1000;
  }

  async _sendFirstMessage({ profile, mailbox }, lead) {
    if (!lead || !lead.email) throw new Error(t('err.noLeadEmail'));
    // Первое письмо ссылки не несёт: тема - название товара из парсера, тело -
    // случайный текст из MESSAGES_DICT на языке рассылки.
    const loaded = this.store.get('texts');
    const lang = texts.outreachLang(this.store);
    const subject = (lead.meta && lead.meta.title) || lead.title || t('send.defaultSubject');
    const body = texts.firstMessage(loaded, lang);
    logger.info('sender', t('send.message', {
      label: profile.label + ' / ' + mailboxes.label(mailbox), to: lead.email, subject,
    }));
    // Отправка идёт в вкладке ИМЕННО этой почты, см. _mailPage.
    // TODO(gmail-dom): проверять селекторы окна письма на живом аккаунте.
    await this.chrome.gmailCompose(profile.id, { mailbox, to: lead.email, subject, body });
    if (this.messageStore) {
      this.messageStore.add({
        accountKey: mailboxes.accountKey(profile.id, mailbox.email),
        profileId: profile.id, mailbox: mailbox.email,
        email: lead.email, dir: 'out', kind: 'first', subject, body,
      });
    }
    return { subject, body };
  }

  async _replyLoop() {
    if (!this.running) return;
    const intervalMs = Math.max(3, this.store.get('system').checkIntervalSec) * 1000;
    // Проход уже идёт (его начала отправка) - этот тик пропускаем. Два прохода
    // разом прочитали бы один и тот же тред до записи ответа и ответили дважды.
    if (this._replying) {
      this._replyTimer = setTimeout(() => this._replyLoop(), intervalMs);
      return;
    }
    // Флаг держим на ВЕСЬ проход, включая скан непрочитанных: скан тоже водит
    // вкладку почты (обновляет список), и отправка в это время мешала бы.
    this._replying = true;
    try {
      await this._pollReplies();
    } catch (e) {
      logger.error('sender', t('reply.pollError', { error: e.message }));
    } finally {
      this._replying = false;
    }
    this._replyTimer = setTimeout(() => this._replyLoop(), intervalMs);
  }

  /**
   * Общие для прохода настройки: лимит ответов, тексты и язык. Возвращает null,
   * если автоответ выключен, - тогда проход не нужен вовсе.
   */
  _replyConfig() {
    const loaded = this.store.get('texts');
    // Автоответ включён, если в JSON нет явного выключателя.
    const enabled = !loaded || !loaded.autoReply || loaded.autoReply.enabled !== false;
    if (!enabled) {
      logger.debug('sender', t('reply.disabled'));
      return null;
    }
    return {
      maxReplies: this.store.get('system').maxRepliesPerDialog,
      loaded,
      lang: texts.outreachLang(this.store),
    };
  }

  /**
   * Проход автоответчика.
   *
   * Сценарий: продавец ответил - отвечаем ему. Написал после нашего ответа
   * снова - отвечаем снова, и так по кругу, пока не упрёмся в лимит ответов на
   * диалог. Прочитанность письма в этом решении не участвует: это состояние
   * Gmail, оно отстаёт и зависит от того, открывали ли переписку. Учёт свой,
   * в dialogStore, и он переживает перезапуск приложения.
   */
  async _pollReplies() {
    const cfg = this._replyConfig();
    if (!cfg) return;
    // Проход идёт по ПОЧТАМ, а не по профилям: в одном профиле их несколько, и
    // список писем у каждой свой.
    const slots = this._mailboxes();
    logger.debug('sender', t('reply.poll', { count: slots.length, cap: cfg.maxReplies }));
    for (const slot of slots) await this._pollMailbox(slot, cfg);
  }

  /**
   * Проход по ОДНОЙ почте. Вынесен отдельно, потому что зовётся из двух мест:
   * из общего прохода по таймеру и сразу после отправки письма с этой почты.
   */
  async _pollMailbox({ profile, mailbox }, cfg) {
    const { maxReplies, loaded, lang } = cfg;
    const account = profile;
    const box = mailboxes.label(mailbox);
    const key = mailboxes.accountKey(profile.id, mailbox.email);
    let rows = [];
    try {
      // Берём весь список, а не только непрочитанное: что новое, а что нет,
      // решаем сами по идентификатору последнего письма треда.
      rows = await this.chrome.gmailListThreads(account.id, { mailbox, max: 25 });
    } catch (e) {
      if (e && e.code === 'no_tab') {
        this.profileStore.setMailboxTab(profile.id, mailbox.email, false);
        logger.warn('sender', t('reply.mailboxGone', { label: account.label, email: box }));
        return;
      }
      logger.warn('sender', t('reply.unreadFailed', {
        label: account.label + ' / ' + box, error: e.message,
      }));
      return;
    }
    for (const thread of rows) {
      // Отвечаем ТОЛЬКО тем, кому сами писали в этой рассылке. Иначе PASTE со
      // ссылкой ушёл бы на любое письмо в инбоксе (промо, служебные письма
      // Gmail), а не на реальный ответ покупателя.
      const contact = this.contactStore ? this.contactStore.get(thread.from) : null;
      if (!contact) {
        logger.debug('sender', t('reply.skipUnknown', { from: thread.from || '?' }));
        continue;
      }
      const verdict = this.dialogStore.decide(
        key, thread.threadId, thread.lastMessageId, maxReplies,
      );
      if (verdict === 'same') continue;
      if (verdict === 'limit') {
        // Запоминаем письмо, чтобы не разбирать эту переписку каждый проход.
        this.dialogStore.noteSeen(key, thread.threadId, thread.lastMessageId);
        logger.debug('sender', t('reply.capReached', { tid: thread.threadId, cap: maxReplies }));
        continue;
      }
      if (verdict === 'own') {
        // Последнее письмо треда - наш же прошлый ответ, а не новое от
        // продавца. Просто запоминаем его.
        this.dialogStore.noteSeen(key, thread.threadId, thread.lastMessageId);
        logger.debug('sender', t('reply.ownMessage', { tid: thread.threadId }));
        continue;
      }
      try {
        // Ответ продавца записываем ДО отправки автоответа: если отправка
        // сорвётся, письмо в переписке всё равно было, и в чате оно должно
        // остаться. Идентификатор треда известен только сейчас - привязываем
        // к нему первое письмо, которое ушло ещё без него.
        if (this.messageStore) {
          this.messageStore.attachThread({
            accountKey: key, email: thread.from, threadId: thread.threadId,
          });
          this.messageStore.add({
            accountKey: key, profileId: account.id, mailbox: mailbox.email,
            email: thread.from, threadId: thread.threadId,
            dir: 'in', kind: 'reply',
            subject: thread.subject || '',
            body: thread.body || thread.snippet || '',
            partial: !thread.body,
          });
        }
        // Ссылку строим по сохранённым данным товара этого адресата - у самой
        // переписки названия товара и цены нет.
        const url = await this._linkFor(thread.from, thread, account.id);
        const body = this._autoReplyBody(loaded, lang, url, contact);
        const res = await this.chrome.gmailReply(account.id, mailbox, thread, body);
        if (!res || !res.ok) {
          logger.warn('sender', t('reply.failed', { tid: thread.threadId, error: t('reply.notConfirmed') }));
          continue;
        }
        if (this.statsStore) this.statsStore.note('replies');
        this.repliesThisSession++;
        if (this.messageStore) {
          this.messageStore.add({
            accountKey: key, profileId: account.id, mailbox: mailbox.email,
            email: thread.from, threadId: thread.threadId,
            dir: 'out', kind: 'auto', subject: thread.subject || '',
            // В журнал кладём и текст, и разметку: лента чата показывает
            // текст, а посмотреть письмо целиком можно по разметке.
            body: body.text, html: body.html,
          });
        }
        const rec = this.dialogStore.recordReply(key, thread.threadId, {
          profileId: account.id,
          mailbox: mailbox.email,
          email: thread.from,
          seenMessageId: thread.lastMessageId,
          ownMessageId: res.lastMessageId,
        });
        logger.info('sender', t('reply.sent', {
          label: account.label + ' / ' + box, n: rec.replies, cap: maxReplies,
        }));
      } catch (e) {
        if (e && e.code === 'no_tab') {
          this.profileStore.setMailboxTab(profile.id, mailbox.email, false);
          logger.warn('sender', t('reply.mailboxGone', { label: account.label, email: box }));
          break;
        }
        logger.warn('sender', t('reply.failed', { tid: thread.threadId, error: e.message }));
      }
    }
  }

  /**
   * Тело автоответа по настройке вида ответа.
   *
   * В режиме HTML берётся один шаблон из настроек, а не случайный вариант из
   * PASTE_DICT: шаблон верстается руками, и набора вариантов у него нет.
   * Текстовая проекция остаётся всегда - на неё уходит запасной путь отправки и
   * лента чата.
   */
  _autoReplyBody(loaded, lang, url, contact) {
    if (htmlTemplate.mode(this.store) === 'html') {
      const built = htmlTemplate.build(this.store, url, contact);
      logger.debug('sender', t('reply.htmlMode'));
      return built;
    }
    return { text: texts.autoReply(loaded, lang, url, contact), html: '' };
  }

  /**
   * Сухой прогон автоответа по профилю: сканируем список писем КАЖДОЙ его почты
   * и пишем в лог, кого увидели и распознан ли отправитель как контакт рассылки.
   * Ничего не отправляем - это способ проверить связку "письмо -> контакт" до
   * первой реальной отправки.
   */
  async dryRun(profileId) {
    const account = this.profileStore.get(profileId);
    if (!account) return { ok: false, reason: 'no_profile', rows: [] };
    if (!this.chrome.isRunning(account.id)) {
      logger.warn('sender', t('dry.profileStopped', { label: account.label }));
      return { ok: false, reason: 'profile_stopped', rows: [] };
    }
    const boxes = this.profileStore.mailboxes(profileId).filter((m) => m.hasTab);
    if (!boxes.length) {
      logger.warn('sender', t('dry.noMailbox', { label: account.label }));
      return { ok: false, reason: 'no_mailbox', rows: [] };
    }
    const maxReplies = this.store.get('system').maxRepliesPerDialog;
    const rows = [];
    let scanned = 0;
    for (const mailbox of boxes) {
      const box = mailboxes.label(mailbox);
      const key = mailboxes.accountKey(profileId, mailbox.email);
      let found = [];
      try {
        found = await this.chrome.gmailListThreads(profileId, { mailbox, max: 25 });
      } catch (e) {
        logger.warn('sender', t('reply.unreadFailed', {
          label: account.label + ' / ' + box, error: e.message,
        }));
        continue;
      }
      scanned++;
      logger.info('sender', t('dry.title', {
        label: account.label + ' / ' + box, count: found.length,
      }));
      if (!found.length) logger.info('sender', t('dry.empty'));
      for (const thread of found) {
        const contact = this.contactStore ? this.contactStore.get(thread.from) : null;
        const rec = this.dialogStore.get(key, thread.threadId);
        // Тот же вердикт, что и в настоящем проходе - видно, что уйдёт, а что нет.
        const verdict = contact
          ? this.dialogStore.decide(key, thread.threadId, thread.lastMessageId, maxReplies)
          : 'unknown';
        const row = {
          threadId: thread.threadId,
          mailbox: mailbox.email,
          from: thread.from || '',
          subject: thread.subject || '',
          known: !!contact,
          title: contact ? contact.title : '',
          replies: rec ? rec.replies : 0,
          verdict,
        };
        logger.info('sender', t('dry.row', {
          subject: row.subject || '?',
          from: row.from || '?',
          contact: t(row.known ? 'dry.known' : 'dry.unknown'),
        }));
        if (row.known) {
          logger.info('sender', t('dry.verdict', {
            verdict: t('verdict.' + verdict), n: row.replies, cap: maxReplies,
          }));
        }
        rows.push(row);
      }
    }
    if (!scanned) return { ok: false, reason: 'scan_failed', rows: [] };
    return {
      ok: true, rows,
      known: rows.filter((r) => r.known).length,
      willReply: rows.filter((r) => r.verdict === 'new' || r.verdict === 'reply').length,
    };
  }

  /**
   * Ссылка Haron по контакту (данные товара) или по переданному лиду.
   *
   * `profileId` нужен только для счётчика: генератор о профилях приложения не
   * знает, а на экране число созданных ссылок стоит рядом с аккаунтом, с
   * которого их отправляли. Считаем ТОЛЬКО настоящие ссылки: при пустом ключе
   * или отказе API клиент возвращает заглушку (`placeholder: true`), и
   * записывать её в достижения нельзя.
   */
  async _linkFor(email, fallbackLead, profileId) {
    const link = this.store.get('link');
    const contact = this.contactStore ? this.contactStore.get(email) : null;
    // Площадка и страна нужны генератору: по ним собирается serviceCode, и
    // ссылка обязана соответствовать объявлению, а не общей настройке.
    const lead = contact
      ? {
        email: contact.email,
        name: contact.name,
        platform: contact.platform,
        country: contact.country,
        meta: { title: contact.title, price: contact.price, currency: contact.currency },
      }
      : (fallbackLead || {});
    const gen = await haron.generateLink({
      apiKey: link.apiKey, mode: link.mode, profileId: link.profileId,
      country: link.country, lead,
    });
    if (gen && !gen.placeholder) {
      this.linksThisSession++;
      if (profileId) this.profileStore.bumpLinks(profileId);
    }
    return gen.url;
  }

  /**
   * Ручное подталкивание по email: доп. письмо из CONFIRM_DICT со ссылкой, из
   * того же аккаунта, что писал человеку. Работает и спустя несколько рассылок -
   * данные берём из сохранённого контакта.
   */
  async nudge(email) {
    const addr = String(email || '').trim();
    if (!addr) return { ok: false, reason: 'no_email' };
    const contact = this.contactStore ? this.contactStore.get(addr) : null;
    if (!contact) {
      logger.warn('sender', t('nudge.notFound', { email: addr }));
      return { ok: false, reason: 'not_found' };
    }
    const account = this.profileStore.get(contact.profileId);
    if (!account) {
      logger.warn('sender', t('nudge.noProfile', { email: addr }));
      return { ok: false, reason: 'no_profile' };
    }
    if (!this.chrome.isRunning(account.id)) {
      logger.warn('sender', t('nudge.profileStopped', { label: account.label }));
      return { ok: false, reason: 'profile_stopped' };
    }
    // Пишем из той же почты, что и в первый раз. У контактов, записанных до
    // появления мультипочты, поля нет - тогда берём основную почту профиля и
    // говорим об этом в логе.
    let mailbox = contact.mailbox ? this.profileStore.getMailbox(account.id, contact.mailbox) : null;
    if (!mailbox) {
      mailbox = this.profileStore.mailboxes(account.id).find((m) => m.hasTab) || null;
      if (mailbox) {
        logger.warn('sender', t('nudge.mailboxGuess', {
          email: addr, mailbox: mailboxes.label(mailbox),
        }));
      }
    }
    if (!mailbox || !mailbox.hasTab) {
      logger.warn('sender', t('nudge.noMailbox', { email: addr, label: account.label }));
      return { ok: false, reason: 'no_mailbox' };
    }
    const loaded = this.store.get('texts');
    const lang = texts.outreachLang(this.store);
    const url = await this._linkFor(addr, null, account.id);
    const body = texts.nudge(loaded, lang, url, contact);
    const subject = contact.title || t('send.defaultSubject');
    logger.info('sender', t('nudge.sending', {
      email: addr, label: account.label + ' / ' + mailboxes.label(mailbox),
    }));
    const res = await this.chrome.gmailCompose(account.id, { mailbox, to: addr, subject, body });
    if (res && res.ok) {
      if (this.messageStore) {
        this.messageStore.add({
          accountKey: mailboxes.accountKey(account.id, mailbox.email),
          profileId: account.id, mailbox: mailbox.email,
          email: addr, dir: 'out', kind: 'nudge', subject, body,
        });
      }
      this.contactStore.markNudged(addr);
      logger.success('sender', t('nudge.sent', { email: addr }));
    }
    return { ok: !!(res && res.ok) };
  }

  /**
   * Пауза отправки. Автоответчик и парсер не трогаем: продавцы отвечают и во
   * время паузы, и не ответить им - хуже, чем послать лишнее письмо.
   */
  pause() {
    if (!this.running || this.paused) return { ok: false, paused: this.paused };
    this.paused = true;
    logger.warn('system', t('run.paused'));
    return { ok: true, paused: true };
  }

  resume() {
    if (!this.running || !this.paused) return { ok: false, paused: this.paused };
    this.paused = false;
    logger.success('system', t('run.resumed'));
    return { ok: true, paused: false };
  }

  async stop() {
    if (!this.running) return { ok: false };
    this.running = false;
    this.paused = false;
    // Время прогона и его счётчики обнуляем здесь же. Раньше startedAt
    // оставался, и аптайм остановленной рассылки продолжал расти - экран
    // показывал длительность, которой никто не считал.
    this.startedAt = null;
    this.sentThisSession = 0;
    this.repliesThisSession = 0;
    this.linksThisSession = 0;
    this._notifiedAllLimits = false;
    // Обновление текстов, начатое этим прогоном, применять уже некуда.
    if (this.aiTexts) this.aiTexts.reset();
    if (this._sendTimer) clearTimeout(this._sendTimer);
    if (this._replyTimer) clearTimeout(this._replyTimer);
    this.parser.stop();
    logger.info('system', t('run.stopped'));
    return { ok: true };
  }
}

module.exports = { SenderEngine };
