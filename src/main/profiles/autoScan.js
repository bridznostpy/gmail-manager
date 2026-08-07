'use strict';
/**
 * Фоновый скан статуса Gmail у запущенных профилей.
 *
 * Пользователь логинится в Gmail руками (Rules 6), и никакого события об этом
 * приложение не получает. Ловим момент двумя путями:
 *
 * 1. События браузера - вкладка сменила адрес или заголовок. Это и есть вход в
 *    почту со стороны Chrome, статус обновляется через секунду после загрузки.
 * 2. Таймер раз в `system.autoScanSec` секунд - страховка на случай, если
 *    событие потерялось.
 *
 * Рендер подхватывает данные своим опросом `profiles:list`, отдельный канал IPC
 * не нужен.
 */
const logger = require('../logger');
const { t } = require('../i18n');

// Заголовок вкладки Gmail устаканивается не мгновенно после смены адреса,
// поэтому событию даём чуть отлежаться.
const ACTIVITY_DEBOUNCE_MS = 1200;

let timer = null;
let ticking = false;
let unwatch = null;
const pendingByProfile = new Map(); // profileId -> таймер отложенного скана
const queueByProfile = new Map(); // profileId -> хвост очереди сканов

/**
 * Просканировать профиль и сохранить результат. Единая точка для кнопки в UI,
 * таймера и событий вкладок. Сканы одного профиля выстраиваются в очередь:
 * параллельные проходы перевешивали бы `pageCdp` наперегонки.
 */
function scanAndPersist(ctx, id, opts) {
  const prev = queueByProfile.get(id) || Promise.resolve();
  const next = prev.then(() => runScan(ctx, id, opts), () => runScan(ctx, id, opts));
  queueByProfile.set(id, next.then(() => {}, () => {}));
  return next;
}

/** Пишет в лог, только если статус или почта изменились. */
async function runScan(ctx, id, { quiet = false } = {}) {
  const { chrome, profileStore } = ctx;
  const before = profileStore.get(id);
  if (!before) throw new Error(t('err.profileNotFound'));
  // Снимок значений, а не ссылка: profileStore.get отдаёт живой объект, который
  // update мутирует на месте - сравнивать с ним после скана бессмысленно.
  const prevStatus = before.gmailStatus;
  const prevEmail = before.email || '';
  const label = before.label;

  const res = await chrome.scanGmail(id, { quiet });
  const email = res.email || prevEmail;
  const after = profileStore.update(id, { gmailStatus: res.status, email });
  if (quiet && (prevStatus !== res.status || prevEmail !== email)) {
    logger.info('gmail', t('gmail.statusChanged', {
      label,
      status: t('gmailStatus.' + res.status),
      email: email ? ' (' + email + ')' : '',
    }));
  }
  return after;
}

function startAutoScan(ctx) {
  stopAutoScan();
  const tick = async () => {
    if (ticking) return; // не накладывать проходы друг на друга
    ticking = true;
    try {
      for (const p of ctx.profileStore.list()) {
        if (!ctx.chrome.isRunning(p.id)) continue;
        try { await scanAndPersist(ctx, p.id, { quiet: true }); } catch (_e) {
          // профиль могли закрыть прямо во время прохода - молча пропускаем
        }
      }
    } finally { ticking = false; }
  };
  // Интервал перечитываем на каждом тике, чтобы правка настройки применялась
  // без перезапуска приложения.
  const schedule = () => {
    const sec = Number(ctx.store.get('system').autoScanSec) || 15;
    timer = setTimeout(async () => {
      await tick();
      if (timer) schedule();
    }, Math.max(3, sec) * 1000);
  };
  schedule();

  // Основной путь - события браузера: вкладка сменила адрес или заголовок,
  // значит статус мог поменяться прямо сейчас. Таймер выше остаётся страховкой.
  // Пачку событий одной загрузки страницы схлопываем задержкой.
  unwatch = ctx.chrome.onProfileActivity((profileId) => {
    const prev = pendingByProfile.get(profileId);
    if (prev) clearTimeout(prev);
    pendingByProfile.set(profileId, setTimeout(async () => {
      pendingByProfile.delete(profileId);
      if (!ctx.chrome.isRunning(profileId)) return;
      try { await scanAndPersist(ctx, profileId, { quiet: true }); } catch (_e) {}
    }, ACTIVITY_DEBOUNCE_MS));
  });
}

function stopAutoScan() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (unwatch) { unwatch(); unwatch = null; }
  for (const h of pendingByProfile.values()) clearTimeout(h);
  pendingByProfile.clear();
}

module.exports = { scanAndPersist, startAutoScan, stopAutoScan };
