'use strict';
/**
 * Постоянный список контактов рассылки. При каждом первом письме сюда
 * сохраняется получатель вместе с данными товара и профилем, от которого ушло
 * письмо. Нужно, чтобы позже - даже спустя несколько завершённых рассылок -
 * можно было "подтолкнуть" человека по его email: взять сохранённые данные
 * товара, пересобрать ссылку и отправить письмо из того же аккаунта.
 *
 * Хранится JSON рядом с настройками, запись атомарная (tmp + rename), ключ -
 * нормализованный email (см. normalizeEmail).
 */
const fs = require('fs');
const path = require('path');

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

class ContactStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.byEmail = new Map();
    this._load();
  }

  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(arr)) {
        // Ключ пересобираем при загрузке: записи, сделанные до перехода на
        // normalizeEmail, лежат под старым ключом.
        for (const c of arr) if (c && c.email) this.byEmail.set(normalizeEmail(c.email), c);
      }
    } catch (_e) { /* первый запуск или файл нечитаем - пустой список */ }
  }

  _save() {
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([...this.byEmail.values()], null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  _key(email) {
    return normalizeEmail(email);
  }

  get(email) {
    const key = this._key(email);
    return (key && this.byEmail.get(key)) || null;
  }

  list() {
    return [...this.byEmail.values()];
  }

  /**
   * Записать/обновить контакт после первого письма. Данные товара нужны для
   * ссылки; при повторной рассылке на тот же адрес освежаем их, но первую дату
   * контакта сохраняем.
   */
  recordSent({ lead, profile } = {}) {
    const key = this._key(lead && lead.email);
    if (!key) return null;
    const meta = (lead && lead.meta) || {};
    const prev = this.byEmail.get(key) || {};
    const rec = {
      // Ключ нормализован, а в записи держим адрес как есть: именно на него
      // потом уходит письмо-подталкивание.
      email: String((lead && lead.email) || prev.email || '').trim().toLowerCase(),
      name: (lead && lead.name) || prev.name || '',
      leadId: (lead && lead.id) || prev.leadId || '',
      platform: (lead && lead.platform) || prev.platform || '',
      listingUrl: (lead && lead.listingUrl) || prev.listingUrl || '',
      title: meta.title || prev.title || '',
      price: meta.price != null ? meta.price : (prev.price != null ? prev.price : ''),
      currency: meta.currency || prev.currency || '',
      // Данные товара для плейсхолдеров автоответа. VVS отдаёт их сам, у
      // XProject таких полей в документации нет - там останется пусто.
      imageUrl: meta.imageUrl || prev.imageUrl || '',
      datePublication: meta.datePublication || prev.datePublication || '',
      sellerUrl: meta.sellerUrl || prev.sellerUrl || '',
      profileId: (profile && profile.id) || prev.profileId || '',
      profileLabel: (profile && profile.label) || prev.profileLabel || '',
      firstSentAt: prev.firstSentAt || Date.now(),
      lastSentAt: Date.now(),
      nudged: prev.nudged || false,
    };
    this.byEmail.set(key, rec);
    this._save();
    return rec;
  }

  /** Отметить, что человека подтолкнули (для истории, не блокирует повтор). */
  markNudged(email) {
    const rec = this.get(email);
    if (!rec) return null;
    rec.nudged = true;
    rec.lastNudgedAt = Date.now();
    this._save();
    return rec;
  }
}

module.exports = { ContactStore, normalizeEmail };
