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
 * Типы полей: text | number | bool | enum | range. `bool` троичный - пусто
 * означает "не важно", и это не то же самое, что false: "только без телефона" и
 * "телефон не важен" дают разную выдачу. `range` - две границы, "от" и "до":
 * в запрос они уходят одной строкой через оператор "..", но вводить их одним
 * полем человек не должен - это два разных числа.
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
    { key: 'category', type: 'enum', options: [], group: 'item' },
    { key: 'min_price', type: 'number', group: 'item' },
  ],

  vvs: [
    { key: 'category', type: 'text', group: 'item' },
    // Цена: документация показывает "10..100" (промежуток), "10.." (от) и
    // голое "100" (до). Поэтому одна верхняя граница пишется без оператора.
    { key: 'price', type: 'range', unit: 'number', soloMax: 'bare', group: 'item' },
    { key: 'delivery', type: 'bool', group: 'item' },
    { key: 'domain', type: 'text', platforms: ['vinted'], group: 'item' },

    { key: 'publication', type: 'enum', options: ['5m', '15m', '30m', '24h'], group: 'listing' },
    { key: 'views', type: 'number', group: 'listing' },
    { key: 'blacklist', type: 'text', sample: 'nike, adidas', group: 'listing' },

    { key: 'phone', type: 'bool', group: 'seller' },
    { key: 'registration', type: 'range', unit: 'date', sample: '01-01-2020', group: 'seller' },
    // Счётчики продавца. Документация называет их платформо-специфичными и не
    // говорит, какие площадки их принимают, - площадка вправе такой параметр
    // не понять. Форма "от..до" здесь по указанию владельца ключа: перечень
    // форматов документация даёт только для цены и даты регистрации.
    { key: 'ads', type: 'range', unit: 'number', group: 'seller' },
    { key: 'reviews', type: 'range', unit: 'number', group: 'seller' },
    { key: 'sells', type: 'range', unit: 'number', group: 'seller' },
    { key: 'buys', type: 'range', unit: 'number', group: 'seller' },
  ],
};

/**
 * Порядок разделов на экране: сначала товар, потом само объявление, потом
 * продавец. Условий больше десятка, и сплошной сеткой они не читаются.
 * "other" - для полей из справочника площадки, о которых документация молчит.
 */
const GROUPS = ['item', 'listing', 'seller', 'other'];

/**
 * Тип незнакомого фильтра из живой схемы. Схема отдаёт только имена, поэтому
 * судим по имени: это лучше, чем показать число текстовым полем и получить 422.
 */
function guessType(key) {
  return /price|count|views|min|max|amount|age/i.test(String(key)) ? 'number' : 'text';
}

/**
 * Разложить поля по разделам в порядке GROUPS. Сортировка устойчивая, поэтому
 * внутри раздела остаётся порядок каталога - он осмысленный, а не алфавитный.
 */
function byGroup(list) {
  const at = (f) => {
    const i = GROUPS.indexOf(f.group || 'other');
    return i === -1 ? GROUPS.length : i;
  };
  return list.sort((a, b) => at(a) - at(b));
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
  if (!schema) return byGroup(list);

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
    list.push({ key, type: guessType(key), group: 'other', fromSchema: true });
  }
  return byGroup(list);
}

/**
 * Диапазон одной строкой.
 *
 * Оператор ".." документирован: "10..100" - промежуток, "10.." - от. Одна
 * верхняя граница пишется по-разному, поэтому её форму указывает само поле:
 * у цены документация показывает голое "100" (до), в остальных случаях
 * оставляем оператор - он читается однозначно и не путается с точным значением.
 */
function composeRange(field, value) {
  const side = (k) => String(value && value[k] != null ? value[k] : '').trim();
  const from = side('from');
  const to = side('to');
  if (from && to) return `${from}..${to}`;
  if (from) return `${from}..`;
  if (to) return field && field.soloMax === 'bare' ? to : `..${to}`;
  return '';
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
    if (type === 'range') {
      // Границы хранятся парой { from, to }. Строку тоже принимаем: так лежали
      // диапазоны, заданные до появления двух полей, и терять их незачем.
      const s = typeof v === 'string' ? v : composeRange(field, v);
      if (s) out[key] = s;
    } else if (type === 'number') {
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

module.exports = { CATALOG, RESERVED, GROUPS, fields, prepare, forRun };
