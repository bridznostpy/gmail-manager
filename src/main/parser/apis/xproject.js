'use strict';
/**
 * XProject Parser API client.
 * Docs: https://api.xproject.icu/docs (OpenAPI at /openapi.json).
 *
 * Task-based: you start a parse task for one platform + a set of filters, then
 * page the results with a row_id cursor. This client keeps a small per-key task
 * registry so the engine's repeated fetchBatch() calls page through one running
 * task instead of starting a new one each time. Everything external lives in
 * CONFIG (Rules 4).
 */
const logger = require('../../logger');
const { t } = require('../../i18n');

const CONFIG = {
  baseUrl: 'https://api.xproject.icu',
  endpoints: {
    start: '/api/v1/parser/start',
    page: '/api/v1/parser/{task_id}', // ?cursor=<row_id>
    stop: '/api/v1/parser/{task_id}/stop',
    schema: '/api/v1/parser/schema',
  },
  authHeader: 'X-API-Key',
  authPrefix: '',
  defaultPlatform: 'poshmark',
  // App platform chips -> real API platform / country filter.
  platformMap: {
    usa: { country: 'us' },
    poshmark: { platform: 'poshmark' },
  },
};

// "apiKey|platform|country" -> { taskId, cursor } for the process lifetime.
const _tasks = new Map();

function _headers(apiKey) {
  return { [CONFIG.authHeader]: CONFIG.authPrefix + apiKey, 'Content-Type': 'application/json' };
}

/** Map the app's platform chips onto one API platform + filter set. */
function _resolve(platforms) {
  let platform = CONFIG.defaultPlatform;
  const filters = {};
  for (const p of platforms || []) {
    const m = CONFIG.platformMap[p];
    if (!m) continue;
    if (m.platform) platform = m.platform;
    if (m.country) filters.country = m.country;
  }
  return { platform, filters };
}

async function _startTask(apiKey, platform, filters) {
  const res = await fetch(CONFIG.baseUrl + CONFIG.endpoints.start, {
    method: 'POST', headers: _headers(apiKey),
    body: JSON.stringify({ platform, filters }),
  });
  if (res.status === 409) {
    logger.warn('parser', t('xp.taskActive', { platform }));
    return null;
  }
  if (!res.ok) {
    logger.warn('parser', t('xp.startFailed', { status: res.status }));
    return null;
  }
  const data = await res.json();
  return data && data.task_id != null ? data.task_id : null;
}

async function fetchBatch({ apiKey, platforms, limit }) {
  if (!apiKey) {
    logger.warn('parser', t('xp.noKey'));
    return [];
  }
  const { platform, filters } = _resolve(platforms);
  const key = `${apiKey}|${platform}|${filters.country || ''}`;
  let task = _tasks.get(key);
  try {
    if (!task) {
      const taskId = await _startTask(apiKey, platform, filters);
      if (taskId == null) return [];
      task = { taskId, cursor: null };
      _tasks.set(key, task);
      logger.success('parser', t('xp.taskStarted', { taskId, platform }));
    }
    const path = CONFIG.endpoints.page.replace('{task_id}', String(task.taskId));
    const url = CONFIG.baseUrl + path + (task.cursor != null ? `?cursor=${task.cursor}` : '');
    const res = await fetch(url, { headers: _headers(apiKey) });
    if (!res.ok) {
      logger.warn('parser', t('xp.pageFailed', { status: res.status }));
      return [];
    }
    const data = await res.json();
    const listings = (data && data.listings) || [];
    // Advance the cursor so the next call returns the following page. When
    // has_more is false we keep the last cursor and re-poll later for new rows.
    if (data && data.next_cursor != null) task.cursor = data.next_cursor;
    const leads = listings.map(normalizeLead).filter((l) => l.email);
    return typeof limit === 'number' ? leads.slice(0, limit) : leads;
  } catch (e) {
    logger.error('parser', t('xp.error', { error: e.message }));
    return [];
  }
}

/**
 * Дата публикации приходит полной отметкой времени ("2026-08-10T18:20:42.907Z").
 * В письме и в карточке объявления нужен день, а не миллисекунды, поэтому
 * берём часть до "T". Разбирать строку датой незачем: формат в документации
 * фиксированный, а Date добавил бы сдвиг часового пояса.
 */
function _day(value) {
  const s = String(value == null ? '' : value);
  const at = s.indexOf('T');
  return at > 0 ? s.slice(0, at) : s;
}

/** Map an API listing to the app's internal lead shape. */
function normalizeLead(raw) {
  raw = raw || {};
  return {
    id: raw.row_id != null ? String(raw.row_id) : (raw.platform_id || ''),
    email: raw.seller_email || '',
    name: raw.seller_name || '',
    platform: raw.platform || '',
    listingUrl: raw.url || '',
    meta: {
      title: raw.title || '',
      price: raw.price,
      currency: raw.currency || '',
      sellerUrl: raw.seller_url || '',
      sellerChatUrl: raw.seller_chat_url || '',
      // Поля объявления для плейсхолдеров и карточки в чатах. В ответе они
      // называются image и created_at (см. схему в документации).
      imageUrl: raw.image || '',
      datePublication: _day(raw.created_at),
    },
  };
}

module.exports = { fetchBatch, normalizeLead, CONFIG };
