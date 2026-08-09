'use strict';
/**
 * Журнал по дням: сколько писем ушло, сколько автоответов отправлено и сколько
 * отправок сорвалось.
 *
 * Зачем отдельно от profileStore: там счётчик накопительный и обнуляется вместе
 * с профилем, а для графика нужна история по датам, переживающая и удаление
 * профиля, и смену лимитов.
 *
 * Ключ дня - локальная дата пользователя (YYYY-MM-DD), а не UTC: график
 * подписан "сегодня/вчера" глазами того, кто сидит перед экраном.
 */
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 120; // старее этого не храним - файл не должен пухнуть

function dayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

class StatsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.days = {};
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.days = (raw && typeof raw.days === 'object' && raw.days) || {};
    } catch (_e) {
      this.days = {};
    }
  }

  _save() {
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ days: this.days }, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  /** Плюс один к счётчику текущего дня. kind: sent | replies | errors. */
  note(kind) {
    const key = dayKey();
    const row = this.days[key] || { sent: 0, replies: 0, errors: 0 };
    if (row[kind] === undefined) return null;
    row[kind]++;
    this.days[key] = row;
    this._trim();
    this._save();
    return row;
  }

  _trim() {
    const keys = Object.keys(this.days).sort();
    while (keys.length > KEEP_DAYS) delete this.days[keys.shift()];
  }

  /**
   * Последние `days` дней подряд, включая пустые: график с провалами честнее
   * склеенной линии из одних рабочих дней.
   */
  recent(days = 14) {
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = dayKey(d.getTime());
      const row = this.days[key] || { sent: 0, replies: 0, errors: 0 };
      out.push({ day: key, ...row });
    }
    return out;
  }

  /** Итоги за всё время - для крупных чисел на экране статистики. */
  totals() {
    return Object.values(this.days).reduce(
      (acc, r) => ({
        sent: acc.sent + (r.sent || 0),
        replies: acc.replies + (r.replies || 0),
        errors: acc.errors + (r.errors || 0),
      }),
      { sent: 0, replies: 0, errors: 0 },
    );
  }
}

module.exports = { StatsStore, dayKey };
