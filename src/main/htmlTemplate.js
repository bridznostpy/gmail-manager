'use strict';
/**
 * HTML-письмо автоответа.
 *
 * Автоответ умеет два вида: обычный текст из PASTE_DICT (см. texts.js) и один
 * HTML-шаблон из настроек (`autoReply.html`). Шаблон один на все языки: он
 * задаётся руками, а не набором вариантов, поэтому и живёт в настройках, а не в
 * texts.json.
 *
 * Плейсхолдеры те же, что в текстах: {image_url} {link} {title} {price}
 * {seller_username} {date} {ad_url}. Значения берутся из одного места
 * (texts.placeholderValues), иначе набор в тексте и в шаблоне разошёлся бы.
 *
 * Условный блок:
 *
 *   <!--if:image_url--> ... <!--/if-->
 *
 * Плейсхолдер внутри пустой - блок вырезается целиком. Нужен для объявлений без
 * фото: иначе в письме остаётся битая картинка.
 */
const texts = require('./texts');

/** Значение в разметку. Кавычка в названии товара сломала бы атрибут src/href. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Образец шаблона. Вёрстка на таблице и inline-стили: почтовые клиенты внешние
 * стили и flex не поддерживают. Ширина 600 px - обычный предел для письма.
 */
const DEFAULT_HTML = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#202124">
  <p style="margin:0 0 16px">Hi {seller_username}, I placed the order and paid for it.</p>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:600px;border:1px solid #e0e0e0;border-radius:12px">
    <tr>
      <!--if:image_url-->
      <td width="132" valign="top" style="padding:16px 0 16px 16px">
        <img src="{image_url}" width="116" alt="" style="display:block;width:116px;height:auto;border-radius:8px" />
      </td>
      <!--/if-->
      <td valign="top" style="padding:16px">
        <div style="font-size:15px;font-weight:bold;margin:0 0 6px">{title}</div>
        <div style="font-size:14px;color:#5f6368;margin:0 0 16px">{price}</div>
        <a href="{link}" style="display:inline-block;padding:11px 20px;background:#1a73e8;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;border-radius:8px">Confirm the order</a>
      </td>
    </tr>
  </table>

  <p style="margin:16px 0 0;font-size:13px;color:#5f6368">The confirmation link stays active for a few hours.</p>
</div>`;

/** Шаблон из настроек, а при пустом значении - образец. */
function template(store) {
  const cfg = (store && store.get('autoReply')) || {};
  const tpl = String(cfg.html == null ? '' : cfg.html).trim();
  return tpl || DEFAULT_HTML;
}

/** Режим автоответа: обычный текст или HTML. */
function mode(store) {
  const cfg = (store && store.get('autoReply')) || {};
  return cfg.mode === 'html' ? 'html' : 'text';
}

/**
 * Убрать условные блоки. Пустое значение - блок вырезается, непустое -
 * остаются только сами метки. Регулярка нежадная и с флагом s: внутри блока
 * есть переводы строк.
 */
function _conditionals(tpl, values) {
  return String(tpl).replace(
    /<!--\s*if:([a-z_]+)\s*-->([\s\S]*?)<!--\s*\/if\s*-->/gi,
    (_m, key, inner) => (String(values[key] || '').trim() ? inner : ''),
  );
}

/**
 * Собрать письмо. Возвращает и разметку, и её текстовую проекцию: журнал
 * переписки и лента чата показывают текст, а не сырой HTML.
 */
function render({ template: tpl, contact, url }) {
  const values = texts.placeholderValues(contact, url);
  const withBlocks = _conditionals(tpl || DEFAULT_HTML, values);
  const html = texts.fillPlaceholders(withBlocks, contact, url, { escape: escapeHtml });
  return { html, text: toText(html) };
}

/** То же по настройкам приложения. */
function build(store, url, contact) {
  return render({ template: template(store), contact, url });
}

/**
 * Текстовая проекция разметки. Не полноценный разбор HTML - его тут и не нужно:
 * задача показать письмо в ленте чата человеческим текстом. Блочные теги
 * становятся переводами строк, остальные выбрасываются.
 */
function toText(html) {
  return String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line || (i > 0 && arr[i - 1]))
    .join('\n')
    .trim();
}

/**
 * Адреса картинок из разметки - лента чата показывает их миниатюрами. Значение
 * атрибута экранировано (амперсанд в адресе стал &amp;), и обратно его надо
 * раскодировать: адрес пойдёт в src напрямую, а не через разбор HTML.
 */
function images(html) {
  const out = [];
  const unescape = (s) => s
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
  const re = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m = re.exec(String(html || ''));
  while (m) {
    const src = unescape(m[2] != null ? m[2] : (m[3] || ''));
    if (src && out.indexOf(src) < 0) out.push(src);
    m = re.exec(String(html || ''));
  }
  return out;
}

module.exports = { DEFAULT_HTML, template, mode, render, build, toText, images, escapeHtml };
