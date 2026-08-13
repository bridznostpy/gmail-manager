'use strict';
/**
 * Обновление текстов рассылки нейронкой прямо во время прогона.
 *
 * Замысел: тексты рассылки не застаиваются. Каждые N отправленных писем шаблон
 * переписывается целиком - те же по смыслу тексты, но другими словами, - и
 * рассылка продолжает идти уже новыми.
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
const ai = require('./aiClient');

/**
 * Задание модели.
 *
 * Приложение проверяет только формат выдачи (см. texts.validate), слова выбирает
 * модель. Поэтому в задании ровно две вещи: что сделать с текстами
 * (перефразировать, оставив смысл) и в каком виде вернуть.
 *
 * Слово "json" в задании обязательно - этого требует режим строгого JSON
 * (см. CONFIG.jsonMode в aiClient.js).
 */
const SYSTEM_PROMPT = [
  'You are a rewriting assistant. The input is a json object with short message',
  'templates used in e-mails to marketplace sellers. Your task is to paraphrase',
  'every template: say the same thing in different words.',
  '',
  'OUTPUT FORMAT',
  '1. Answer with ONE json object and nothing else: no markdown fences, no',
  '   comments, no explanations before or after it.',
  '2. Use exactly the same keys as the input, including the language code.',
  '3. Every array must have exactly the same number of items as in the input and',
  '   in the same order: item i of your answer replaces item i of the input.',
  '',
  'HOW TO PARAPHRASE',
  '4. Keep the meaning and the intent of every template. Do not add facts,',
  '   promises, prices, names or questions that were not there, and do not drop',
  '   the ones that were.',
  '5. Stay close to the original: same tone, same register, roughly the same',
  '   length. One short line stays one short line.',
  '6. Do not copy a template word for word - change the wording, not the message.',
  '7. Keep the language of the input. Never translate.',
  '',
  'KEEP LITERALLY',
  '8. Placeholders {link} {title} {price} {seller_username} {image_url} {date}',
  '   {ad_url}: copy them exactly, keep them in the template they came from, and',
  '   never invent new ones. They are filled with real data later.',
  '9. If a template ends with "link:" keep exactly that ending - the tool appends',
  '   the URL right after it.',
  '10. Keep line breaks (\\n) where they were: they are paragraphs of the mail.',
  '',
  'STYLE',
  '11. Plain everyday wording, the way a person types a short message. No',
  '    marketing tone, no HTML, no markdown, no emoji, no greetings or signatures',
  '    that were not in the input.',
  '',
  'EXAMPLE',
  'input:  {"MESSAGES_DICT":{"en":["hi, is this still available?"]}}',
  'output: {"MESSAGES_DICT":{"en":["hey, do you still have this one?"]}}',
].join('\n');

/**
 * Разобрать ответ модели.
 *
 * Строгий JSON принимает не всякий провайдер, а без него модели любят обернуть
 * объект в ```json ... ``` или подписать его словами. Снимаем обёртку и берём
 * то, что лежит между первой скобкой и последней: терять из-за оформления
 * годный ответ жалко.
 */
function _parseJson(answer) {
  const raw = String(answer == null ? '' : answer).trim();
  const attempts = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced) attempts.push(fenced[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));
  for (const text of attempts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_e) { /* следующая попытка */ }
  }
  return null;
}

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
    const target = ai.resolve(cfg);
    return {
      enabled: !!cfg.enabled,
      hasKey: ai.hasKey(cfg.apiKey),
      // Куда и чем на самом деле пойдёт запрос: провайдер и модель могут быть
      // не заданы, и подставленное по умолчанию человеку тоже надо видеть.
      baseUrl: target.baseUrl,
      model: target.model,
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
    if (!ai.hasKey(cfg.apiKey)) {
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
      const answer = await ai.chat({
        apiKey: cfg.apiKey,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        system: SYSTEM_PROMPT,
        user: this._task(source, lang, cfg.instruction),
      });
      if (!answer) return { ok: false, reason: 'no_answer' };

      const parsed = _parseJson(answer);
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

  /**
   * Задание модели: эталон целиком плюс приписка пользователя, если она есть.
   *
   * Главные требования повторены здесь, рядом с самими текстами, а не только в
   * роли: длинное задание модель держит хуже к концу, а решение принимается
   * именно на этом сообщении.
   */
  _task(source, lang, instruction) {
    const extra = String(instruction || '').trim();
    const count = texts.DICTS
      .map((d) => (source[d] && source[d][lang] ? d + ': ' + source[d][lang].length : null))
      .filter(Boolean).join(', ');
    return [
      'Paraphrase every template in the json below. Language code: "' + lang + '".',
      'Number of items you must return: ' + count + '.',
      'Keep the meaning, the tone and roughly the length; change the wording.',
      'Keep the placeholders, the "link:" endings and the line breaks as they are.',
      'Answer with a json object of exactly the same shape and nothing else.',
      extra ? 'Extra instruction from the user, follow it too: ' + extra : '',
      '',
      JSON.stringify(source, null, 2),
    ].filter(Boolean).join('\n');
  }
}

module.exports = { TextSwapper, SYSTEM_PROMPT };
