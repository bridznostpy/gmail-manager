'use strict';
/**
 * Haron Rent link generator / API client.
 *
 * Per the spec this команда creates listings, generates order links, and works
 * with profiles and domains. TODO(docs): the attached "Haron Rent API
 * documentation" defines the exact endpoints/auth/params — kept in CONFIG so
 * wiring the real contract is localized. `generateLink` returns a clearly
 * marked placeholder link until then, so the sender pipeline runs end-to-end.
 */
const logger = require('../logger');

const CONFIG = {
  baseUrl: 'https://api.haronrent.example', // TODO(docs)
  endpoints: {
    // createLink: '/api/v1/links',      // TODO(docs)
    // createListing: '/api/v1/listings',
    // profiles: '/api/v1/profiles',
    // domains: '/api/v1/domains',
  },
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
};

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.mode      link mode
 * @param {string} opts.profileId
 * @param {string} opts.country   e.g. 'US'
 * @param {object} [opts.lead]    the recipient/listing context
 */
async function generateLink(opts) {
  const { apiKey, mode, profileId, country } = opts;
  if (!apiKey) {
    logger.warn('sender', 'Haron Rent: no API key — using placeholder link');
    return { url: `https://link.placeholder/${country || 'US'}/${profileId || 'x'}`, placeholder: true };
  }
  if (!CONFIG.endpoints.createLink) {
    logger.warn('sender', 'Haron Rent: endpoint not wired yet (waiting on API docs) — placeholder link');
    return { url: `https://link.placeholder/${mode || 'default'}/${profileId || 'x'}`, placeholder: true };
  }
  // Reference implementation once the contract is known:
  //
  //   const res = await fetch(CONFIG.baseUrl + CONFIG.endpoints.createLink, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json', [CONFIG.authHeader]: CONFIG.authPrefix + apiKey },
  //     body: JSON.stringify({ mode, profile_id: profileId, country, ...mapLead(opts.lead) }),
  //   });
  //   const data = await res.json();
  //   return { url: data.url, placeholder: false };
  return { url: `https://link.placeholder/${profileId || 'x'}`, placeholder: true };
}

module.exports = { generateLink, CONFIG };
