'use strict';
/**
 * Каталог фильтров парсинга - что вообще можно сузить перед сбором лидов.
 *
 * Контракты внешние, поэтому поля взяты из документации, а не из наблюдений за
 * ответами (Rules 4):
 *
 * - VVS (https://telegra.ph/Dokumentaciya-API-03-18) - query-параметры к
 *   GET /ads/{platform}. Универсальные перечислены в разделе параметров,
 *   domain там же назван параметром Vinted.
 * - XProject (OpenAPI, POST /api/v1/parser/start) - объект `filters` в теле
 *   задачи. Документация называет напрямую только `category`, `country` и
 *   `min_price` (пример к /start), а полный список для площадки отдаёт
 *   GET /api/v1/parser/schema. Живую схему подмешиваем в fields(), когда она
 *   получена; без неё остаётся документированный минимум.
 *
 * Каталог лежит здесь, а не в CONFIG клиентов, чтобы приведение значений было
 * одно на оба API: клиенты читают этот модуль, обратной зависимости нет.
 *
 * Типы полей: text | number | bool | enum. `bool` троичный - пусто означает
 * "не важно", и это не то же самое, что false: "только без телефона" и "телефон
 * не важен" дают разную выдачу.
 */

/**
 * Ключи, которыми меню фильтров не распоряжается: у них уже есть своё место в
 * настройках, и второе поле для того же значения означало бы два разных ответа
 * на один вопрос.
 */
const RESERVED = {
  // Страну выбирают в разделе "Цели" - клиенты обходят список по очереди.
  xproject: ['country'],
  // limit - это размер пачки из раздела "Парсер"; email клиент всегда просит
  // сам, иначе в выдачу пойдут объявления без адреса, а писать по ним некуда.
  vvs: ['country', 'limit', 'email'],
};

const CATALOG = {
  xproject: [
    // Список значений приходит из живой схемы (categories площадки).
    { key: 'category', type: 'enum', options: [] },
    { key: 'min_price', type: 'number' },
  ],

  vvs: [
    { key: 'category', type: 'text' },
    // Цена у VVS одной строкой: "100" (до), "10..100" (диапазон), "10.." (от).
    { key: 'price', type: 'text', sample: '100  |  10..100  |  10..' },
    { key: 'delivery', type: 'bool' },
    { key: 'phone', type: 'bool' },
    { key: 'publication', type: 'enum', options: ['5m', '15m', '30m', '24h'] },
    { key: 'registration', type: 'text', sample: '01-01-2020..01-01-2023' },
    { key: 'blacklist', type: 'text', sample: 'nike, adidas' },
    { key: 'views', type: 'number' },
    { key: 'domain', type: 'text', platforms: ['vinted'] },
    // TODO(docs): ads, reviews, sells, buys документация называет
    // платформо-специфичными, но не говорит, какие площадки их принимают.
    // Появится список - строки добавляются сюда, остальное менять не нужно.
  ],
};

/**
 * Тип незнакомого фильтра из живой схемы. Схема отдаёт только имена, поэтому
 * судим по имени: это лучше, чем показать число текстовым полем и получить 422.
 */
function guessType(key) {
  return /price|count|views|min|max|amount|age/i.test(String(key)) ? 'number' : 'text';
}

/**
 * Поля для пары "тип API + площадка".
 *
 * `live` - ответ GET /parser/schema, если он получен. Схема главнее каталога:
 * она знает, какие ключи площадка принимает на самом деле, поэтому лишние из
 * документированного минимума убираем, а её собственные добавляем.
 */
function fields(apiType, platform, live) {
  let list = (CATALOG[apiType] || [])
    .filter((f) => !f.platforms || f.platforms.includes(platform))
    .map((f) => ({ ...f }));

  const schema = live && (live.platforms || []).find((p) => p.platform === platform);
  if (!schema) return list;

  const supported = schema.supported_filters || [];
  const reserved = RESERVED[apiType] || [];
  if (supported.length) list = list.filter((f) => supported.includes(f.key));

  // Категории площадки перечислены только в схеме - в документации их нет.
  const category = list.find((f) => f.key === 'category');
  if (category && (schema.categories || []).length) {
    category.options = schema.categories.slice();
  }

  const seen = new Set(list.map((f) => f.key));
  for (const key of supported) {
    if (seen.has(key) || reserved.includes(key)) continue;
    // fromSchema помечает поле, о котором документация молчит: интерфейс
    // показывает его отдельно, чтобы было видно, откуда оно взялось.
    list.push({ key, type: guessType(key), fromSchema: true });
  }
  return list;
}

/**
 * Привести значения из настроек к тому, что ждёт API.
 *
 * Настройки хранят всё строками - так их вводят в поля. Пустое значение
 * означает "фильтр не задан" и в запрос не идёт: у обоих API пустой ключ
 * означал бы фильтр по пустому значению, а не его отсутствие.
 */
function prepare(apiType, platform, raw) {
  const byKey = new Map(fields(apiType, platform, null).map((f) => [f.key, f]));
  const reserved = RESERVED[apiType] || [];
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (reserved.includes(key)) continue;
    const v = typeof value === 'string' ? value.trim() : value;
    if (v === '' || v == null) continue;
    const field = byKey.get(key);
    const type = field ? field.type : guessType(key);
    if (type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    } else if (type === 'bool') {
      out[key] = v === true || v === 'true';
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

/**
 * Фильтры для очередного запроса по текущим настройкам.
 *
 * В настройках они лежат деревом filters[типAPI][площадка]: у XProject фильтр
 * цены называется min_price и он число, у VVS - price и это строка вида
 * "10..100", а категория Depop ничего не значит для Vinted. Общая куча
 * гарантировала бы 422 при первой же смене площадки.
 */
function forRun(parser) {
  const p = parser || {};
  const apiType = p.apiType || 'xproject';
  const platform = p.platform || '';
  const raw = ((p.filters || {})[apiType] || {})[platform] || {};
  return prepare(apiType, platform, raw);
}

module.exports = { CATALOG, RESERVED, fields, prepare, forRun };
