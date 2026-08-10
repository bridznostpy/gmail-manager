'use strict';
/**
 * Постоянный список профилей браузера. Один профиль = один Chrome со своим
 * --user-data-dir и своим фингерпринтом. Хранится JSON рядом с настройками.
 *
 * В профиле может быть несколько почт: пользователь входит в них руками через
 * мультилогин Google и держит открытыми вкладки /mail/u/0/, /mail/u/1/ и так
 * далее. Каждая такая почта - своя единица работы со своим счётчиком писем, см.
 * mailbox.js. Поле `email` осталось: это основная почта профиля, на ней держатся
 * аватар и заголовки карточек.
 */
const fs = require('fs');
const path = require('path');
const fingerprint = require('../cdp/fingerprint');
const mailboxes = require('../mailbox');

class ProfileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.profiles = [];
    this._load();
  }

  _load() {
    try {
      this.profiles = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!Array.isArray(this.profiles)) this.profiles = [];
    } catch (_e) {
      this.profiles = [];
    }
    // Профили, созданные до появления мультипочты, поля не имеют. Заводим его
    // пустым: настоящий список соберёт первый же скан по открытым вкладкам.
    for (const p of this.profiles) {
      if (!Array.isArray(p.mailboxes)) p.mailboxes = [];
    }
  }

  _save() {
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.profiles, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  list() {
    return this.profiles;
  }

  get(id) {
    return this.profiles.find((p) => p.id === id) || null;
  }

  create(label) {
    const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const profile = {
      id,
      label: label || `Profile ${this.profiles.length + 1}`,
      createdAt: Date.now(),
      email: '', // основная почта профиля (первая из mailboxes)
      gmailStatus: 'new', // new | needs_login | ready | error
      sentCount: 0, // писем с профиля всего, для карточки; лимит считается по почтам
      running: false,
      port: null,
      // Почты профиля: { email, userIndex, sentCount, hasTab, lastSeenAt }.
      // Заполняет скан по открытым вкладкам, см. setMailboxes.
      mailboxes: [],
      fingerprint: fingerprint.generate(),
    };
    this.profiles.push(profile);
    this._save();
    return profile;
  }

  update(id, patch) {
    const p = this.get(id);
    if (!p) return null;
    Object.assign(p, patch);
    this._save();
    return p;
  }

  remove(id) {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.profiles.length !== before) this._save();
    return before !== this.profiles.length;
  }

  // ── Почты профиля ──────────────────────────────────────────────────

  /** Почты профиля. Порядок сохранён: первая считается основной. */
  mailboxes(id) {
    const p = this.get(id);
    return (p && Array.isArray(p.mailboxes)) ? p.mailboxes : [];
  }

  getMailbox(id, email) {
    const key = mailboxes.normalizeEmail(email);
    return this.mailboxes(id).find((m) => mailboxes.normalizeEmail(m.email) === key) || null;
  }

  /**
   * Записать почты, найденные сканом.
   *
   * Счётчики уже известных почт СОХРАНЯЮТСЯ: скан говорит только о том, какие
   * ящики видны и есть ли у них вкладка, а сколько с них ушло писем, он не
   * знает. Почта, которой в этом скане нет, из списка не выбрасывается - у неё
   * лишь снимается признак вкладки, иначе лимит обнулялся бы каждый раз, когда
   * пользователь закрыл вкладку и открыл заново.
   */
  setMailboxes(id, found) {
    const p = this.get(id);
    if (!p) return [];
    const seen = new Set();
    const next = [];
    for (const item of (found || [])) {
      const email = String((item && item.email) || '').trim();
      if (!email) continue;
      const key = mailboxes.normalizeEmail(email);
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = this.getMailbox(id, email) || {};
      next.push({
        email,
        userIndex: item.userIndex != null ? Number(item.userIndex) : (prev.userIndex || 0),
        sentCount: prev.sentCount || 0,
        hasTab: true,
        lastSeenAt: Date.now(),
      });
    }
    // Почты, которых скан не увидел: вкладки нет, счётчик остаётся.
    for (const prev of this.mailboxes(id)) {
      if (seen.has(mailboxes.normalizeEmail(prev.email))) continue;
      next.push({ ...prev, hasTab: false });
    }
    p.mailboxes = next;
    this._save();
    return next;
  }

  /** Снять или вернуть признак вкладки у одной почты. */
  setMailboxTab(id, email, hasTab) {
    const mb = this.getMailbox(id, email);
    if (!mb) return null;
    mb.hasTab = !!hasTab;
    this._save();
    return mb;
  }

  /**
   * Плюс одно письмо этой почте. Счётчик профиля тоже растёт: карточка
   * показывает его как "всего написано с профиля".
   */
  bumpMailbox(id, email, n = 1) {
    const p = this.get(id);
    const mb = this.getMailbox(id, email);
    if (!p || !mb) return null;
    mb.sentCount = (mb.sentCount || 0) + n;
    p.sentCount = (p.sentCount || 0) + n;
    this._save();
    return mb;
  }

  /**
   * Сводка для дашборда. Признак "запущен" принимаем снаружи: в profiles.json
   * это лишь снимок последнего состояния, и он устаревает, когда пользователь
   * закрывает окно Chrome сам или приложение перезапускают. Правду знает
   * только менеджер браузеров.
   */
  stats(isRunning) {
    const live = typeof isRunning === 'function' ? isRunning : (p) => !!p.running;
    const total = this.profiles.length;
    const running = this.profiles.filter(live).length;
    const gmailReady = this.profiles.filter((p) => p.gmailStatus === 'ready').length;
    const portsOpen = this.profiles.filter((p) => live(p) && p.port).length;
    // Почты считаем только у запущенных профилей: у погашенного вкладок нет, и
    // "готовых почт" там быть не может.
    const boxes = this.profiles.filter(live).reduce((acc, p) => {
      for (const m of (p.mailboxes || [])) {
        acc.total++;
        if (m.hasTab) acc.ready++;
      }
      return acc;
    }, { total: 0, ready: 0 });
    return {
      total, running, gmailReady, portsOpen,
      mailboxTotal: boxes.total, mailboxReady: boxes.ready,
    };
  }
}

module.exports = { ProfileStore };
