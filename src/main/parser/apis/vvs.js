'use strict';
/**
 * VVS Parser API client.
 * Docs: https://telegra.ph/Dokumentaciya-API-03-18 (base http://vvsproject.xyz).
 *
 * One-shot GET /ads/{platform} returning an object keyed by listing id. The
 * server rate-limits to 1 request / 5s, so the engine may occasionally get a
 * 429 (logged and skipped, not fatal). Everything external lives in CONFIG
 * (Rules 4). Same normalized lead shape as the XProject client.
 */
const logger = require('../../logger');
const { t } = require('../../i18n');

const CONFIG = {
  baseUrl: 'http://vvsproject.xyz',
  endpoints: { ads: '/ads/{platform}' },
  authHeader: 'api-key',
  authPrefix: '',
  defaultPlatform: 'poshmark',
  emailOnly: true, // email=true asks the parser for gmail-validated listings
  // App platform chips -> real API platform / country filter.
  platformMap: {
    usa: { country: 'US' },
    poshmark: { platform: 'poshmark' },
  },
};

/** Map the app's platform chips onto one API platform + country. */
function _resolve(platforms) {
  let platform = CONFIG.defaultPlatform;
  let country = '';
  for (const p of platforms || []) {
    const m = CONFIG.platformMap[p];
    if (!m) continue;
    if (m.platform) platform = m.platform;
    if (m.country) country = m.country;
  }
  return { platform, country };
}

async function fetchBatch({ apiKey, platforms, limit }) {
  if (!apiKey) {
    logger.warn('parser', t('vvs.noKey'));
    return [];
  }
  const { platform, country } = _resolve(platforms);
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (CONFIG.emailOnly) params.set('email', 'true');
  if (typeof limit === 'number') params.set('limit', String(limit));
  const url = CONFIG.baseUrl
    + CONFIG.endpoints.ads.replace('{platform}', encodeURIComponent(platform))
    + (params.toString() ? `?${params}` : '');
  try {
    const res = await fetch(url, { headers: { [CONFIG.authHeader]: CONFIG.authPrefix + apiKey } });
    if (res.status === 429) { logger.warn('parser', t('vvs.rateLimited')); return []; }
    if (res.status === 402) { logger.warn('parser', t('vvs.noSubscription')); return []; }
    if (res.status === 403) { logger.warn('parser', t('vvs.badKey')); return []; }
    if (!res.ok) { logger.warn('parser', t('vvs.fetchFailed', { status: res.status })); return []; }
    const data = await res.json();
    const leads = Object.entries(data || {})
      .map(([id, v]) => normalizeLead(id, v, platform))
      .filter((l) => l.email);
    if (leads.length) logger.info('parser', t('vvs.listings', { count: leads.length, platform }));
    return leads;
  } catch (e) {
    logger.error('parser', t('vvs.error', { error: e.message }));
    return [];
  }
}

/** Map an API listing to the app's internal lead shape. */
function normalizeLead(id, raw, platform) {
  raw = raw || {};
  return {
    id: String(id),
    email: raw.email || '',
    name: raw.seller || '',
    platform: platform || '',
    listingUrl: raw.ad_url || '',
    meta: {
      title: raw.title || '',
      price: raw.price || '',
      sellerUrl: raw.seller_url || '',
      chatUrl: raw.chat_url || '',
      imageUrl: raw.image_url || '',
      datePublication: raw.date_publication || '',
    },
  };
}

module.exports = { fetchBatch, normalizeLead, CONFIG };
