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
 * over CDP against the logged-in Gmail tab. The DOM automation hooks are marked
 * TODO(gmail-dom) - they depend on Gmail's current DOM and are best finalized
 * against a live logged-in profile. The orchestration, limits, sequencing,
 * queue and auto-reply loop are all real and complete.
 */
const logger = require('../logger');
const { t } = require('../i18n');
const haron = require('../link/haronRent');
const telegram = require('../telegram/telegram');
const texts = require('../texts');

class SenderEngine {
  constructor({ store, profileStore, chrome, parser, contactStore }) {
    this.store = store;
    this.profileStore = profileStore;
    this.chrome = chrome;
    this.parser = parser;
    this.contactStore = contactStore;
    this.running = false;
    this.startedAt = null;
    this._sendTimer = null;
    this._replyTimer = null;
    this.dialogs = new Map(); // dialogId -> { replies: n }
    this._notifiedAllLimits = false;
  }

  status() {
    return {
      running: this.running,
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
      this.parser.noteSent();
    } catch (e) {
      logger.error('sender', t('send.failed', { label: account.label, error: e.message }));
    }
    // Small spacing between sends; the real cadence is bounded by Gmail itself.
    this._sendTimer = setTimeout(() => this._sendLoop(), 1500);
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
    // Drive Gmail compose over CDP against the logged-in profile.
    // TODO(gmail-dom): validate the compose/send selectors on a live account.
    await this.chrome.gmailCompose(account.id, { to: lead.email, subject, body });
    return { subject, body };
  }

  async _replyLoop() {
    if (!this.running) return;
    const intervalMs = Math.max(3, this.store.get('system').checkIntervalSec) * 1000;
    try {
      await this._pollReplies();
    } catch (e) {
      logger.error('sender', t('reply.pollError', { error: e.message }));
    }
    this._replyTimer = setTimeout(() => this._replyLoop(), intervalMs);
  }

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
      let unread = [];
      try {
        unread = await this.chrome.gmailListUnread(account.id);
      } catch (e) {
        logger.warn('sender', t('reply.unreadFailed', { label: account.label, error: e.message }));
        continue;
      }
      for (const thread of unread) {
        // Отвечаем ТОЛЬКО тем, кому сами писали в этой рассылке. Иначе PASTE со
        // ссылкой ушёл бы на любое непрочитанное письмо в инбоксе (промо,
        // служебные письма Gmail), а не на реальный ответ покупателя.
        const contact = this.contactStore ? this.contactStore.get(thread.from) : null;
        if (!contact) {
          logger.debug('sender', t('reply.skipUnknown', { from: thread.from || '?' }));
          continue;
        }
        const key = account.id + ':' + thread.threadId;
        const dialog = this.dialogs.get(key) || { replies: 0 };
        if (dialog.replies >= maxReplies) continue;
        try {
          // Ссылку строим по сохранённым данным товара этого адресата - у самой
          // переписки названия товара и цены нет.
          const url = await this._linkFor(thread.from, thread);
          const text = texts.autoReply(loaded, lang, url, contact);
          await this.chrome.gmailReply(account.id, thread, text);
          dialog.replies += 1;
          this.dialogs.set(key, dialog);
          logger.info('sender', t('reply.sent', { label: account.label, n: dialog.replies, cap: maxReplies }));
        } catch (e) {
          logger.warn('sender', t('reply.failed', { tid: thread.threadId, error: e.message }));
        }
      }
    }
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
    let unread = [];
    try {
      unread = await this.chrome.gmailListUnread(account.id);
    } catch (e) {
      logger.warn('sender', t('reply.unreadFailed', { label: account.label, error: e.message }));
      return { ok: false, reason: 'scan_failed', rows: [] };
    }
    logger.info('sender', t('dry.title', { label: account.label, count: unread.length }));
    if (!unread.length) logger.info('sender', t('dry.empty'));
    const rows = unread.map((thread) => {
      const contact = this.contactStore ? this.contactStore.get(thread.from) : null;
      const row = {
        threadId: thread.threadId,
        from: thread.from || '',
        subject: thread.subject || '',
        known: !!contact,
        title: contact ? contact.title : '',
      };
      logger.info('sender', t('dry.row', {
        subject: row.subject || '?',
        from: row.from || '?',
        contact: t(row.known ? 'dry.known' : 'dry.unknown'),
      }));
      return row;
    });
    return { ok: true, rows, known: rows.filter((r) => r.known).length };
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
      this.contactStore.markNudged(addr);
      logger.success('sender', t('nudge.sent', { email: addr }));
    }
    return { ok: !!(res && res.ok) };
  }

  async stop() {
    if (!this.running) return { ok: false };
    this.running = false;
    if (this._sendTimer) clearTimeout(this._sendTimer);
    if (this._replyTimer) clearTimeout(this._replyTimer);
    this.parser.stop();
    logger.info('system', t('run.stopped'));
    return { ok: true };
  }
}

module.exports = { SenderEngine };
