'use strict';
/**
 * Обновление текстов рассылки нейронкой прямо во время прогона.
 *
 * Замысел: письма не должны быть узнаваемыми. Каждые N отправленных писем
 * шаблон переписывается целиком - те же по смыслу тексты, но другими словами, -
 * и рассылка продолжает идти уже новыми.
 *
 * Три правила, на которых всё держится:
 *
 * 1. Переписываются ТОЛЬКО текстовые словари (MESSAGES/PASTE/CONFIRM).
 *    HTML-шаблон автоответа лежит в своей секции настроек, свёрстан руками и
 *    нейронке не показывается вовсе.
 * 2. Переписывается всегда ЭТАЛОН - тексты, которые загрузил человек, - а не
 *    прошлая выдача модели. Иначе каждое обновление уводило бы письма всё
 *    дальше от оригинала, и через десяток шагов смысл уехал бы совсем.
 * 3. Выдача проходит проверку (texts.validate). Не прошла - тексты остаются
 *    прежними, рассылка не замечает ничего.
 *
 * Обновление идёт фоном: пока модель думает, письма уходят старыми текстами.
 */
const logger = require('../logger');
const { t } = require('../i18n');
const texts = require('../texts');
const deepseek = require('./deepseek');

// Что просим у модели. Слово "json" в задании обязательно: этого требует режим
// строгого JSON у Deepseek (см. CONFIG.jsonMode в deepseek.js).
const SYSTEM_PROMPT = [
  'You rewrite short outreach e-mail texts for a marketplace seller outreach tool.',
  'You always answer with a single JSON object and nothing else - no markdown, no comments.',
  'Rules you must never break:',
  '1. Keep exactly the same JSON keys and the same language code as in the input.',
  '2. Keep exactly the same number of variants in every array.',
  '3. Keep every placeholder ({link}, {title}, {price}, {seller_username}, {image_url},',
  '   {date}, {ad_url}) literally as it is, in the same variant it appeared in.',
  '4. If a variant ends with "link:" keep that ending - the tool appends a URL there.',
  '5. Keep the meaning, the tone and roughly the length of every variant.',
  '6. Plain text only: no HTML, no emoji spam, no signatures that were not there.',
  '7. Write natural, human, casual wording - not marketing copy.',
].join('\n');

class TextSwapper {
  constructor(store) {
    this.store = store;
    // Письма с прошлого обновления. Живёт в памяти: счётчик про текущий прогон,
    // а не про историю.
    this.sinceSwap = 0;
    this._busy = false;
    // Поколение прогона. Растёт на каждом старте и остановке: выдача, пришедшая
    // от прошлого поколения, уже никому не нужна.
    this._gen = 0;
    // Кому сказать, что тексты сменились (окно обновляет раздел текстов).
    this._sinks = new Set();
  }

  onChange(fn) {
    this._sinks.add(fn);
    return () => this._sinks.delete(fn);
  }

  _emit(payload) {
    for (const sink of this._sinks) {
      try { sink(payload); } catch (_e) { /* окно не должно ронять движок */ }
    }
  }

  cfg() {
    return this.store.get('ai') || {};
  }

  /** Состояние для окна настроек. */
  state() {
    const cfg = this.cfg();
    return {
      enabled: !!cfg.enabled,
      hasKey: deepseek.hasKey(cfg.apiKey),
      everyN: Number(cfg.everyN) || 0,
      swaps: Number(cfg.swaps) || 0,
      lastSwapAt: Number(cfg.lastSwapAt) || 0,
      sinceSwap: this.sinceSwap,
      busy: this._busy,
      hasBaseline: !!cfg.baseline,
    };
  }

  /** Прогон начался или кончился: счётчик обнуляем, выдачу в полёте бросаем. */
  reset() {
    this.sinceSwap = 0;
    this._gen++;
  }

  /**
   * Запомнить тексты как эталон. Зовётся ТОЛЬКО когда тексты пришли от
   * человека (загрузил файл, поправил строку): выдача нейронки эталоном стать
   * не должна, иначе правило 2 из шапки перестанет работать.
   */
  rememberBaseline(json) {
    this.store.set('ai', { baseline: json ? JSON.parse(JSON.stringify(json)) : null });
  }

  /** Вернуть тексты к эталону. */
  restoreBaseline() {
    const cfg = this.cfg();
    if (!cfg.baseline) {
      logger.warn('ai', t('ai.noBaseline'));
      return { ok: false, reason: 'no_baseline' };
    }
    const restored = JSON.parse(JSON.stringify(cfg.baseline));
    this.store.set('texts', restored);
    this.sinceSwap = 0;
    logger.success('ai', t('ai.restored'));
    this._emit({ texts: restored, reason: 'restored' });
    return { ok: true, texts: restored };
  }

  /**
   * Письмо ушло. Досчитали до порога - запускаем обновление и НЕ ждём его:
   * рассылка продолжает идти, а тексты подменятся, когда модель ответит.
   */
  noteSent() {
    const cfg = this.cfg();
    const everyN = Number(cfg.everyN) || 0;
    if (!cfg.enabled || everyN <= 0) return;
    this.sinceSwap++;
    if (this.sinceSwap < everyN) return;
    this.sinceSwap = 0;
    this.swap({ auto: true }).catch(() => {});
  }

  /** Обновить тексты сейчас. Возвращает { ok, reason }. */
  async swap({ auto = false } = {}) {
    const cfg = this.cfg();
    if (auto && !cfg.enabled) return { ok: false, reason: 'disabled' };
    if (!deepseek.hasKey(cfg.apiKey)) {
      logger.warn('ai', t('ai.noKey'));
      return { ok: false, reason: 'no_key' };
    }
    if (this._busy) {
      logger.debug('ai', t('ai.busy'));
      return { ok: false, reason: 'busy' };
    }
    // Эталон: то, что загрузил человек. Его нет у тех, кто загрузил тексты до
    // появления этой функции, - тогда эталоном становятся текущие тексты.
    let baseline = cfg.baseline;
    if (!baseline) {
      baseline = this.store.get('texts');
      if (baseline) this.rememberBaseline(baseline);
    }
    if (!baseline) {
      logger.warn('ai', t('ai.noTexts'));
      return { ok: false, reason: 'no_texts' };
    }

    const lang = texts.outreachLang(this.store);
    const source = this._slice(baseline, lang);
    if (!source) {
      logger.warn('ai', t('ai.noTexts'));
      return { ok: false, reason: 'no_texts' };
    }

    const gen = this._gen;
    this._busy = true;
    logger.info('ai', t('ai.started', { lang: String(lang).toUpperCase() }));
    try {
      const answer = await deepseek.chat({
        apiKey: cfg.apiKey,
        model: cfg.model,
        system: SYSTEM_PROMPT,
        user: this._task(source, lang, cfg.instruction),
      });
      if (!answer) return { ok: false, reason: 'no_answer' };

      let parsed = null;
      try { parsed = JSON.parse(answer); } catch (_e) { parsed = null; }
      if (!parsed) {
        logger.warn('ai', t('ai.badJson'));
        return { ok: false, reason: 'bad_json' };
      }

      const check = texts.validate(parsed, source, lang);
      if (!check.ok) {
        logger.warn('ai', t('ai.rejected', {
          reason: t(check.reason, { dict: check.dict || '' }),
        }));
        return { ok: false, reason: 'rejected' };
      }

      // Прогон успели остановить, пока модель думала. Подменять тексты задним
      // числом нельзя: следующий запуск ждёт ровно то, что видит в настройках.
      if (gen !== this._gen) {
        logger.info('ai', t('ai.dropped'));
        return { ok: false, reason: 'dropped' };
      }

      const next = this._merge(this.store.get('texts') || baseline, parsed, lang);
      this.store.set('texts', next);
      const swaps = (Number(cfg.swaps) || 0) + 1;
      this.store.set('ai', { swaps, lastSwapAt: Date.now() });
      logger.success('ai', t('ai.done', { n: swaps }));
      this._emit({ texts: next, reason: 'swapped' });
      return { ok: true, texts: next, swaps };
    } finally {
      this._busy = false;
    }
  }

  /** Только нужный язык и только текстовые словари - больше модели знать нечего. */
  _slice(json, lang) {
    const out = {};
    let found = false;
    for (const dict of texts.DICTS) {
      const arr = json && json[dict] && json[dict][lang];
      if (Array.isArray(arr) && arr.length) {
        out[dict] = { [lang]: arr.slice() };
        found = true;
      }
    }
    return found ? out : null;
  }

  /**
   * Вложить новые тексты в текущие. Остальные языки и всё, что лежит в файле
   * рядом (например, выключатель autoReply), остаются как были: нейронке их не
   * показывали, и терять их из-за обновления нельзя.
   */
  _merge(current, fresh, lang) {
    const next = JSON.parse(JSON.stringify(current || {}));
    for (const dict of texts.DICTS) {
      const arr = fresh[dict] && fresh[dict][lang];
      if (!Array.isArray(arr)) continue;
      if (!next[dict] || typeof next[dict] !== 'object') next[dict] = {};
      next[dict][lang] = arr.slice();
    }
    return next;
  }

  /** Задание модели: эталон целиком плюс приписка пользователя, если она есть. */
  _task(source, lang, instruction) {
    const extra = String(instruction || '').trim();
    return [
      'Rewrite every variant in this JSON. Language code: "' + lang + '".',
      'Answer with a JSON object of exactly the same shape.',
      extra ? 'Extra instruction from the user: ' + extra : '',
      '',
      JSON.stringify(source, null, 2),
    ].filter(Boolean).join('\n');
  }
}

module.exports = { TextSwapper, SYSTEM_PROMPT };
