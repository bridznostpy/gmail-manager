/* Флаги стран рассылки. Инлайновым SVG, без файлов и без эмодзи.

   Эмодзи-флаг не годится: Windows не рисует regional indicator, и вместо
   флага в списке оказывались бы две буквы. Отдельными файлами тоже не годится:
   каждая иконка была бы ещё одним запросом и ещё одним способом молча
   исчезнуть, если файл не положили.

   Рисунок упрощён до узнаваемого: полосы, кресты, кантон. Гербы и звёздные
   россыпи в поле шириной 22 px всё равно превращаются в грязь, а флаг здесь
   отвечает на один вопрос - какая это страна.

   viewBox один на все: 24x16 - это обычные для флагов 3:2, и рядом стоящие
   чипы не разъезжаются по высоте. */
window.FLAGS = {
  // Полосы США считаем от тринадцати: 16/13 даёт 1.23 на полосу.
  us: '<rect width="24" height="16" fill="#fff"/>'
    + '<g fill="#b22234"><rect y="0" width="24" height="1.23"/><rect y="2.46" width="24" height="1.23"/>'
    + '<rect y="4.92" width="24" height="1.23"/><rect y="7.38" width="24" height="1.23"/>'
    + '<rect y="9.85" width="24" height="1.23"/><rect y="12.31" width="24" height="1.23"/>'
    + '<rect y="14.77" width="24" height="1.23"/></g>'
    + '<rect width="10" height="8.6" fill="#3c3b6e"/>'
    + '<g fill="#fff"><circle cx="2" cy="1.8" r="0.5"/><circle cx="5" cy="1.8" r="0.5"/><circle cx="8" cy="1.8" r="0.5"/>'
    + '<circle cx="3.5" cy="4.3" r="0.5"/><circle cx="6.5" cy="4.3" r="0.5"/>'
    + '<circle cx="2" cy="6.8" r="0.5"/><circle cx="5" cy="6.8" r="0.5"/><circle cx="8" cy="6.8" r="0.5"/></g>',

  gb: '<rect width="24" height="16" fill="#012169"/>'
    + '<path d="M0 0l24 16M24 0L0 16" stroke="#fff" stroke-width="3.2"/>'
    + '<path d="M0 0l24 16M24 0L0 16" stroke="#c8102e" stroke-width="1.8"/>'
    + '<path d="M12 0v16M0 8h24" stroke="#fff" stroke-width="5.2"/>'
    + '<path d="M12 0v16M0 8h24" stroke="#c8102e" stroke-width="3"/>',

  au: '<rect width="24" height="16" fill="#00247d"/>'
    + '<rect width="12" height="8" fill="#00247d"/>'
    + '<path d="M0 0l12 8M12 0L0 8" stroke="#fff" stroke-width="1.7"/>'
    + '<path d="M0 0l12 8M12 0L0 8" stroke="#c8102e" stroke-width="0.9"/>'
    + '<path d="M6 0v8M0 4h12" stroke="#fff" stroke-width="2.6"/>'
    + '<path d="M6 0v8M0 4h12" stroke="#c8102e" stroke-width="1.5"/>'
    + '<g fill="#fff"><circle cx="6" cy="12.4" r="1.1"/><circle cx="17.5" cy="3.4" r="0.7"/>'
    + '<circle cx="20.6" cy="6.6" r="0.7"/><circle cx="17.5" cy="10.4" r="0.7"/>'
    + '<circle cx="14.6" cy="6.6" r="0.6"/><circle cx="19.4" cy="12.6" r="0.5"/></g>',

  at: '<rect width="24" height="16" fill="#fff"/>'
    + '<rect width="24" height="5.33" fill="#ed2939"/><rect y="10.67" width="24" height="5.33" fill="#ed2939"/>',

  be: '<rect width="8" height="16" fill="#101010"/><rect x="8" width="8" height="16" fill="#fae042"/>'
    + '<rect x="16" width="8" height="16" fill="#ed2939"/>',

  cz: '<rect width="24" height="8" fill="#fff"/><rect y="8" width="24" height="8" fill="#d7141a"/>'
    + '<path d="M0 0l11 8-11 8z" fill="#11457e"/>',

  de: '<rect width="24" height="5.33" fill="#101010"/><rect y="5.33" width="24" height="5.34" fill="#dd0000"/>'
    + '<rect y="10.67" width="24" height="5.33" fill="#ffce00"/>',

  dk: '<rect width="24" height="16" fill="#c8102e"/>'
    + '<rect x="7" width="3" height="16" fill="#fff"/><rect y="6.5" width="24" height="3" fill="#fff"/>',

  es: '<rect width="24" height="16" fill="#aa151b"/><rect y="4" width="24" height="8" fill="#f1bf00"/>',

  fr: '<rect width="8" height="16" fill="#002395"/><rect x="8" width="8" height="16" fill="#fff"/>'
    + '<rect x="16" width="8" height="16" fill="#ed2939"/>',

  // Девять полос Греции: 16/9 даёт 1.78 на полосу.
  gr: '<rect width="24" height="16" fill="#fff"/>'
    + '<g fill="#0d5eaf"><rect y="0" width="24" height="1.78"/><rect y="3.56" width="24" height="1.78"/>'
    + '<rect y="7.11" width="24" height="1.78"/><rect y="10.67" width="24" height="1.78"/>'
    + '<rect y="14.22" width="24" height="1.78"/></g>'
    + '<rect width="8.9" height="8.9" fill="#0d5eaf"/>'
    + '<path d="M3.6 0h1.7v8.9H3.6z" fill="#fff"/><path d="M0 3.6h8.9v1.7H0z" fill="#fff"/>',

  it: '<rect width="8" height="16" fill="#008c45"/><rect x="8" width="8" height="16" fill="#f4f5f0"/>'
    + '<rect x="16" width="8" height="16" fill="#cd212a"/>',

  lt: '<rect width="24" height="5.33" fill="#fdb913"/><rect y="5.33" width="24" height="5.34" fill="#006a44"/>'
    + '<rect y="10.67" width="24" height="5.33" fill="#c1272d"/>',

  nl: '<rect width="24" height="5.33" fill="#ae1c28"/><rect y="5.33" width="24" height="5.34" fill="#fff"/>'
    + '<rect y="10.67" width="24" height="5.33" fill="#21468b"/>',

  pl: '<rect width="24" height="8" fill="#fff"/><rect y="8" width="24" height="8" fill="#dc143c"/>',

  pt: '<rect width="24" height="16" fill="#da291c"/><rect width="9.6" height="16" fill="#046a38"/>'
    + '<circle cx="9.6" cy="8" r="3.2" fill="#ffe000"/><circle cx="9.6" cy="8" r="2" fill="#fff"/>'
    + '<circle cx="9.6" cy="8" r="1.1" fill="#046a38"/>',

  ro: '<rect width="8" height="16" fill="#002b7f"/><rect x="8" width="8" height="16" fill="#fcd116"/>'
    + '<rect x="16" width="8" height="16" fill="#ce1126"/>',

  se: '<rect width="24" height="16" fill="#006aa7"/>'
    + '<rect x="7" width="3" height="16" fill="#fecc00"/><rect y="6.5" width="24" height="3" fill="#fecc00"/>',
};

/**
 * Разметка флага по коду страны.
 *
 * Неизвестный код не проглатываем: вместо пустоты показываем буквы кода в
 * такой же рамке. Так новая страна в списке площадок видна сразу, а не
 * оборачивается дыркой в ряду чипов.
 */
window.flagHtml = function flagHtml(code) {
  const cc = String(code == null ? '' : code).trim().toLowerCase();
  const inner = window.FLAGS[cc];
  if (!inner) {
    // В подпись пускаем только буквы: код приходит из настроек, а строка
    // уходит в innerHTML.
    const safe = cc.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase();
    return '<span class="flag flag-unknown">' + safe + '</span>';
  }
  return '<svg class="flag" viewBox="0 0 24 16" aria-hidden="true" focusable="false">' + inner + '</svg>';
};
