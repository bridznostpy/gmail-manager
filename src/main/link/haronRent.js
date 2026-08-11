'use strict';
/**
 * Haron Rent link generator / API client.
 * Docs (Swagger): https://haronrent.xyz/docs  (base https://haronrent.xyz/api/v1).
 * Auth: Authorization: Bearer <token>. Every response is an envelope
 * { status: bool, message, data: {...} } - status must be true.
 *
 * generateLink() maps the app's Link Generator settings + the current lead onto
 * POST /api/v1/createAd and returns the generated ad link (adShortUrl || adUrl).
 * It fails soft: any missing config / API error yields a clearly-marked
 * placeholder link so the sender pipeline keeps running. Everything external
 * lives in CONFIG (Rules 4).
 */
const logger = require('../logger');
const { t } = require('../i18n');

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
  /**
   * serviceCode в этом API собран как площадка_страна нижним регистром
   * (offerup_us, vinted_de, poshmark_us) - см. GET /getServices.
   *
   * Коды стран у Haron Rent местами расходятся с ISO, которым размечены
   * объявления в парсере: Великобритания у него uk, а не gb. Разошедшиеся
   * коды переводим здесь; совпадающие идут как есть.
   */
  serviceSep: '_',
  countryAlias: { gb: 'uk' },
};

/**
 * Код услуги под конкретное объявление.
 *
 * Ссылка обязана соответствовать площадке и стране продавца: одна на всю
 * рассылку означала бы, что немец получает американскую страницу подтверждения.
 * Возвращает пустую строку, если чего-то из пары не знаем - тогда вызывающий
 * код падает на ручную настройку или на заглушку, но не шлёт заведомо чужой код.
 */
function serviceCodeFor(platform, country) {
  const p = String(platform || '').trim().toLowerCase();
  const c = String(country || '').trim().toLowerCase();
  if (!p || !c) return '';
  return p + CONFIG.serviceSep + (CONFIG.countryAlias[c] || c);
}

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
 * @param {string} opts.mode      ручное переопределение serviceCode; пусто - собираем сами
 * @param {string} opts.profileId createAd profileId (from GET /getProfiles)
 * @param {string} opts.country   страна из настроек - запасной вариант, если у лида её нет
 * @param {object} [opts.lead]    the recipient/listing context (platform, country, title, price)
 */
async function generateLink(opts) {
  const { apiKey, mode, profileId, country, lead } = opts || {};
  if (!apiKey) {
    logger.warn('sender', t('haron.noKey'));
    return placeholder(profileId, country);
  }
  // Код услуги идёт за объявлением: площадка и страна берутся у самого лида.
  // Ручной режим из настроек остаётся переопределением - он нужен для услуг,
  // которые из пары "площадка + страна" не выводятся (например custom_eu).
  const auto = serviceCodeFor(lead && lead.platform, (lead && lead.country) || country);
  const serviceCode = mode || auto;
  if (!serviceCode) {
    logger.warn('sender', t('haron.noMode'));
    return placeholder(profileId, country);
  }
  if (!mode) logger.info('sender', t('haron.autoService', { code: serviceCode }));

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
      logger.warn('sender', t('haron.createFailed', { message: msg }));
      return placeholder(profileId, country);
    }
    const d = data.data || {};
    const url = d.adShortUrl || d.adUrl || d.adCustomDomainUrl || '';
    if (!url) {
      logger.warn('sender', t('haron.noUrl'));
      return placeholder(profileId, country);
    }
    logger.success('sender', t('haron.created', { adId: d.adId }));
    return { url, placeholder: false, adId: d.adId };
  } catch (e) {
    logger.error('sender', t('haron.error', { error: e.message }));
    return placeholder(profileId, country);
  }
}

module.exports = { generateLink, serviceCodeFor, CONFIG };
