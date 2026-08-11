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

  // Геометрия окна между запусками (пишется из main.js при resize/move).
  window: null,

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
    glassAlpha: 0.72, // плотность стекла карточек, 0..1 (светлое фото требует больше)
    scrimAlpha: 0.3, // вуаль поверх фото вокруг панелей, 0..1
    parallax: true, // фон едет за курсором
    refract: false, // SVG-преломление на крупных панелях (дорого по видеокарте)
    fit: 'cover', // 'cover' | 'contain' | 'tile'
    accent: 'green', // green | violet | blue | amber | pink
    reduceMotion: false,
  },

  // ── Память интерфейса ────────────────────────────────────────────
  // Выбор вида списка и открытых панелей. Держим рядом с остальными
  // настройками, чтобы не заводить второе хранилище: пользователь ждёт, что
  // приложение откроется таким же, каким он его закрыл.
  ui: {
    profileView: 'grid', // 'grid' | 'list'
    profileSort: 'created', // 'created' | 'written' | 'status' | 'label'
    arPreviewOpen: false, // панель превью HTML-шаблона авто-ответа
    arPreviewDevice: 'desktop', // 'desktop' | 'mobile' - ширина письма в превью
    // Поток живых логов на паузе. Единственное поле секции, которое НЕ
    // переживает перезапуск: рендер сбрасывает его при старте, иначе
    // приложение открывалось бы с замороженным журналом и выглядело зависшим.
    logsPaused: false,
  },

  // ── System settings ──────────────────────────────────────────────
  system: {
    mailsPerAccount: 50, // limit of first-messages per Gmail account
    maxRepliesPerDialog: 3, // cap on auto-replies in one conversation
    checkIntervalSec: 20, // how often the auto-responder polls for replies
    // Пауза между первыми письмами, секунды. Раньше была зашита в движок
    // (1500 мс) и не настраивалась.
    sendDelaySec: 2,
    // Множитель бюджетов ожидания Gmail (см. chromeManager). Сами ожидания
    // идут по появлению элемента, а бюджет - только предел, за которым
    // считаем, что элемент не появился. На медленном интернете растягивается
    // одним числом.
    waitScale: 1,
    autoScanSec: 15, // how often running profiles are re-scanned for Gmail status
    outreachLang: 'en', // language of outreach texts (MESSAGES/PASTE/CONFIRM dicts)
    parserBatchSize: 40, // items pulled per parser batch
    queueRefillThreshold: 20, // refill the queue when it drops below this
  },

  // ── Авто-ответ ───────────────────────────────────────────────────
  // Чем отвечаем продавцу: обычным текстом из PASTE_DICT (texts.json) или одним
  // HTML-шаблоном. Пустой html означает "взять встроенный образец", см.
  // htmlTemplate.js.
  autoReply: {
    mode: 'text', // 'text' | 'html'
    html: '',
  },

  // ── Parser ───────────────────────────────────────────────────────
  parser: {
    apiKey: '',
    apiType: 'xproject', // 'xproject' | 'vvs'
    aiTemplateSwap: false, // rotate message templates via AI
    enabled: false,
    swapKeyEveryN: 0, // rotate API key after N messages (0 = never)
    // Цель рассылки. Площадка ОДНА: оба парсера принимают ровно одну за вызов
    // (XProject - поле platform в задаче, VVS - сегмент пути /ads/{platform}).
    // Стран может быть несколько - клиенты обходят их по очереди, отдельным
    // запросом на каждую. Коды канонические, нижним регистром; регистр под свой
    // контракт каждый клиент приводит сам.
    platform: 'poshmark', // 'depop' | 'poshmark' | 'vinted'
    countries: ['us'],
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

  // ── Разовые переносы данных ──────────────────────────────────────
  // Служебная секция: в интерфейсе её нет (разделы настроек перечислены явно,
  // см. SETTINGS_GROUPS). Флаг взводится один раз и говорит, что перенос уже
  // сделан, - иначе он повторялся бы на каждом запуске.
  migrations: {
    chatsArchived: false, // переписки, накопленные до появления архива, убраны в архив
  },

  // ── Broadcast texts (loaded JSON) ────────────────────────────────
  texts: null,
};

/**
 * Разовый перенос старых форм настроек.
 *
 * Цели рассылки раньше лежали плоским списком чипов (platforms: ['usa',
 * 'poshmark']), из которого клиенты парсера всё равно собирали одну площадку и
 * одну страну. Теперь это явные поля. Без переноса после обновления рассылка
 * молча ушла бы на площадку по умолчанию - то есть собирала бы не то, что
 * человек выбрал.
 *
 * Возвращает true, если что-то изменилось и файл надо переписать.
 */
function migrate(data) {
  const p = data.parser;
  if (!p || !Array.isArray(p.platforms)) return false;
  const old = p.platforms;
  const known = ['depop', 'poshmark', 'vinted'];
  const platform = old.find((x) => known.includes(x));
  if (platform) p.platform = platform;
  // Единственной страной в старом списке была отметка "usa".
  if (old.includes('usa')) p.countries = ['us'];
  delete p.platforms;
  return true;
}

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
      // Переносим сразу и пишем обратно: иначе старое поле осталось бы в файле
      // и перенос повторялся бы каждый запуск, затирая новый выбор.
      if (migrate(this.data)) this._save();
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
