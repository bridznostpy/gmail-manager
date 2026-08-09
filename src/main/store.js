'use strict';
/**
 * Tiny JSON-file settings store (no external deps).
 *
 * One file under Electron's userData dir. Reads are cached in memory; every
 * `set` writes through atomically (tmp + rename) so a crash mid-write can't
 * corrupt the file.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  theme: 'dark', // 'dark' | 'light'
  language: 'ru', // 'ru' | 'en' - язык интерфейса и сообщений в логах
  accent: '#7f52ff',

  // ── Appearance (фон, акцент, движение) ───────────────────────────
  // Картинка фона лежит файлом в userData/appearance, здесь только её имя:
  // хранить сотни килобайт base64 в settings.json незачем.
  appearance: {
    bgType: 'gradient', // 'gradient' | 'image'
    bgFile: '', // имя файла внутри userData/appearance
    bgPreset: 'aurora', // пресет градиента, когда картинки нет
    dim: 0.58, // затемнение фона, 0..1
    blur: 0, // размытие фона, px
    saturate: 1, // насыщенность фона
    fit: 'cover', // 'cover' | 'contain' | 'tile'
    accent: 'green', // green | violet | blue | amber | pink
    reduceMotion: false,
  },

  // ── System settings ──────────────────────────────────────────────
  system: {
    mailsPerAccount: 50, // limit of first-messages per Gmail account
    maxRepliesPerDialog: 3, // cap on auto-replies in one conversation
    checkIntervalSec: 20, // how often the auto-responder polls for replies
    autoScanSec: 15, // how often running profiles are re-scanned for Gmail status
    outreachLang: 'en', // language of outreach texts (MESSAGES/PASTE/CONFIRM dicts)
    parserBatchSize: 40, // items pulled per parser batch
    queueRefillThreshold: 20, // refill the queue when it drops below this
  },

  // ── Parser ───────────────────────────────────────────────────────
  parser: {
    apiKey: '',
    apiType: 'xproject', // 'xproject' | 'vvs'
    aiTemplateSwap: false, // rotate message templates via AI
    enabled: false,
    swapKeyEveryN: 0, // rotate API key after N messages (0 = never)
    platforms: [], // e.g. ['usa', 'poshmark']
  },

  // ── Chrome CDP ───────────────────────────────────────────────────
  cdp: {
    chromePath: '', // '' = auto-detect
    portStart: 9222,
    portEnd: 9322,
  },

  // ── Link generator ───────────────────────────────────────────────
  link: {
    apiKey: '',
    team: 'haron_rent', // command/provider
    mode: '', // link mode
    profileId: '',
    country: 'US',
  },

  // ── Telegram ─────────────────────────────────────────────────────
  telegram: {
    botToken: '',
    botId: '',
  },

  // ── Broadcast texts (loaded JSON) ────────────────────────────────
  texts: null,
};

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') {
      for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    }
    return out;
  }
  return over === undefined ? base : over;
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.data = deepMerge(DEFAULTS, JSON.parse(raw));
    } catch (_e) {
      // first run or unreadable - keep defaults
      this.data = { ...DEFAULTS };
    }
  }

  _save() {
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  all() {
    return this.data;
  }

  get(key) {
    return this.data[key];
  }

  /** Shallow-merge a section (e.g. set('system', {mailsPerAccount: 100})). */
  set(key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        this.data[key] && typeof this.data[key] === 'object') {
      this.data[key] = { ...this.data[key], ...value };
    } else {
      this.data[key] = value;
    }
    this._save();
    return this.data[key];
  }

  replaceAll(obj) {
    this.data = deepMerge(DEFAULTS, obj);
    this._save();
    return this.data;
  }
}

module.exports = { Store, DEFAULTS };
