'use strict';
/**
 * VVS Parser API client.
 * Docs: https://telegra.ph/Dokumentaciya-API-03-18 (base http://vvsproject.xyz).
 *
 * One-shot GET /ads/{platform} returning an object keyed by listing id. The
 * server rate-limits to 1 request / 5s - этот темп держит сам клиент, а не
 * вызывающий: цикл парсера тикает чаще, и без ворот каждый второй запрос
 * упирался бы в 429. Прилетевший всё-таки 429 - не событие для пользователя:
 * ждём и повторяем запрос молча. Everything external lives in CONFIG
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
  // Площадки из документации. Список тут для проверки: неизвестный сегмент
  // пути вернул бы ошибку, и поймать это до запроса дешевле.
  platforms: ['depop', 'poshmark', 'vinted'],
  // В этом API коды стран верхним регистром.
  countryCase: 'upper',
  // Документированный предел: не чаще одного запроса в 5 секунд.
  minIntervalMs: 5000,
  // Сколько раз повторяем запрос, получив 429. Одного хватает: ворота темпа
  // уже развели запросы, а второй отказ подряд означает, что ключом пользуется
  // кто-то ещё, и долбиться в него бессмысленно.
  retryOn429: 1,
};

// Указатель обхода стран, свой на площадку: за один запрос API отдаёт
// объявления одной страны, поэтому несколько стран обходим по очереди.
const _rr = new Map();

// Время, раньше которого следующий запрос уходить не должен. Общее на модуль:
// предел у API на ключ, а не на площадку, и разводить запросы надо все разом.
let _nextAt = 0;

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ворота темпа: дождаться своей очереди и сразу занять следующую.
 *
 * Занимаем ДО запроса, а не после ответа: два запроса, начатых одновременно,
 * иначе прошли бы ворота вместе. Ждём промисом - главный процесс при этом
 * свободен, окно не подвисает.
 */
async function _pace() {
  const now = Date.now();
  const wait = _nextAt - now;
  _nextAt = Math.max(now, _nextAt) + CONFIG.minIntervalMs;
  if (wait > 0) await _sleep(wait);
}

/**
 * Площадка и страна для очередного запроса. Площадка одна - она сегмент пути
 * /ads/{platform}. Стран может быть несколько, берём следующую по кругу.
 */
function _resolve(platform, countries) {
  const known = CONFIG.platforms.includes(platform) ? platform : CONFIG.defaultPlatform;
  if (known !== platform && platform) {
    logger.warn('parser', t('parser.unknownPlatform', { platform, used: known }));
  }
  const list = (countries || []).filter(Boolean);
  let country = '';
  if (list.length) {
    const at = (_rr.get(known) || 0) % list.length;
    _rr.set(known, at + 1);
    const code = String(list[at]);
    country = CONFIG.countryCase === 'lower' ? code.toLowerCase() : code.toUpperCase();
  }
  return { platform: known, country };
}

/**
 * Запрос с выдержкой темпа и тихим повтором на 429. Возвращает последний ответ:
 * разбор кодов остаётся у вызывающего, здесь только режим повторов.
 */
async function _get(url, apiKey) {
  const headers = { [CONFIG.authHeader]: CONFIG.authPrefix + apiKey };
  let res = null;
  for (let attempt = 0; attempt <= CONFIG.retryOn429; attempt++) {
    await _pace();
    res = await fetch(url, { headers });
    if (res.status !== 429) return res;
    logger.debug('parser', t('vvs.rateLimited'));
  }
  return res;
}

async function fetchBatch({ apiKey, platform: want, countries, filters, limit }) {
  if (!apiKey) {
    logger.warn('parser', t('vvs.noKey'));
    return [];
  }
  const { platform, country } = _resolve(want, countries);
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (CONFIG.emailOnly) params.set('email', 'true');
  if (typeof limit === 'number') params.set('limit', String(limit));
  // Фильтры из настроек идут последними, но перебить country, email и limit не
  // могут: эти три ключа зарезервированы за своими разделами настроек и до
  // сюда не доходят (см. RESERVED в parser/filters.js).
  for (const [key, value] of Object.entries(filters || {})) params.set(key, String(value));
  const url = CONFIG.baseUrl
    + CONFIG.endpoints.ads.replace('{platform}', encodeURIComponent(platform))
    + (params.toString() ? `?${params}` : '');
  try {
    const res = await _get(url, apiKey);
    // Повторы кончились, а лимит всё держится. Пачка пустая, следующий заход
    // цикла парсера попробует снова - говорить об этом пользователю нечего.
    if (res.status === 429) { logger.debug('parser', t('vvs.rateLimited')); return []; }
    if (res.status === 402) { logger.warn('parser', t('vvs.noSubscription')); return []; }
    if (res.status === 403) { logger.warn('parser', t('vvs.badKey')); return []; }
    if (!res.ok) { logger.warn('parser', t('vvs.fetchFailed', { status: res.status })); return []; }
    const data = await res.json();
    const leads = Object.entries(data || {})
      .map(([id, v]) => normalizeLead(id, v, platform, country))
      .filter((l) => l.email);
    if (leads.length) logger.info('parser', t('vvs.listings', { count: leads.length, platform }));
    return leads;
  } catch (e) {
    logger.error('parser', t('vvs.error', { error: e.message }));
    return [];
  }
}

/**
 * Map an API listing to the app's internal lead shape.
 *
 * Страну берём не из объявления, а из запроса: этот API фильтрует выдачу по
 * ?country=, поэтому вся пачка заведомо из одной страны. Она нужна генератору
 * ссылок - serviceCode у Haron Rent собирается как площадка_страна.
 */
function normalizeLead(id, raw, platform, country) {
  raw = raw || {};
  return {
    id: String(id),
    email: raw.email || '',
    name: raw.seller || '',
    platform: platform || '',
    country: String(country || '').toLowerCase(),
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

/**
 * Разовая проверка условий. У этого API задач нет - каждый запрос сам по себе,
 * поэтому проверять нечем, кроме обычного запроса. Метод есть ради общего вида
 * с XProject: вызывающему не нужно знать, у кого как устроено.
 */
async function probe(opts) {
  return fetchBatch(opts);
}

/** Останавливать нечего: задач этот API не заводит. */
async function stopAll() {}

module.exports = { fetchBatch, probe, stopAll, normalizeLead, CONFIG };
