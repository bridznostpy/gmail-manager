'use strict';
/**
 * VVS Parser API client.
 *
 * TODO(docs): endpoints/auth/schema come from the attached "VVS Parser API
 * documentation" (not yet provided). Same shape as the XProject client so the
 * parser engine can treat them interchangeably.
 */
const logger = require('../../logger');

const CONFIG = {
  baseUrl: 'https://api.vvs.example', // TODO(docs)
  endpoints: {
    // batch: '/parse?country={country}&count={count}',  // TODO(docs)
  },
  authHeader: 'X-Api-Key', // TODO(docs)
  authPrefix: '', // TODO(docs)
};

async function fetchBatch({ apiKey, platforms, limit }) {
  if (!apiKey) {
    logger.warn('parser', 'VVS: no API key set');
    return [];
  }
  if (!CONFIG.endpoints.batch) {
    logger.warn('parser', 'VVS: endpoint not wired yet (waiting on API docs) — returning empty batch');
    return [];
  }
  return [];
}

function normalizeLead(_raw) {
  return { id: '', email: '', name: '', platform: '', listingUrl: '', meta: {} };
}

module.exports = { fetchBatch, normalizeLead, CONFIG };
