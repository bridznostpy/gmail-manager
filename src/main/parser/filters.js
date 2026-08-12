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
 *   задачи. Полный список ключей отдаёт GET /api/v1/parser/schema: поле
 *   filter_columns - все возможные, supported_filters площадки - её
 *   собственные. Имена там во множественном числе (countries, categories), а
 *   границы стоят суффиксами (price_min, price_max), - пример из описания
 *   /start с ключами country и min_price устарел, и запрос по нему получает
 *   422. Значения типизированы жёстко: неверный тип отдаёт 500, а не
 *   объяснение, поэтому типы ниже проверены запросами.
 *
 * Каталог лежит здесь, а не в CONFIG клиентов, чтобы приведение значений было
 * одно на оба API: клиенты читают этот модуль, обратной зависимости нет.
 *
 * Типы полей:
 *   text   - строка;
 *   number - число (у XProject именно число, строка роняет запрос);
 *   bool   - троичный: пусто означает "не важно", и это не то же самое, что
 *            "нет" - "только без телефона" и "телефон не важен" дают разную
 *            выдачу;
 *   enum   - одно значение из списка;
 *   multi  - несколько значений из списка, уходят массивом;
 *   list   - свой список через запятую, уходит массивом;
 *   range  - две границы, "от" и "до". У XProject это два отдельных ключа
 *            (pair), у VVS - одна строка через оператор "..".
 */

/**
 * Насколько свежим должно быть объявление или регистрация продавца. Формат
 * относительного времени у XProject: список назван в ответе на неверное
 * значение ("Expected formats: 'fresh', '5min', ...").
 */
const XP_PERIODS = ['fresh', '5min', '3h', '7d', '2w', '6m', '1y'];

/**
 * Ключи, которыми меню фильтров не распоряжается: у них уже есть своё место в
 * настройках, и второе поле для того же значения означало бы два разных ответа
 * на один вопрос.
 */
const RESERVED = {
  // Страны выбирают в разделе "Цели" - клиент отправляет их списком.
  xproject: ['countries'],
  // limit - это размер пачки из раздела "Парсер"; email клиент всегда просит
  // сам, иначе в выдачу пойдут объявления без адреса, а писать по ним некуда.
  vvs: ['country', 'limit', 'email'],
};

const CATALOG = {
  // Набор ключей - filter_columns из /parser/schema; какие из них принимает
  // конкретная площадка, говорит supported_filters, и лишние fields() убирает.
  xproject: [
    // Значения категорий свои у каждой площадки и приходят из схемы.
    { key: 'categories', type: 'multi', options: [], group: 'item' },
    { key: 'price', type: 'range', unit: 'number', pair: { from: 'price_min', to: 'price_max' }, group: 'item' },
    { key: 'delivery', type: 'bool', group: 'item' },

    { key: 'created_at_period', type: 'enum', options: XP_PERIODS, group: 'listing' },
    { key: 'stop_words', type: 'list', sample: 'nike, adidas', group: 'listing' },
    { key: 'internal_view_count', type: 'number', group: 'listing', note: true },
    // Это не отбор объявлений, а предел на задачу: набрав столько, она
    // закрывается. Поэтому стоит отдельным разделом - рядом с условиями отбора
    // он читался бы как "объявлений у продавца" и вводил в заблуждение.
    { key: 'internal_listing_count', type: 'number', group: 'task', note: true },

    { key: 'seller_email', type: 'bool', group: 'seller' },
    { key: 'seller_has_reviews', type: 'bool', group: 'seller' },
    { key: 'seller_online', type: 'bool', group: 'seller' },
    { key: 'seller_created_at_period', type: 'enum', options: XP_PERIODS, group: 'seller' },
    {
      key: 'seller_created_at',
      type: 'range',
      unit: 'date',
      pair: { from: 'seller_created_at_min', to: 'seller_created_at_max' },
      group: 'seller',
    },
    {
      key: 'seller_review_count',
      type: 'range',
      unit: 'number',
      pair: { from: 'seller_review_count_min', to: 'seller_review_count_max' },
      group: 'seller',
    },
    {
      key: 'seller_sell_count',
      type: 'range',
      unit: 'number',
      pair: { from: 'seller_sell_count_min', to: 'seller_sell_count_max' },
      group: 'seller',
    },
    {
      key: 'seller_listing_count',
      type: 'range',
      unit: 'number',
      pair: { from: 'seller_listing_count_min', to: 'seller_listing_count_max' },
      group: 'seller',
    },
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
const GROUPS = ['item', 'listing', 'seller', 'task', 'other'];

/**
 * Тип незнакомого фильтра из живой схемы. Схема отдаёт только имена, поэтому
 * судим по имени: это лучше, чем показать число текстовым полем и получить 422.
 */
function guessType(key) {
  return /price|count|views|min|max|amount|age/i.test(String(key)) ? 'number' : 'text';
}

/**
 * Раздел для ключа, которого нет в каталоге. Всё про продавца площадка
 * называет с одной приставки - этого хватает, чтобы незнакомое условие не
 * свалилось в "прочее" рядом с условиями о товаре.
 */
function guessGroup(key) {
  return /^seller/.test(String(key)) ? 'seller' : 'other';
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
  if (!supported.length) return byGroup(list);

  // Ключи, из которых собрано условие: у границ их два.
  const covers = (f) => (f.pair ? [f.pair.from, f.pair.to] : [f.key]);
  const out = [];
  const used = new Set();

  for (const f of list) {
    const keys = covers(f).filter((k) => supported.includes(k));
    if (!keys.length) continue;
    keys.forEach((k) => used.add(k));
    // Площадка может принимать только одну границу условия. Показывать вторым
    // полем то, чего она не примет, нельзя - вырождаем в обычное число.
    if (f.pair && keys.length === 1) {
      out.push({ key: keys[0], type: f.unit === 'number' ? 'number' : 'text', group: f.group });
      continue;
    }
    out.push(f);
  }

  // Значения категорий свои у каждой площадки и живут только в схеме.
  const categories = out.find((f) => f.key === 'categories');
  if (categories) categories.options = (schema.categories || []).slice();

  // Ключи, которых нет в каталоге. Площадка вправе объявить свои, и молчать о
  // них нельзя: человек всё равно захочет ими воспользоваться.
  for (const key of supported) {
    if (used.has(key) || reserved.includes(key)) continue;
    used.add(key);
    // Границы приходят суффиксами _min и _max. Двумя полями это спрашивало бы
    // одно и то же дважды, поэтому сводим их в одно условие; в запрос они
    // уходят обратно теми же двумя ключами.
    const bound = /^(.+)_min$/.exec(key);
    const twin = bound && bound[1] + '_max';
    if (bound && supported.includes(twin)) {
      used.add(twin);
      out.push({
        key: bound[1],
        type: 'range',
        unit: guessType(bound[1]) === 'number' ? 'number' : 'date',
        pair: { from: key, to: twin },
        group: guessGroup(bound[1]),
        fromSchema: true,
      });
      continue;
    }
    out.push({ key, type: guessType(key), group: guessGroup(key), fromSchema: true });
  }
  return byGroup(out);
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
  // Границы у XProject лежат в настройках своими ключами (price_min и т.д.), а
  // в каталоге стоят одним условием. Регистрируем и стороны тоже, иначе тип
  // пришлось бы угадывать по имени - а неверный тип там роняет запрос.
  const byKey = new Map();
  for (const f of fields(apiType, platform, null)) {
    byKey.set(f.key, f);
    if (!f.pair) continue;
    const side = { type: f.unit === 'number' ? 'number' : 'text' };
    byKey.set(f.pair.from, side);
    byKey.set(f.pair.to, side);
  }

  const reserved = RESERVED[apiType] || [];
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (reserved.includes(key)) continue;
    const v = typeof value === 'string' ? value.trim() : value;
    if (v === '' || v == null) continue;
    const field = byKey.get(key);
    const type = field ? field.type : guessType(key);
    if (type === 'range') {
      // Сюда попадают только диапазоны одной строкой (VVS). Строку принимаем
      // как есть: так лежали значения, заданные до появления двух полей.
      const s = typeof v === 'string' ? v : composeRange(field, v);
      if (s) out[key] = s;
    } else if (type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    } else if (type === 'bool') {
      out[key] = v === true || v === 'true';
    } else if (type === 'multi' || type === 'list') {
      // Списки уходят массивом. Хранятся строкой через запятую - так их вводят
      // и так их проще держать в настройках.
      const items = (Array.isArray(v) ? v : String(v).split(','))
        .map((x) => String(x).trim()).filter(Boolean);
      if (items.length) out[key] = items;
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
