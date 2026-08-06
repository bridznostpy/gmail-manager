'use strict';
/**
 * Telegram notifications via the Bot API (no external deps — plain HTTPS).
 * Used to alert the user when all profiles hit their send limit, and for
 * status pings. Fails soft: a missing token or network error is logged, never
 * thrown into the engines.
 */
const https = require('https');
const logger = require('./../logger');

function apiCall(token, method, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify(params);
    const req = https.request(
      {
        host: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (_e) { resolve({ ok: false }); }
        });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

async function notify(store, text) {
  const { botToken, botId } = store.get('telegram');
  if (!botToken || !botId) {
    logger.debug('telegram', 'notify skipped — token or chat id not set');
    return { ok: false, reason: 'not_configured' };
  }
  const res = await apiCall(botToken, 'sendMessage', { chat_id: botId, text });
  if (res && res.ok) logger.info('telegram', 'Notification sent');
  else logger.warn('telegram', 'Telegram notify failed');
  return res;
}

async function test(botToken) {
  if (!botToken) return { ok: false };
  const res = await apiCall(botToken, 'getMe', {});
  return res;
}

module.exports = { notify, test };
