'use strict';
/**
 * Persistent list of browser profiles. Each profile is one Gmail account /
 * one Chrome instance. Stored as JSON next to the settings file.
 */
const fs = require('fs');
const path = require('path');
const fingerprint = require('../cdp/fingerprint');

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
      email: '',
      gmailStatus: 'new', // new | needs_login | ready | error
      sentCount: 0, // first-messages sent from this account
      running: false,
      port: null,
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
    return { total, running, gmailReady, portsOpen };
  }
}

module.exports = { ProfileStore };
