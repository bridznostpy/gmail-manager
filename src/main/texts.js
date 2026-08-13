'use strict';
/**
 * Выбор текстов рассылки из загруженного JSON.
 *
 * Формат (пример прислан пользователем): три словаря, каждый разбит по языку.
 *   MESSAGES_DICT[lang] - первое письмо ("товар ещё в продаже?"), тема письма
 *                         подставляется отдельно из названия товара парсера.
 *   PASTE_DICT[lang]    - автоответ после ответа продавца, в текст вставляется
 *                         ссылка из API.
 *   CONFIRM_DICT[lang]  - дополнительное письмо-подталкивание по кнопке, тоже со
 *                         ссылкой.
 *
 * В текстах PASTE_DICT и CONFIRM_DICT можно ставить плейсхолдеры по данным
 * товара из контакта рассылки: {seller_username} {title} {price} {image_url}
 * {date} {ad_url} {link} (см. fillPlaceholders).
 *
 * Пока площадка одна (US), язык по умолчанию 'en'. Значение читается из
 * настроек, поэтому добавить второй язык позже можно без правок здесь.
 */

const FALLBACK = {
  MESSAGES_DICT: { en: ['hi, is this still available?'] },
  PASTE_DICT: { en: ['i placed the order and paid, it needs your confirmation to go through.\n\nlink:'] },
  CONFIRM_DICT: { en: ["payment is done. here's the confirmation link"] },
};

function pool(texts, dict, lang) {
  const src = (texts && texts[dict]) || FALLBACK[dict];
  const byLang = (src && (src[lang] || src.en)) || FALLBACK[dict].en;
  return Array.isArray(byLang) && byLang.length ? byLang : FALLBACK[dict].en;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function outreachLang(store) {
  const sys = store.get('system') || {};
  return sys.outreachLang || 'en';
}

/**
 * Значения плейсхолдеров по контакту и ссылке. Одно место правды и для обычного
 * текста, и для HTML-шаблона автоответа (см. htmlTemplate.js): набор полей
 * должен совпадать, иначе плейсхолдер, работающий в тексте, молча не сработает
 * в письме.
 */
function placeholderValues(contact, url) {
  const c = contact || {};
  const raw = parseFloat(String(c.price == null ? '' : c.price).replace(/[^0-9.]/g, ''));
  const price = Number.isFinite(raw) && raw > 0 ? '$' + raw.toFixed(2) : '';
  return {
    seller_username: c.name || '',
    title: c.title || '',
    price,
    image_url: c.imageUrl || '',
    date: c.datePublication || '',
    ad_url: c.listingUrl || '',
    link: String(url == null ? '' : url),
  };
}

/**
 * Подставить в текст данные товара из сохранённого контакта. Набор
 * плейсхолдеров перенесён из расширения: {seller_username} {title} {price}
 * {image_url} {date} {ad_url} {link}. Нет контакта или поля - плейсхолдер
 * становится пустой строкой, письмо всё равно уходит.
 *
 * `escape` нужен HTML-шаблону: там значение попадает в разметку, и кавычка в
 * названии товара сломала бы атрибут.
 */
function fillPlaceholders(text, contact, url, { escape } = {}) {
  const s = String(text == null ? '' : text);
  const values = placeholderValues(contact, url);
  const put = (v) => (escape ? escape(v) : v);
  return Object.keys(values).reduce(
    (acc, key) => acc.split('{' + key + '}').join(put(values[key])),
    s,
  );
}

/** Случайное первое письмо. Тема приходит отдельно (название товара). */
function firstMessage(texts, lang) {
  return String(pick(pool(texts, 'MESSAGES_DICT', lang)));
}

/**
 * Случайный автоответ: данные товара и ссылка на местах плейсхолдеров. Если
 * {link} в тексте нет, ссылку дописывает withLink.
 */
function autoReply(texts, lang, url, contact) {
  return _compose(pick(pool(texts, 'PASTE_DICT', lang)), contact, url);
}

/** Случайное письмо-подталкивание, подстановка та же. */
function nudge(texts, lang, url, contact) {
  return _compose(pick(pool(texts, 'CONFIRM_DICT', lang)), contact, url);
}

/**
 * Подставить данные и ссылку. Проверяем {link} ДО подстановки: после неё
 * плейсхолдера в тексте уже нет, и withLink дописал бы ссылку второй раз.
 */
function _compose(text, contact, url) {
  const hasSlot = /\{link\}/.test(String(text == null ? '' : text));
  const filled = fillPlaceholders(text, contact, url);
  return hasSlot ? filled : withLink(filled, url);
}

/**
 * Вставить ссылку в текст. Если есть {link} - подставляем на место; если текст
 * заканчивается на "link:"/"lien:" - дописываем через пробел; иначе - с новой
 * строки, чтобы ссылка не слиплась с предложением.
 */
function withLink(text, url) {
  const s = String(text == null ? '' : text);
  const link = String(url == null ? '' : url);
  if (/\{link\}/.test(s)) return s.replace(/\{link\}/g, link);
  if (!link) return s;
  if (/(link|lien|enlace|link)\s*:\s*$/i.test(s.trimEnd())) return s.trimEnd() + ' ' + link;
  return s.trimEnd() + '\n\n' + link;
}

// Словари, из которых состоят тексты рассылки. Порядок не важен, важен состав:
// по нему сверяется и то, что прислала нейронка.
const DICTS = ['MESSAGES_DICT', 'PASTE_DICT', 'CONFIRM_DICT'];

// Известные плейсхолдеры. Один список с placeholderValues: выдумав свой
// {seller_name}, модель оставила бы его в письме как есть.
const SLOTS = Object.keys(placeholderValues(null, ''));

/** Есть ли в тексте место под ссылку: явный {link} или хвост "link:". */
function hasLinkSlot(text) {
  const s = String(text == null ? '' : text);
  return /\{link\}/.test(s) || /(link|lien|enlace)\s*:\s*$/i.test(s.trimEnd());
}

/**
 * Проверить набор текстов ОДНОГО языка против эталона.
 *
 * Нужна для обновления текстов нейронкой: доверять её выдаче нельзя, а
 * подсунутый в рассылку кривой набор виден только по ушедшим письмам, когда
 * уже поздно. Возвращает { ok, reason }: reason - ключ строки для лога.
 *
 * Что требуем:
 *  - три словаря на месте, у каждого нужный язык, массив непустых строк;
 *  - число вариантов совпадает с эталонным - иначе разнообразие писем молча
 *    схлопнулось бы до одного текста;
 *  - встречаются только известные плейсхолдеры;
 *  - где в эталоне было место под ссылку, оно есть и в новом тексте: без него
 *    автоответ уйдёт без ссылки, то есть впустую;
 *  - без разметки и без выросшей втрое длины (модель любит "улучшить" письмо
 *    до простыни).
 */
function validate(json, reference, lang) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'ai.errRoot' };
  for (const dict of DICTS) {
    const ref = (reference && reference[dict] && reference[dict][lang]) || null;
    if (!Array.isArray(ref) || !ref.length) continue; // в эталоне пусто - проверять нечего
    const arr = json[dict] && json[dict][lang];
    if (!Array.isArray(arr)) return { ok: false, reason: 'ai.errDict', dict };
    if (arr.length !== ref.length) return { ok: false, reason: 'ai.errCount', dict };
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (typeof s !== 'string' || !s.trim()) return { ok: false, reason: 'ai.errEmpty', dict };
      if (/<[a-z/][^>]*>/i.test(s)) return { ok: false, reason: 'ai.errHtml', dict };
      if (s.length > ref[i].length * 3 + 200) return { ok: false, reason: 'ai.errLong', dict };
      const unknown = (s.match(/\{(\w+)\}/g) || [])
        .map((m) => m.slice(1, -1))
        .find((name) => !SLOTS.includes(name));
      if (unknown) return { ok: false, reason: 'ai.errSlot', dict };
      if (dict !== 'MESSAGES_DICT' && hasLinkSlot(ref[i]) && !hasLinkSlot(s)) {
        return { ok: false, reason: 'ai.errNoLink', dict };
      }
    }
  }
  return { ok: true };
}

module.exports = {
  firstMessage, autoReply, nudge, withLink, fillPlaceholders, placeholderValues, outreachLang,
  validate, hasLinkSlot, DICTS, SLOTS,
};
