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

// ── Перенос стилей в атрибуты ──────────────────────────────────────
// Блок <style> до продавца не доезжает: письмо вставляется в поле Gmail как в
// contenteditable, и весь блок оттуда выбрасывается вместе с оформлением.
// Поэтому правила раскладываются по атрибутам style="..." самих элементов -
// единственный способ оформления, который понимают почтовые клиенты.

/** Теги без закрывающего: в стек вложенности их класть нельзя. */
const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'];

/**
 * Разобрать CSS в плоский список правил.
 *
 * Групповые правила (@media и подобные) выбрасываем целиком: инлайнить их
 * некуда - условие негде хранить, а без него правило применилось бы всегда.
 * Селекторы с псевдоклассами и комбинаторами тоже пропускаем: :hover в письме
 * не работает, а ">" и "+" без настоящего дерева не разобрать честно.
 */
function _parseCss(css) {
  const clean = String(css)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@[a-z-]+[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi, '')
    .replace(/@[a-z-]+[^;{}]*;/gi, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m = re.exec(clean);
  let order = 0;
  while (m) {
    // Переносы и отступы из исходного CSS схлопываем: иначе они уезжают в
    // атрибут style и раздувают письмо на пустом месте.
    const body = m[2].replace(/\s+/g, ' ').trim().replace(/;\s*$/, '');
    if (body) {
      for (const one of m[1].split(',')) {
        const sel = one.trim();
        if (sel && !/[:>+~[*]/.test(sel)) {
          const parts = sel.split(/\s+/).map(_parsePart);
          if (parts.every(Boolean)) out.push({ parts, body, spec: _spec(parts), order: order++ });
        }
      }
    }
    m = re.exec(clean);
  }
  return out;
}

/** Часть селектора: тег, классы и идентификатор. */
function _parsePart(part) {
  if (!/^[a-z0-9]*(?:[.#][\w-]+)*$/i.test(part)) return null;
  const tag = (part.match(/^[a-z0-9]+/i) || [''])[0].toLowerCase();
  const out = { tag, classes: [], id: '' };
  const re = /([.#])([\w-]+)/g;
  let m = re.exec(part);
  while (m) {
    if (m[1] === '.') out.classes.push(m[2]);
    else out.id = m[2];
    m = re.exec(part);
  }
  return (tag || out.classes.length || out.id) ? out : null;
}

/** Вес селектора по обычным правилам CSS: идентификатор, класс, тег. */
function _spec(parts) {
  let n = 0;
  for (const p of parts) n += (p.id ? 100 : 0) + p.classes.length * 10 + (p.tag ? 1 : 0);
  return n;
}

function _matchOne(part, el) {
  if (!el) return false;
  if (part.tag && part.tag !== el.tag) return false;
  if (part.id && part.id !== el.id) return false;
  return part.classes.every((c) => el.classes.indexOf(c) >= 0);
}

/**
 * Селектор подходит текущему элементу? Последняя часть проверяется на нём
 * самом, остальные - на предках в том же порядке, но не обязательно подряд:
 * это обычный вложенный селектор вида ".notice-box strong".
 */
function _matches(parts, stack) {
  let i = parts.length - 1;
  if (!_matchOne(parts[i], stack[stack.length - 1])) return false;
  i--;
  let j = stack.length - 2;
  while (i >= 0 && j >= 0) {
    if (_matchOne(parts[i], stack[j])) i--;
    j--;
  }
  return i < 0;
}

/** Атрибуты тега строкой в объект. Значения бывают в любых кавычках и без них. */
function _attrs(s) {
  const out = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m = re.exec(s || '');
  while (m) {
    out[m[1].toLowerCase()] = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] || ''));
    m = re.exec(s || '');
  }
  return out;
}

/**
 * Разложить правила из <style> по атрибутам style элементов.
 *
 * Свой inline-стиль всегда сильнее: он дописывается последним и перекрывает
 * пришедшее из блока. Правила между собой сортируются по весу селектора, при
 * равном весе побеждает последнее в файле - как в браузере.
 */
function inlineCss(html) {
  const src = String(html == null ? '' : html);
  let css = '';
  src.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, body) => { css += '\n' + body; return ''; });
  const rules = _parseCss(css);
  if (!rules.length) return src;

  const stack = [];
  const token = /<!--[\s\S]*?-->|<\/([a-z][a-z0-9]*)\s*>|<([a-z][a-z0-9]*)\b((?:"[^"]*"|'[^']*'|[^>])*)>/gi;
  let styledBody = false;

  const out = src.replace(token, (raw, closeTag, openTag, attrStr) => {
    if (raw.slice(0, 4) === '<!--') return raw;
    if (closeTag) {
      const tag = closeTag.toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      return raw;
    }
    const tag = String(openTag).toLowerCase();
    const attrs = _attrs(attrStr);
    const el = {
      tag,
      id: attrs.id || '',
      classes: String(attrs.class || '').split(/\s+/).filter(Boolean),
    };
    stack.push(el);

    const hit = rules.filter((r) => _matches(r.parts, stack))
      .sort((a, b) => (a.spec - b.spec) || (a.order - b.order))
      .map((r) => r.body.trim().replace(/;$/, ''));

    const selfClose = /\/\s*$/.test(attrStr || '');
    if (selfClose || VOID_TAGS.indexOf(tag) >= 0) stack.pop();

    if (!hit.length) return raw;
    if (tag === 'body') styledBody = true;
    const own = (attrs.style || '').trim().replace(/;$/, '');
    const merged = hit.concat(own ? [own] : []).join(';');
    const quoted = 'style="' + merged.replace(/"/g, '&quot;') + '"';
    const rest = /\bstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(attrStr)
      ? attrStr.replace(/\bstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, quoted)
      : (attrStr || '').replace(/\s*\/?\s*$/, '') + ' ' + quoted + (selfClose ? ' /' : '');
    return '<' + openTag + rest + '>';
  });

  // Оформление body пропало бы вместе с самим тегом: mailSafe его вырезает.
  // Переносим его на div, иначе письмо теряет базовый шрифт и цвет.
  if (!styledBody) return out;
  return out
    .replace(/<body\b((?:"[^"]*"|'[^']*'|[^>])*)>/i, '<div$1>')
    .replace(/<\/body\s*>/i, '</div>');
}

/**
 * Привести разметку к тому, что реально доедет до продавца.
 *
 * Письмо вставляется в поле Gmail через execCommand('insertHTML'), то есть в
 * contenteditable - в контекст BODY. Всё, что в body жить не может, браузер
 * выбрасывает молча: doctype, html/head/body, meta, link, title и, самое
 * болезненное, STYLE. Шаблон, свёрстанный классами и блоком <style>, после
 * такой вставки теряет всё оформление и уходит голым текстом.
 *
 * Режем это здесь, а не только в превью: тогда превью показывает ровно то, что
 * получит продавец. Оформление в письме задаётся атрибутами style="..." на
 * самих элементах - так свёрстан и встроенный образец.
 */
function mailSafe(html) {
  return String(html == null ? '' : html)
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '')
    .replace(/<(style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:meta|link|base)\b[^>]*>/gi, '')
    .trim();
}

/**
 * Собрать письмо. Возвращает и разметку, и её текстовую проекцию: журнал
 * переписки и лента чата показывают текст, а не сырой HTML.
 */
function render({ template: tpl, contact, url }) {
  const values = texts.placeholderValues(contact, url);
  const withBlocks = _conditionals(tpl || DEFAULT_HTML, values);
  const filled = texts.fillPlaceholders(withBlocks, contact, url, { escape: escapeHtml });
  // Порядок важен: стили разложить надо ДО того, как mailSafe вырежет блок
  // <style> - иначе переносить будет нечего.
  const html = mailSafe(inlineCss(filled));
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

module.exports = {
  DEFAULT_HTML, template, mode, render, build, toText, images, escapeHtml,
  mailSafe, inlineCss,
};
