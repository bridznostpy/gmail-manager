'use strict';
/**
 * Клиент нейронки для обновления текстов рассылки.
 *
 * Провайдер выбирается в настройках. Все они говорят одним и тем же языком -
 * POST {baseUrl}/chat/completions в форме OpenAI, - поэтому клиент один, а
 * различается только адрес и название модели:
 *
 *   deepseek - https://api.deepseek.com, документация api-docs.deepseek.com;
 *   tooken   - https://tooken.club/v1, документация на странице подключения
 *              Tooken Club (те же chat/completions, ключ вида tc_live_...);
 *   custom   - свой адрес, если провайдер другой, но контракт тот же.
 *
 * Здесь только транспорт: собрать запрос, разобрать коды отказа и вернуть текст
 * ответа. Что просить у модели и что считать годным ответом - забота
 * ai/textSwap.js. Весь внешний контракт живёт в CONFIG (Rules 4): менять адреса
 * и поля запроса можно только тут и только по документации.
 */
const logger = require('../logger');
const { t } = require('../i18n');

// Провайдеры, адреса которых зашиты. Модели перечислены для подсказки в окне
// настроек - список не проверяется, вписать можно любую.
const PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  tooken: {
    baseUrl: 'https://tooken.club/v1',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8',
      'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'],
  },
};

const CONFIG = {
  providers: PROVIDERS,
  defaultProvider: 'deepseek',
  endpoints: { chat: '/chat/completions' },
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  // Режим строгого JSON: модель обязана вернуть объект, а не текст с
  // пояснениями вокруг него. Требует упоминания слова "json" в задании - см.
  // textSwap.js. Провайдер может его не принять, тогда работает запасной путь
  // без этого поля, см. chat().
  jsonMode: true,
  // Тексты писем - творческая задача, документация Deepseek советует для неё
  // температуру выше единицы. Проверено и на Tooken Club: поле принимают и
  // модели Claude, и GPT.
  temperature: 1.3,
  // Предел ответа. Три словаря по несколько вариантов укладываются с запасом, а
  // без предела зависший ответ тянул бы минуты.
  maxTokens: 4000,
  timeoutMs: 120000,
};

/** Ключ задан и на ключ похож. Пустой ключ - не ошибка, а выключенная функция. */
function hasKey(apiKey) {
  return !!String(apiKey || '').trim();
}

/**
 * Адрес и модель по настройкам. Свой адрес перебивает выбор провайдера: его
 * вписывают ровно затем, чтобы уйти от зашитого.
 */
function resolve(cfg) {
  const c = cfg || {};
  const preset = PROVIDERS[c.provider] || PROVIDERS[CONFIG.defaultProvider];
  const baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '') || preset.baseUrl;
  const model = String(c.model || '').trim() || preset.defaultModel;
  return { baseUrl, model };
}

/**
 * Один запрос к модели. Возвращает строку ответа или null.
 *
 * Отказ - это НЕ исключение: обновление текстов идёт фоном во время рассылки, и
 * ронять из-за него прогон нельзя. Причина уходит в лог, наверх - null, тексты
 * остаются прежними.
 */
async function chat({ apiKey, provider, baseUrl, model, system, user, timeoutMs }) {
  if (!hasKey(apiKey)) {
    logger.warn('ai', t('ai.noKey'));
    return null;
  }
  const target = resolve({ provider, baseUrl, model });
  const url = target.baseUrl + CONFIG.endpoints.chat;
  const messages = [
    { role: 'system', content: String(system || '') },
    { role: 'user', content: String(user || '') },
  ];

  // Первая попытка - с температурой и строгим JSON. Часть моделей эти поля не
  // принимает и отвечает 400; тогда повторяем голым запросом, который обязан
  // понять любой совместимый провайдер.
  const bodies = [
    { model: target.model, messages, stream: false, temperature: CONFIG.temperature, max_tokens: CONFIG.maxTokens },
    { model: target.model, messages, stream: false },
  ];
  if (CONFIG.jsonMode) bodies[0].response_format = { type: 'json_object' };

  for (let attempt = 0; attempt < bodies.length; attempt++) {
    const res = await _post(url, apiKey, bodies[attempt], timeoutMs);
    if (res.ok) return res.text;
    // Смысл повторять есть только у 400: остальные отказы (ключ, деньги, лимит,
    // упавший сервер) от формы запроса не зависят.
    if (res.status !== 400 || attempt === bodies.length - 1) {
      if (res.status) logger.warn('ai', t(errorKey(res.status), { status: res.status }));
      else logger.warn('ai', t(res.timedOut ? 'ai.timeout' : 'ai.error', { error: res.error || '' }));
      return null;
    }
    logger.debug('ai', t('ai.retryPlain'));
  }
  return null;
}

/** Сам запрос. Разбор ответа держим отдельно, чтобы chat() читался сценарием. */
async function _post(url, apiKey, body, timeoutMs) {
  // Свой таймер отмены: без него зависший ответ держал бы обновление вечно, а
  // повторная попытка не пришла бы никогда.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Number(timeoutMs) || CONFIG.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CONFIG.authHeader]: CONFIG.authPrefix + String(apiKey).trim(),
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    const text = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (!text) {
      logger.warn('ai', t('ai.emptyAnswer'));
      return { ok: false, status: 0, error: '' };
    }
    return { ok: true, text: String(text) };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, timedOut: e && e.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}

/** Код отказа человеческими словами. Коды общие для совместимых провайдеров. */
function errorKey(status) {
  if (status === 401 || status === 403) return 'ai.badKey';
  if (status === 402) return 'ai.noBalance';
  if (status === 429) return 'ai.rateLimited';
  if (status === 400) return 'ai.badRequest';
  if (status === 404) return 'ai.badModel';
  if (status >= 500) return 'ai.serverDown';
  return 'ai.httpFailed';
}

/**
 * Проверка ключа из настроек: самый дешёвый запрос, какой можно задать. Нужна
 * ровно затем, чтобы человек узнал об опечатке в ключе или в названии модели
 * сразу, а не через сотню писем, когда придёт время обновлять тексты.
 */
async function test(cfg) {
  const c = cfg || {};
  if (!hasKey(c.apiKey)) return { ok: false, reason: 'no_key' };
  const target = resolve(c);
  const answer = await chat({
    apiKey: c.apiKey,
    provider: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    system: 'Answer with a JSON object {"ok":true} and nothing else.',
    user: 'ping',
    timeoutMs: 30000,
  });
  return answer ? { ok: true, model: target.model, baseUrl: target.baseUrl } : { ok: false, reason: 'failed' };
}

module.exports = { chat, test, hasKey, resolve, PROVIDERS, CONFIG };
