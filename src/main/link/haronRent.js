'use strict';
/**
 * Haron Rent link generator / API client.
 * Docs (Swagger): https://haronrent.xyz/docs  (base https://haronrent.xyz/api/v1).
 * Auth: Authorization: Bearer <token>. Every response is an envelope
 * { status: bool, message, data: {...} } — status must be true.
 *
 * generateLink() maps the app's Link Generator settings + the current lead onto
 * POST /api/v1/createAd and returns the generated ad link (adShortUrl || adUrl).
 * It fails soft: any missing config / API error yields a clearly-marked
 * placeholder link so the sender pipeline keeps running. Everything external
 * lives in CONFIG (Rules 4).
 */
const logger = require('../logger');

const CONFIG = {
  baseUrl: 'https://haronrent.xyz/api/v1',
  endpoints: {
    createAd: '/createAd',
    getServices: '/getServices',
    getProfiles: '/getProfiles',
    getCountries: '/getCountries',
    getMe: '/getMe',
  },
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  defaultVersion: '2', // 2 = Получение, 1 = Оплата, 0 = Верификация
  defaultTitle: 'Order',
  defaultPrice: '100',
};

function headers(apiKey) {
  return {
    [CONFIG.authHeader]: CONFIG.authPrefix + apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function placeholder(profileId, country) {
  return { url: `https://link.placeholder/${country || 'US'}/${profileId || 'x'}`, placeholder: true };
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.mode      link mode = serviceCode (see GET /getServices, e.g. offerup_us)
 * @param {string} opts.profileId createAd profileId (from GET /getProfiles)
 * @param {string} opts.country   e.g. 'US'
 * @param {object} [opts.lead]    the recipient/listing context (title, price)
 */
async function generateLink(opts) {
  const { apiKey, mode, profileId, country, lead } = opts || {};
  if (!apiKey) {
    logger.warn('sender', 'Haron Rent: no API key - using placeholder link');
    return placeholder(profileId, country);
  }
  // The app's "link mode" is the serviceCode required by createAd.
  const serviceCode = mode || '';
  if (!serviceCode) {
    logger.warn('sender', 'Haron Rent: link mode (serviceCode) not set - using placeholder link');
    return placeholder(profileId, country);
  }

  const leadTitle = (lead && ((lead.meta && lead.meta.title) || lead.title)) || CONFIG.defaultTitle;
  const leadPrice = (lead && ((lead.meta && lead.meta.price) || lead.price)) || CONFIG.defaultPrice;
  const payload = {
    serviceCode,
    version: CONFIG.defaultVersion,
    title: String(leadTitle),
    price: String(leadPrice),
  };
  if (profileId) {
    const n = Number(profileId);
    payload.profileId = Number.isFinite(n) ? n : profileId;
  }

  try {
    const res = await fetch(CONFIG.baseUrl + CONFIG.endpoints.createAd, {
      method: 'POST', headers: headers(apiKey), body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.status !== true) {
      const msg = (data && data.message) || `HTTP ${res.status}`;
      logger.warn('sender', `Haron Rent: createAd failed (${msg}) - using placeholder link`);
      return placeholder(profileId, country);
    }
    const d = data.data || {};
    const url = d.adShortUrl || d.adUrl || d.adCustomDomainUrl || '';
    if (!url) {
      logger.warn('sender', 'Haron Rent: createAd returned no url - using placeholder link');
      return placeholder(profileId, country);
    }
    logger.success('sender', `Haron Rent: link created (adId ${d.adId})`);
    return { url, placeholder: false, adId: d.adId };
  } catch (e) {
    logger.error('sender', `Haron Rent: ${e.message} - using placeholder link`);
    return placeholder(profileId, country);
  }
}

module.exports = { generateLink, CONFIG };
