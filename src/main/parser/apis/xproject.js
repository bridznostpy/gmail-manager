'use strict';
/**
 * XProject Parser API client.
 *
 * TODO(docs): endpoints, auth header shape and response schema come from the
 * attached "XProject Parser API documentation" (not yet provided). Everything
 * external lives in CONFIG below so wiring the real contract is a one-place
 * change. Until then `fetchBatch` returns [] and logs a clear warning instead
 * of inventing fields.
 */
const logger = require('../../logger');

const CONFIG = {
  baseUrl: 'https://api.xproject.example', // TODO(docs)
  endpoints: {
    // batch: '/v1/leads?platform={platform}&limit={limit}',  // TODO(docs)
  },
  authHeader: 'Authorization', // TODO(docs): 'Authorization' | 'X-Api-Key' | ...
  authPrefix: 'Bearer ', // TODO(docs)
};

async function fetchBatch({ apiKey, platforms, limit }) {
  if (!apiKey) {
    logger.warn('parser', 'XProject: no API key set');
    return [];
  }
  if (!CONFIG.endpoints.batch) {
    logger.warn('parser', 'XProject: endpoint not wired yet (waiting on API docs) — returning empty batch');
    return [];
  }
  // Reference implementation once the contract is known:
  //
  //   const url = CONFIG.baseUrl + CONFIG.endpoints.batch
  //     .replace('{platform}', platforms.join(','))
  //     .replace('{limit}', String(limit));
  //   const res = await fetch(url, { headers: { [CONFIG.authHeader]: CONFIG.authPrefix + apiKey } });
  //   const data = await res.json();
  //   return data.items.map(normalizeLead);
  return [];
}

/** Map an API record to the app's internal lead shape. */
function normalizeLead(_raw) {
  return {
    id: '',
    email: '', // recipient
    name: '',
    platform: '',
    listingUrl: '',
    meta: {},
  };
}

module.exports = { fetchBatch, normalizeLead, CONFIG };
