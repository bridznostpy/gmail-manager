'use strict';
/**
 * Почта профиля как единица работы.
 *
 * В одном профиле Chrome можно быть авторизованным сразу в нескольких аккаунтах
 * Google (мультилогин). Вкладки таких аккаунтов различаются индексом в адресе:
 * /mail/u/0/, /mail/u/1/ и так далее. Индекс принадлежит браузеру, а не
 * аккаунту: он зависит от порядка входа и после перелогина может смениться.
 * Поэтому опознаём почту по АДРЕСУ, а индекс держим лишь как запасной путь и
 * как способ открыть нужный инбокс.
 *
 * Ключ почты = профиль плюс адрес. На нём держатся счётчики писем, учёт
 * переписок автоответчика и журнал сообщений: один и тот же тред у разных почт
 * одного профиля - разные диалоги.
 */

const DOTLESS_DOMAINS = ['gmail.com', 'googlemail.com'];

/**
 * Привести адрес к одному виду. Gmail игнорирует точки в локальной части, то
 * есть "ky.burnside@gmail.com" и "kyburnside@gmail.com" - один и тот же ящик;
 * парсер и список писем Gmail могут отдать разные написания. В остальных
 * доменах точка значима, поэтому там её не трогаем.
 */
function normalizeEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  const at = lower.indexOf('@');
  if (at < 0) return lower;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (DOTLESS_DOMAINS.indexOf(domain) < 0) return lower;
  return local.replace(/\./g, '') + '@' + domain;
}

/** Ключ "профиль + почта" для всех журналов. */
function accountKey(profileId, email) {
  return String(profileId || '') + '#' + normalizeEmail(email);
}

/** Индекс аккаунта из адреса вкладки Gmail. Нет индекса - считаем нулевым. */
function userIndexFromUrl(url) {
  const m = /\/mail\/u\/(\d+)\//.exec(String(url || ''));
  return m ? Number(m[1]) : 0;
}

/** Адрес инбокса конкретной почты. */
function inboxUrl(userIndex) {
  const n = Number.isFinite(Number(userIndex)) ? Math.max(0, Number(userIndex)) : 0;
  return 'https://mail.google.com/mail/u/' + n + '/#inbox';
}

/** Вкладка ведёт на почту этого аккаунта? */
function sameMailbox(url, userIndex) {
  return /^https:\/\/mail\.google\.com\/mail\//.test(String(url || ''))
    && userIndexFromUrl(url) === (Number(userIndex) || 0);
}

/** Как называть почту в логах и в интерфейсе. */
function label(mailbox) {
  const m = mailbox || {};
  return m.email || ('u/' + (Number(m.userIndex) || 0));
}

module.exports = {
  normalizeEmail, accountKey, userIndexFromUrl, inboxUrl, sameMailbox, label,
};
