'use strict';
/**
 * Sender engine — orchestrates the whole run.
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
 * TODO(gmail-dom) — they depend on Gmail's current DOM and are best finalized
 * against a live logged-in profile. The orchestration, limits, sequencing,
 * queue and auto-reply loop are all real and complete.
 */
const logger = require('../logger');
const haron = require('../link/haronRent');
const telegram = require('../telegram/telegram');

class SenderEngine {
  constructor({ store, profileStore, chrome, parser }) {
    this.store = store;
    this.profileStore = profileStore;
    this.chrome = chrome;
    this.parser = parser;
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
      logger.warn('sender', 'No READY profiles — start aborted');
      return { ok: false, reason: 'no_ready_profiles' };
    }
    this.running = true;
    this.startedAt = Date.now();
    this._notifiedAllLimits = false;
    logger.success('system', `Run started with ${ready.length} ready account(s)`);

    // Launch a Chrome instance for each ready account (if not already up).
    for (const p of ready) {
      try {
        if (!this.chrome.isRunning(p.id)) {
          const inst = await this.chrome.launch(p, { url: 'https://mail.google.com/mail/u/0/#inbox' });
          this.profileStore.update(p.id, { running: true, port: inst.port });
        }
      } catch (e) {
        logger.error('cdp', `Could not launch "${p.label}": ${e.message}`);
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
        logger.warn('system', 'All accounts reached their send limit — staying in auto-reply mode');
        await telegram.notify(this.store, '✅ All Gmail accounts reached their send limit. Auto-reply mode continues until you stop.');
      }
      this._sendTimer = setTimeout(() => this._sendLoop(), 5000);
      return;
    }
    const lead = this.parser.take();
    if (!lead) {
      // Queue empty — wait for the parser to refill.
      this._sendTimer = setTimeout(() => this._sendLoop(), 2000);
      return;
    }
    try {
      await this._sendFirstMessage(account, lead);
      this.profileStore.update(account.id, { sentCount: account.sentCount + 1 });
      this.parser.noteSent();
    } catch (e) {
      logger.error('sender', `Send failed for "${account.label}": ${e.message}`);
    }
    // Small spacing between sends; the real cadence is bounded by Gmail itself.
    this._sendTimer = setTimeout(() => this._sendLoop(), 1500);
  }

  async _sendFirstMessage(account, lead) {
    if (!lead || !lead.email) throw new Error('lead has no recipient email');
    const link = this.store.get('link');
    const gen = await haron.generateLink({
      apiKey: link.apiKey, mode: link.mode, profileId: link.profileId,
      country: link.country, lead,
    });
    const texts = this.store.get('texts');
    const { subject, body } = this._composeText(texts, lead, gen.url);
    logger.info('sender', `"${account.label}" -> ${lead.email} | subj: "${subject}"`);
    // Drive Gmail compose over CDP against the logged-in profile.
    // TODO(gmail-dom): validate the compose/send selectors on a live account.
    await this.chrome.gmailCompose(account.id, { to: lead.email, subject, body });
    return { subject, body };
  }

  _composeText(texts, lead, link) {
    const fallback = {
      subjects: ['Hello'], bodies: ['Hi {name}, here is the link: {link}'],
    };
    const t = texts && texts.subjects ? texts : fallback;
    const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const fill = (s) => String(s).replace(/\{link\}/g, link).replace(/\{name\}/g, lead.name || 'there');
    return { subject: fill(rnd(t.subjects)), body: fill(rnd(t.bodies)) };
  }

  /** Build the auto-reply body from the loaded texts JSON (texts.autoReply). */
  _composeAutoReply(texts, ctx, link) {
    const fallback = 'Thanks for your reply! Here is the link to continue: {link}';
    const ar = texts && texts.autoReply ? texts.autoReply : null;
    const raw = ar && ar.text ? ar.text : fallback;
    return String(raw)
      .replace(/\{link\}/g, link || '')
      .replace(/\{name\}/g, (ctx && ctx.name) || 'there');
  }

  async _replyLoop() {
    if (!this.running) return;
    const intervalMs = Math.max(3, this.store.get('system').checkIntervalSec) * 1000;
    try {
      await this._pollReplies();
    } catch (e) {
      logger.error('sender', `Reply poll error: ${e.message}`);
    }
    this._replyTimer = setTimeout(() => this._replyLoop(), intervalMs);
  }

  async _pollReplies() {
    const maxReplies = this.store.get('system').maxRepliesPerDialog;
    const texts = this.store.get('texts');
    // Auto-reply is on unless the texts JSON explicitly disables it.
    const enabled = !texts || !texts.autoReply || texts.autoReply.enabled !== false;
    if (!enabled) {
      logger.debug('sender', 'Auto-reply disabled in texts JSON');
      return;
    }
    const link = this.store.get('link');
    const accounts = this._runningReady();
    logger.debug('sender', `Auto-reply poll over ${accounts.length} account(s) (cap ${maxReplies}/dialog)`);
    for (const account of accounts) {
      let unread = [];
      try {
        unread = await this.chrome.gmailListUnread(account.id);
      } catch (e) {
        logger.warn('sender', `Unread scan failed for "${account.label}": ${e.message}`);
        continue;
      }
      for (const thread of unread) {
        const key = account.id + ':' + thread.threadId;
        const dialog = this.dialogs.get(key) || { replies: 0 };
        if (dialog.replies >= maxReplies) continue;
        try {
          const gen = await haron.generateLink({
            apiKey: link.apiKey, mode: link.mode, profileId: link.profileId,
            country: link.country, lead: thread,
          });
          const text = this._composeAutoReply(texts, { name: thread.from }, gen.url);
          await this.chrome.gmailReply(account.id, thread, text);
          dialog.replies += 1;
          this.dialogs.set(key, dialog);
          logger.info('sender', `Auto-replied in "${account.label}" thread (${dialog.replies}/${maxReplies})`);
        } catch (e) {
          logger.warn('sender', `Auto-reply failed (${thread.threadId}): ${e.message}`);
        }
      }
    }
  }

  async stop() {
    if (!this.running) return { ok: false };
    this.running = false;
    if (this._sendTimer) clearTimeout(this._sendTimer);
    if (this._replyTimer) clearTimeout(this._replyTimer);
    this.parser.stop();
    logger.info('system', 'Run stopped (Chrome instances left open; stop them from Profiles if desired)');
    return { ok: true };
  }
}

module.exports = { SenderEngine };
