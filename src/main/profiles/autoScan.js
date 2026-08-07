'use strict';
/**
 * Фоновый скан статуса Gmail у запущенных профилей.
 *
 * Пользователь логинится в Gmail руками (Rules 6), и момент входа приложению
 * ниоткуда не приходит. Поэтому раз в `system.autoScanSec` секунд опрашиваем
 * все запущенные профили и обновляем их статус и почту, чтобы карточку не
 * приходилось обновлять кнопкой "Просканировать". Рендер подхватывает данные
 * своим опросом `profiles:list`, отдельный канал IPC не нужен.
 */
const logger = require('../logger');
const { t } = require('../i18n');

let timer = null;
let ticking = false;

/**
 * Просканировать профиль и сохранить результат. Единая точка для кнопки в UI и
 * для фонового таймера. Пишет в лог, только если статус или почта изменились.
 */
async function scanAndPersist(ctx, id, { quiet = false } = {}) {
  const { chrome, profileStore } = ctx;
  const before = profileStore.get(id);
  if (!before) throw new Error(t('err.profileNotFound'));
  const res = await chrome.scanGmail(id, { quiet });
  const email = res.email || before.email || '';
  const after = profileStore.update(id, { gmailStatus: res.status, email });
  if (quiet && (before.gmailStatus !== res.status || before.email !== email)) {
    logger.info('gmail', t('gmail.statusChanged', {
      label: before.label,
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
}

function stopAutoScan() {
  if (timer) { clearTimeout(timer); timer = null; }
}

module.exports = { scanAndPersist, startAutoScan, stopAutoScan };
