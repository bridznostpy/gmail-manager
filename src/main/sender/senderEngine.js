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
 *     the configured auto-reply, capped at `maxRepliesPerDialog`.
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

class SenderEngine {
  constructor({ store, profileStore, chrome, parser, contactStore, dialogStore, statsStore, messageStore }) {
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
    this.running = false;
    // Пауза - это остановленная ОТПРАВКА при живом прогоне: автоответчик
    // продолжает опрашивать почту, аптайм идёт, очередь не теряется.
    this.paused = false;
    this.startedAt = null;
    this._sendTimer = null;
    this._replyTimer = null;
    this._notifiedAllLimits = false;
    // Идёт проход автоответа - новые письма в это время не шлём, см. _sendLoop.
    this._replying = false;
  }

  status() {
    return {
      running: this.running,
      paused: this.running && this.paused,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      queueSize: this.parser.queueSize(),
    };
  }

  _readyProfiles() {
    return this.profileStore.list().filter((p) => p.gmailStatus === 'ready');
  }

  /** Ready accounts whose Chrome instance is actually up (for reply-scanning). */
  _runningReady() {
    return this._readyProfiles().filter((p) => this.chrome.isRunning(p.id));
  }

  _allLimitsReached() {
    const limit = this.store.get('system').mailsPerAccount;
    const ready = this._readyProfiles();
    return ready.length > 0 && ready.every((p) => p.sentCount >= limit);
  }

  /** The next account still under its send limit (sequential fill). */
  _currentAccount() {
    const limit = this.store.get('system').mailsPerAccount;
    return this._readyProfiles().find((p) => p.sentCount < limit) || null;
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
    this._notifiedAllLimits = false;
    logger.success('system', t('run.started', { count: ready.length }));

    // Launch a Chrome instance for each ready account (if not already up).
    for (const p of ready) {
      try {
        if (!this.chrome.isRunning(p.id)) {
          const inst = await this.chrome.launch(p, { url: 'https://mail.google.com/mail/u/0/#inbox' });
          this.profileStore.update(p.id, { running: true, port: inst.port });
        }
      } catch (e) {
        logger.error('cdp', t('cdp.launchFailed', { label: p.label, error: e.message }));
      }
    }

    this.parser.start();
    this._sendLoop();
    this._replyLoop();
    return { ok: true };
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
    const account = this._currentAccount();
    if (!account) {
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
    try {
      await this._sendFirstMessage(account, lead);
      this.profileStore.update(account.id, { sentCount: account.sentCount + 1 });
      // Сохраняем контакт с данными товара, чтобы позже подтолкнуть по email.
      if (this.contactStore) this.contactStore.recordSent({ lead, profile: account });
      if (this.statsStore) this.statsStore.note('sent');
      this.parser.noteSent();
    } catch (e) {
      if (this.statsStore) this.statsStore.note('errors');
      logger.error('sender', t('send.failed', { label: account.label, error: e.message }));
    }
    // Пауза между письмами - из настроек. Ждём именно здесь, после отправки:
    // очередь и лимиты уже сошлись, и следующий заход начнётся с чистого места.
    this._sendTimer = setTimeout(() => this._sendLoop(), this._sendDelayMs());
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

  async _sendFirstMessage(account, lead) {
    if (!lead || !lead.email) throw new Error(t('err.noLeadEmail'));
    // Первое письмо ссылки не несёт: тема - название товара из парсера, тело -
    // случайный текст из MESSAGES_DICT на языке рассылки.
    const loaded = this.store.get('texts');
    const lang = texts.outreachLang(this.store);
    const subject = (lead.meta && lead.meta.title) || lead.title || t('send.defaultSubject');
    const body = texts.firstMessage(loaded, lang);
    logger.info('sender', t('send.message', { label: account.label, to: lead.email, subject }));
    // Drive Gmail compose with Playwright against the logged-in profile.
    // TODO(gmail-dom): validate the compose/send selectors on a live account.
    await this.chrome.gmailCompose(account.id, { to: lead.email, subject, body });
    if (this.messageStore) {
      this.messageStore.add({
        profileId: account.id, email: lead.email, dir: 'out', kind: 'first', subject, body,
      });
    }
    return { subject, body };
  }

  async _replyLoop() {
    if (!this.running) return;
    const intervalMs = Math.max(3, this.store.get('system').checkIntervalSec) * 1000;
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
   * Проход автоответчика.
   *
   * Сценарий: продавец ответил - отвечаем ему. Написал после нашего ответа
   * снова - отвечаем снова, и так по кругу, пока не упрёмся в лимит ответов на
   * диалог. Прочитанность письма в этом решении не участвует: это состояние
   * Gmail, оно отстаёт и зависит от того, открывали ли переписку. Учёт свой,
   * в dialogStore, и он переживает перезапуск приложения.
   */
  async _pollReplies() {
    const maxReplies = this.store.get('system').maxRepliesPerDialog;
    const loaded = this.store.get('texts');
    const lang = texts.outreachLang(this.store);
    // Автоответ включён, если в JSON нет явного выключателя.
    const enabled = !loaded || !loaded.autoReply || loaded.autoReply.enabled !== false;
    if (!enabled) {
      logger.debug('sender', t('reply.disabled'));
      return;
    }
    const accounts = this._runningReady();
    logger.debug('sender', t('reply.poll', { count: accounts.length, cap: maxReplies }));
    for (const account of accounts) {
      let rows = [];
      try {
        // Берём весь список, а не только непрочитанное: что новое, а что нет,
        // решаем сами по идентификатору последнего письма треда.
        rows = await this.chrome.gmailListThreads(account.id, { max: 25 });
      } catch (e) {
        logger.warn('sender', t('reply.unreadFailed', { label: account.label, error: e.message }));
        continue;
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
          account.id, thread.threadId, thread.lastMessageId, maxReplies,
        );
        if (verdict === 'same') continue;
        if (verdict === 'limit') {
          // Запоминаем письмо, чтобы не разбирать эту переписку каждый проход.
          this.dialogStore.noteSeen(account.id, thread.threadId, thread.lastMessageId);
          logger.debug('sender', t('reply.capReached', { tid: thread.threadId, cap: maxReplies }));
          continue;
        }
        if (verdict === 'own') {
          // Последнее письмо треда - наш же прошлый ответ, а не новое от
          // продавца. Просто запоминаем его.
          this.dialogStore.noteSeen(account.id, thread.threadId, thread.lastMessageId);
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
              profileId: account.id, email: thread.from, threadId: thread.threadId,
            });
            this.messageStore.add({
              profileId: account.id, email: thread.from, threadId: thread.threadId,
              dir: 'in', kind: 'reply',
              subject: thread.subject || '',
              body: thread.body || thread.snippet || '',
              partial: !thread.body,
            });
          }
          // Ссылку строим по сохранённым данным товара этого адресата - у самой
          // переписки названия товара и цены нет.
          const url = await this._linkFor(thread.from, thread);
          const body = this._autoReplyBody(loaded, lang, url, contact);
          const res = await this.chrome.gmailReply(account.id, thread, body);
          if (!res || !res.ok) {
            logger.warn('sender', t('reply.failed', { tid: thread.threadId, error: t('reply.notConfirmed') }));
            continue;
          }
          if (this.statsStore) this.statsStore.note('replies');
          if (this.messageStore) {
            this.messageStore.add({
              profileId: account.id, email: thread.from, threadId: thread.threadId,
              dir: 'out', kind: 'auto', subject: thread.subject || '',
              // В журнал кладём и текст, и разметку: лента чата показывает
              // текст, а посмотреть письмо целиком можно по разметке.
              body: body.text, html: body.html,
            });
          }
          const rec = this.dialogStore.recordReply(account.id, thread.threadId, {
            email: thread.from,
            seenMessageId: thread.lastMessageId,
            ownMessageId: res.lastMessageId,
          });
          logger.info('sender', t('reply.sent', { label: account.label, n: rec.replies, cap: maxReplies }));
        } catch (e) {
          logger.warn('sender', t('reply.failed', { tid: thread.threadId, error: e.message }));
        }
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
   * Сухой прогон автоответа по одному профилю: сканируем непрочитанные и пишем
   * в лог, кого увидели и распознан ли отправитель как контакт рассылки.
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
    let found = [];
    try {
      found = await this.chrome.gmailListThreads(account.id, { max: 25 });
    } catch (e) {
      logger.warn('sender', t('reply.unreadFailed', { label: account.label, error: e.message }));
      return { ok: false, reason: 'scan_failed', rows: [] };
    }
    const maxReplies = this.store.get('system').maxRepliesPerDialog;
    logger.info('sender', t('dry.title', { label: account.label, count: found.length }));
    if (!found.length) logger.info('sender', t('dry.empty'));
    const rows = found.map((thread) => {
      const contact = this.contactStore ? this.contactStore.get(thread.from) : null;
      const rec = this.dialogStore.get(account.id, thread.threadId);
      // Тот же вердикт, что и в настоящем проходе - видно, что уйдёт, а что нет.
      const verdict = contact
        ? this.dialogStore.decide(account.id, thread.threadId, thread.lastMessageId, maxReplies)
        : 'unknown';
      const row = {
        threadId: thread.threadId,
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
      return row;
    });
    return {
      ok: true, rows,
      known: rows.filter((r) => r.known).length,
      willReply: rows.filter((r) => r.verdict === 'new' || r.verdict === 'reply').length,
    };
  }

  /** Ссылка Haron по контакту (данные товара) или по переданному лиду. */
  async _linkFor(email, fallbackLead) {
    const link = this.store.get('link');
    const contact = this.contactStore ? this.contactStore.get(email) : null;
    const lead = contact
      ? { email: contact.email, name: contact.name, meta: { title: contact.title, price: contact.price, currency: contact.currency } }
      : (fallbackLead || {});
    const gen = await haron.generateLink({
      apiKey: link.apiKey, mode: link.mode, profileId: link.profileId,
      country: link.country, lead,
    });
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
    const loaded = this.store.get('texts');
    const lang = texts.outreachLang(this.store);
    const url = await this._linkFor(addr, null);
    const body = texts.nudge(loaded, lang, url, contact);
    const subject = contact.title || t('send.defaultSubject');
    logger.info('sender', t('nudge.sending', { email: addr, label: account.label }));
    const res = await this.chrome.gmailCompose(account.id, { to: addr, subject, body });
    if (res && res.ok) {
      if (this.messageStore) {
        this.messageStore.add({
          profileId: account.id, email: addr, dir: 'out', kind: 'nudge', subject, body,
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
    if (this._sendTimer) clearTimeout(this._sendTimer);
    if (this._replyTimer) clearTimeout(this._replyTimer);
    this.parser.stop();
    logger.info('system', t('run.stopped'));
    return { ok: true };
  }
}

module.exports = { SenderEngine };
