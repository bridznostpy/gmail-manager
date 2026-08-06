'use strict';
/**
 * Parser engine — gradually fills the lead queue.
 *
 * Pulls batches from the selected parser API (XProject / VVS) and pushes leads
 * into a shared in-memory queue. Refills only when the queue drops below the
 * user's threshold, in batches of the configured size, so we never over-fetch.
 * Also handles the "rotate API key every N messages" and AI-template-swap flags
 * at the policy level (the actual swap is applied by the sender when it reads
 * the current key/template).
 */
const logger = require('../logger');
const xproject = require('./apis/xproject');
const vvs = require('./apis/vvs');

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

  /** Called by the sender after each successful first-message. */
  noteSent() {
    const { swapKeyEveryN } = this.store.get('parser');
    if (swapKeyEveryN > 0) {
      this._sentSinceKeySwap++;
      if (this._sentSinceKeySwap >= swapKeyEveryN) {
        this._sentSinceKeySwap = 0;
        logger.info('parser', `Reached ${swapKeyEveryN} messages — API key rotation point (configure additional keys to rotate)`);
      }
    }
  }

  async _refillOnce() {
    const parser = this.store.get('parser');
    const sys = this.store.get('system');
    if (this.queue.length >= sys.queueRefillThreshold) return;
    const client = parser.apiType === 'vvs' ? vvs : xproject;
    logger.info('parser', `Queue at ${this.queue.length} (< ${sys.queueRefillThreshold}) — fetching batch of ${sys.parserBatchSize}`);
    try {
      const leads = await client.fetchBatch({
        apiKey: parser.apiKey,
        platforms: parser.platforms,
        limit: sys.parserBatchSize,
      });
      if (leads.length) {
        this.queue.push(...leads);
        logger.success('parser', `Added ${leads.length} leads — queue now ${this.queue.length}`);
      }
    } catch (e) {
      logger.error('parser', `Batch fetch failed: ${e.message}`);
    }
  }

  start() {
    if (this.running) return;
    const parser = this.store.get('parser');
    if (!parser.enabled) {
      logger.warn('parser', 'Parser toggle is off — not starting');
      return;
    }
    this.running = true;
    logger.success('parser', `Parser started (${parser.apiType})`);
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
    logger.info('parser', 'Parser stopped');
  }
}

module.exports = { ParserEngine };
