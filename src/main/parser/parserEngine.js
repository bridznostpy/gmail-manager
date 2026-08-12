'use strict';
/**
 * Parser engine - gradually fills the lead queue.
 *
 * Pulls batches from the selected parser API (XProject / VVS) and pushes leads
 * into a shared in-memory queue. Refills only when the queue drops below the
 * user's threshold, in batches of the configured size, so we never over-fetch.
 * Also handles the "rotate API key every N messages" and AI-template-swap flags
 * at the policy level (the actual swap is applied by the sender when it reads
 * the current key/template).
 */
const logger = require('../logger');
const { t } = require('../i18n');
const xproject = require('./apis/xproject');
const vvs = require('./apis/vvs');
const parserFilters = require('./filters');

class ParserEngine {
  constructor(store) {
    this.store = store;
    this.queue = []; // array of normalized leads
    this.running = false;
    this._timer = null;
    this._sentSinceKeySwap = 0;
  }

  queueSize() {
    return this.queue.length;
  }

  take() {
    return this.queue.shift() || null;
  }

  /**
   * Выбросить накопленные лиды. Зовётся при старте прогона: очередь прошлого
   * запуска собрана под прошлую цель рассылки, и отправлять по ней письма
   * после смены площадки или страны - не то, о чём просили.
   */
  clear() {
    const n = this.queue.length;
    this.queue = [];
    return n;
  }

  /**
   * Вложить лид в начало очереди руками. Нужно, чтобы проверить сценарий на
   * своём адресе: письмо уходит тем же путём, что и обычная рассылка, и так же
   * попадает в контакты - иначе автоответу неоткуда взять данные товара.
   */
  pushLead(lead) {
    if (!lead || !lead.email) return null;
    this.queue.unshift(lead);
    logger.info('parser', t('parser.leadPushed', { email: lead.email, size: this.queue.length }));
    return lead;
  }

  /** Called by the sender after each successful first-message. */
  noteSent() {
    const { swapKeyEveryN } = this.store.get('parser');
    if (swapKeyEveryN > 0) {
      this._sentSinceKeySwap++;
      if (this._sentSinceKeySwap >= swapKeyEveryN) {
        this._sentSinceKeySwap = 0;
        logger.info('parser', t('parser.keyRotation', { n: swapKeyEveryN }));
      }
    }
  }

  async _refillOnce() {
    const parser = this.store.get('parser');
    const sys = this.store.get('system');
    if (this.queue.length >= sys.queueRefillThreshold) return;
    const client = parser.apiType === 'vvs' ? vvs : xproject;
    logger.info('parser', t('parser.refill', {
      size: this.queue.length, threshold: sys.queueRefillThreshold, batch: sys.parserBatchSize,
    }));
    try {
      const leads = await client.fetchBatch({
        apiKey: parser.apiKey,
        platform: parser.platform,
        countries: parser.countries,
        // Фильтры хранятся отдельно на каждую пару "тип API + площадка" и
        // приводятся к виду своего контракта - см. parser/filters.js.
        filters: parserFilters.forRun(parser),
        limit: sys.parserBatchSize,
      });
      if (leads.length) {
        this.queue.push(...leads);
        logger.success('parser', t('parser.added', { count: leads.length, size: this.queue.length }));
      }
    } catch (e) {
      logger.error('parser', t('parser.fetchFailed', { error: e.message }));
    }
  }

  start() {
    if (this.running) return;
    const parser = this.store.get('parser');
    if (!parser.enabled) {
      logger.warn('parser', t('parser.disabled'));
      return;
    }
    this.running = true;
    logger.success('parser', t('parser.started', { type: parser.apiType }));
    const loop = async () => {
      if (!this.running) return;
      await this._refillOnce();
      this._timer = setTimeout(loop, 3000);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    logger.info('parser', t('parser.stopped'));
  }
}

module.exports = { ParserEngine };
