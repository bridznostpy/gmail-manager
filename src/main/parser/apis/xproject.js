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
  // Сколько живёт схема площадок в памяти процесса. Она меняется на стороне
  // API редко, а спрашивают её перед каждым запросом пачки.
  schemaTtlMs: 30 * 60 * 1000,
  // Неудачную попытку помним меньше: сеть могла отвалиться на минуту, но и
  // долбить схему каждые три секунды при пополнении очереди незачем.
  schemaFailTtlMs: 5 * 60 * 1000,
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
  // Значения enum Platform из документации. Задача заводится ровно под одну
  // площадку, поэтому список тут только для проверки: неизвестное значение
  // вернуло бы 422, и лучше поймать это до запроса.
  platforms: ['depop', 'poshmark', 'vinted'],
  // Ключ фильтра стран в start.filters. Именно countries, списком кодов ISO-2 в
  // нижнем регистре: строку API разбирает по буквам ("us" -> 'u', 's'), а
  // ключ country из примера в документации площадка не принимает вовсе (422).
  countryFilter: 'countries',
  countryCase: 'lower',
};

// "apiKey|platform|country|фильтры" -> { taskId, cursor } for the process
// lifetime. Фильтры входят в ключ: другой набор - другая задача на стороне API,
// и брать для неё курсор от прошлой значило бы пропустить начало выдачи.
const _tasks = new Map();
// Схема площадок, полученная с /parser/schema: { at, data } по ключу API.
const _schema = new Map();

function _headers(apiKey) {
  return { [CONFIG.authHeader]: CONFIG.authPrefix + apiKey, 'Content-Type': 'application/json' };
}

/**
 * Площадка и страны для очередного запроса.
 *
 * Площадка одна - так устроен start: одна задача под одну платформу. Страны
 * уходят все сразу списком: их ключ во множественном числе, и задача сама
 * собирает объявления по всем отмеченным. Обходить страны по очереди, как
 * делает VVS, здесь не нужно - это лишь дробило бы выдачу на несколько задач.
 */
function _resolve(platform, countries) {
  const known = CONFIG.platforms.includes(platform) ? platform : CONFIG.defaultPlatform;
  if (known !== platform && platform) {
    logger.warn('parser', t('parser.unknownPlatform', { platform, used: known }));
  }
  const list = (countries || []).filter(Boolean).map((c) => (
    CONFIG.countryCase === 'lower' ? String(c).toLowerCase() : String(c).toUpperCase()
  ));
  const filters = {};
  if (list.length) filters[CONFIG.countryFilter] = list;
  return { platform: known, filters };
}

/**
 * Справочник площадок: страны, категории и допустимые ключи фильтров.
 *
 * Нужен настройкам фильтров - в документации перечня категорий нет, его знает
 * только API. Держим в памяти процесса: настройки открывают часто, а меняется
 * справочник редко. Неудача не ломает ничего - меню покажет документированный
 * минимум.
 */
async function fetchSchema(apiKey, opts) {
  if (!apiKey) return null;
  const force = !!(opts && opts.force);
  const hit = _schema.get(apiKey);
  const ttl = hit && hit.data ? CONFIG.schemaTtlMs : CONFIG.schemaFailTtlMs;
  if (!force && hit && Date.now() - hit.at < ttl) return hit.data;
  const keep = (data) => {
    _schema.set(apiKey, { at: Date.now(), data });
    return data;
  };
  try {
    const res = await fetch(CONFIG.baseUrl + CONFIG.endpoints.schema, { headers: _headers(apiKey) });
    if (!res.ok) {
      logger.warn('parser', t('xp.schemaFailed', { status: res.status }));
      return keep(hit ? hit.data : null);
    }
    return keep(await res.json());
  } catch (e) {
    logger.warn('parser', t('xp.schemaError', { error: e.message }));
    return keep(hit ? hit.data : null);
  }
}

/**
 * Оставить только те фильтры, которые площадка объявила своими.
 *
 * Любой лишний ключ - это 422 на старте задачи, то есть ни одного объявления за
 * весь прогон. Так вышло со страной: клиент подставлял country всегда, а
 * Poshmark его не принимает - страна у неё одна, и фильтровать по ней нечего.
 * Пока схема не получена, отправляем как есть: выбрасывать условия по догадке
 * хуже, чем попробовать.
 */
function _allowed(schema, platform, filters) {
  const entry = schema && (schema.platforms || []).find((p) => p.platform === platform);
  const supported = entry && entry.supported_filters;
  if (!supported || !supported.length) return filters;
  const out = {};
  const dropped = [];
  for (const [key, value] of Object.entries(filters)) {
    if (supported.includes(key)) out[key] = value; else dropped.push(key);
  }
  if (dropped.length) {
    logger.info('parser', t('xp.filtersSkipped', { platform, filters: dropped.join(', ') }));
  }

  // Страны площадка проверяет по своему списку и на чужой код отвечает отказом.
  // В целях рассылки страна могла остаться от другой площадки - отбрасываем её
  // здесь, а не получаем 422 на весь запрос.
  const known = entry.countries || [];
  const picked = out[CONFIG.countryFilter];
  if (Array.isArray(picked) && known.length) {
    const keep = picked.filter((c) => known.includes(c));
    const lost = picked.filter((c) => !known.includes(c));
    if (lost.length) {
      logger.warn('parser', t('xp.countriesSkipped', { platform, countries: lost.join(', ') }));
    }
    if (keep.length) out[CONFIG.countryFilter] = keep;
    else delete out[CONFIG.countryFilter];
  }
  return out;
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
  // 422 - это всегда фильтры: неизвестный ключ или значение, которого площадка
  // не знает. Общее "не удалось запустить задачу" тут не помогает - человеку
  // надо знать, что править в настройках.
  if (res.status === 422) {
    const keys = Object.keys(filters || {}).join(', ');
    logger.warn('parser', t('xp.filtersRejected', { platform, filters: keys || '-' }));
    return null;
  }
  if (!res.ok) {
    logger.warn('parser', t('xp.startFailed', { status: res.status }));
    return null;
  }
  const data = await res.json();
  return data && data.task_id != null ? data.task_id : null;
}

/** Остановить задачу на стороне API. Ошибку глотаем: убирать за собой - не то,
    из-за чего стоит ронять прогон или проверку. */
async function _stopTask(apiKey, taskId) {
  try {
    const path = CONFIG.endpoints.stop.replace('{task_id}', String(taskId));
    await fetch(CONFIG.baseUrl + path, { method: 'POST', headers: _headers(apiKey) });
    logger.info('parser', t('xp.taskStopped', { taskId }));
  } catch (e) {
    logger.warn('parser', t('xp.stopFailed', { taskId, error: e.message }));
  }
}

/**
 * Остановить все заведённые задачи и забыть их.
 *
 * Зовётся по концу прогона и после проверки фильтров. Задача живёт на стороне
 * API и переживает закрытие приложения, а завести такую же второй раз он не
 * даёт (409) - и возобновить брошенную нельзя, идентификатор отдаётся ровно
 * один раз. Поэтому за собой убираем всегда, иначе следующий запуск получит
 * 409 и ни одного объявления.
 */
async function stopAll(apiKey) {
  for (const [key, task] of Array.from(_tasks)) {
    if (apiKey && !key.startsWith(apiKey + '|')) continue;
    _tasks.delete(key);
    await _stopTask(apiKey || key.split('|')[0], task.taskId);
  }
}

/** Ключ реестра задач: одни и те же условия - одна задача. */
function _key(apiKey, platform, filters) {
  const sign = Object.keys(filters).sort().map((k) => `${k}=${filters[k]}`).join('&');
  return `${apiKey}|${platform}|${sign}`;
}

/** Условия очередного запроса: цель рассылки плюс фильтры, минус то, чего
    площадка не принимает. */
async function _conditions(apiKey, want, countries, extra) {
  const { platform, filters } = _resolve(want, countries);
  // Фильтры из настроек кладём рядом со странами. Страны они перебить не могут:
  // те зарезервированы за разделом "Цели" (см. filters.js).
  Object.assign(filters, extra || {});
  // Схема нужна до запроса: она говорит, какие ключи площадка вообще принимает.
  // Ответ живёт в памяти, поэтому пополнение очереди её не дёргает.
  return { platform, filters: _allowed(await fetchSchema(apiKey), platform, filters) };
}

/**
 * Страница объявлений задачи.
 *
 * @param peek Не двигать курсор - страницу читает проверка, и забирать её у
 *   рассылки нельзя: прогон получил бы уже следующую.
 */
async function _page(apiKey, task, { limit, peek } = {}) {
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
  if (!peek && data && data.next_cursor != null) task.cursor = data.next_cursor;
  const leads = listings.map(normalizeLead).filter((l) => l.email);
  return typeof limit === 'number' ? leads.slice(0, limit) : leads;
}

async function fetchBatch({ apiKey, platform: want, countries, filters: extra, limit }) {
  if (!apiKey) {
    logger.warn('parser', t('xp.noKey'));
    return [];
  }
  try {
    const { platform, filters } = await _conditions(apiKey, want, countries, extra);
    const key = _key(apiKey, platform, filters);
    let task = _tasks.get(key);
    if (!task) {
      const taskId = await _startTask(apiKey, platform, filters);
      if (taskId == null) return [];
      task = { taskId, cursor: null };
      _tasks.set(key, task);
      logger.success('parser', t('xp.taskStarted', { taskId, platform }));
    }
    return await _page(apiKey, task, { limit });
  } catch (e) {
    logger.error('parser', t('xp.error', { error: e.message }));
    return [];
  }
}

/**
 * Разовая проверка условий: завести задачу, дождаться первых объявлений и
 * убрать её за собой.
 *
 * Первая страница приходит пустой - задача только заводится, и площадке нужно
 * несколько секунд. Если задача под эти же условия уже есть, значит идёт
 * рассылка: читаем её страницу, курсор не двигаем и задачу не трогаем.
 */
async function probe({ apiKey, platform: want, countries, filters: extra, limit, attempts = 4, waitMs = 5000 }) {
  if (!apiKey) {
    logger.warn('parser', t('xp.noKey'));
    return [];
  }
  try {
    const { platform, filters } = await _conditions(apiKey, want, countries, extra);
    const running = _tasks.get(_key(apiKey, platform, filters));
    if (running) return await _page(apiKey, running, { limit, peek: true });

    const taskId = await _startTask(apiKey, platform, filters);
    if (taskId == null) return [];
    logger.success('parser', t('xp.taskStarted', { taskId, platform }));
    const task = { taskId, cursor: null };
    try {
      for (let i = 0; i < attempts; i++) {
        const leads = await _page(apiKey, task, { limit, peek: true });
        if (leads.length) return leads;
        await new Promise((r) => setTimeout(r, waitMs));
      }
      return [];
    } finally {
      await _stopTask(apiKey, taskId);
    }
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
    // Страна объявления. Нужна генератору ссылок: serviceCode у Haron Rent
    // собирается как площадка_страна, и ссылка немецкому продавцу должна
    // отличаться от американской. В ответе поле обязательное (схема
    // ParserListing), но подстраховываемся пустой строкой.
    country: String(raw.country || '').toLowerCase(),
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

module.exports = { fetchBatch, probe, stopAll, fetchSchema, normalizeLead, CONFIG };
