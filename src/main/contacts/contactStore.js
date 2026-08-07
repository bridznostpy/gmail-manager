'use strict';
/**
 * Постоянный список контактов рассылки. При каждом первом письме сюда
 * сохраняется получатель вместе с данными товара и профилем, от которого ушло
 * письмо. Нужно, чтобы позже - даже спустя несколько завершённых рассылок -
 * можно было "подтолкнуть" человека по его email: взять сохранённые данные
 * товара, пересобрать ссылку и отправить письмо из того же аккаунта.
 *
 * Хранится JSON рядом с настройками, запись атомарная (tmp + rename), ключ -
 * email в нижнем регистре.
 */
const fs = require('fs');
const path = require('path');

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
        for (const c of arr) if (c && c.email) this.byEmail.set(String(c.email).toLowerCase(), c);
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
    return String(email || '').trim().toLowerCase();
  }

  get(email) {
    return this.byEmail.get(this._key(email)) || null;
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
    const email = this._key(lead && lead.email);
    if (!email) return null;
    const meta = (lead && lead.meta) || {};
    const prev = this.byEmail.get(email) || {};
    const rec = {
      email,
      name: (lead && lead.name) || prev.name || '',
      leadId: (lead && lead.id) || prev.leadId || '',
      platform: (lead && lead.platform) || prev.platform || '',
      listingUrl: (lead && lead.listingUrl) || prev.listingUrl || '',
      title: meta.title || prev.title || '',
      price: meta.price != null ? meta.price : (prev.price != null ? prev.price : ''),
      currency: meta.currency || prev.currency || '',
      profileId: (profile && profile.id) || prev.profileId || '',
      profileLabel: (profile && profile.label) || prev.profileLabel || '',
      firstSentAt: prev.firstSentAt || Date.now(),
      lastSentAt: Date.now(),
      nudged: prev.nudged || false,
    };
    this.byEmail.set(email, rec);
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

module.exports = { ContactStore };
