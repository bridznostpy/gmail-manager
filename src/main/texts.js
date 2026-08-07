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

/** Случайное первое письмо. Тема приходит отдельно (название товара). */
function firstMessage(texts, lang) {
  return String(pick(pool(texts, 'MESSAGES_DICT', lang)));
}

/** Случайный автоответ со вставленной ссылкой. */
function autoReply(texts, lang, url) {
  return withLink(pick(pool(texts, 'PASTE_DICT', lang)), url);
}

/** Случайное письмо-подталкивание со вставленной ссылкой. */
function nudge(texts, lang, url) {
  return withLink(pick(pool(texts, 'CONFIRM_DICT', lang)), url);
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

module.exports = { firstMessage, autoReply, nudge, withLink, outreachLang };
