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
 * Подставить в текст данные товара из сохранённого контакта. Набор
 * плейсхолдеров перенесён из расширения: {seller_username} {title} {price}
 * {image_url} {date} {ad_url} {link}. Нет контакта или поля - плейсхолдер
 * становится пустой строкой, письмо всё равно уходит.
 */
function fillPlaceholders(text, contact, url) {
  const s = String(text == null ? '' : text);
  const c = contact || {};
  const raw = parseFloat(String(c.price == null ? '' : c.price).replace(/[^0-9.]/g, ''));
  const price = Number.isFinite(raw) && raw > 0 ? '$' + raw.toFixed(2) : '';
  return s
    .replace(/\{seller_username\}/g, c.name || '')
    .replace(/\{title\}/g, c.title || '')
    .replace(/\{price\}/g, price)
    .replace(/\{image_url\}/g, c.imageUrl || '')
    .replace(/\{date\}/g, c.datePublication || '')
    .replace(/\{ad_url\}/g, c.listingUrl || '')
    .replace(/\{link\}/g, String(url == null ? '' : url));
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

module.exports = { firstMessage, autoReply, nudge, withLink, fillPlaceholders, outreachLang };
