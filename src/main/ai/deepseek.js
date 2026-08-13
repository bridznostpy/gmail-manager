'use strict';
/**
 * Deepseek AI client.
 *
 * Docs: https://api-docs.deepseek.com (эндпоинт /chat/completions, совместимый
 * с OpenAI). Ключ пользовательский, вводится в настройках и никуда, кроме этого
 * запроса, не уходит.
 *
 * Здесь только транспорт: собрать запрос, разобрать коды отказа и вернуть текст
 * ответа. Что именно просить у модели и что считать годным ответом - забота
 * ai/textSwap.js. Весь внешний контракт живёт в CONFIG (Rules 4): менять
 * адреса и поля запроса можно только тут и только по документации.
 */
const logger = require('../logger');
const { t } = require('../i18n');

const CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  endpoints: { chat: '/chat/completions' },
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  defaultModel: 'deepseek-chat',
  // Режим строгого JSON: модель обязана вернуть объект, а не текст с
  // пояснениями вокруг него. Документация требует при этом упомянуть слово
  // "json" в самом задании - см. textSwap.js.
  jsonMode: true,
  // Тексты писем - творческая задача, документация советует для неё
  // температуру выше единицы.
  temperature: 1.3,
  // Предел ответа. Три словаря по несколько вариантов в каждом укладываются с
  // огромным запасом, а без предела зависший ответ тянул бы минуты.
  maxTokens: 4000,
  timeoutMs: 120000,
};

/** Ключ задан и на ключ похож. Пустой ключ - не ошибка, а выключенная функция. */
function hasKey(apiKey) {
  return !!String(apiKey || '').trim();
}

/**
 * Один запрос к модели. Возвращает строку ответа или null.
 *
 * Отказ - это НЕ исключение: обновление текстов идёт фоном во время рассылки, и
 * ронять из-за него прогон нельзя. Причина уходит в лог, наверх - null, тексты
 * остаются прежними.
 */
async function chat({ apiKey, model, system, user, timeoutMs }) {
  if (!hasKey(apiKey)) {
    logger.warn('ai', t('ai.noKey'));
    return null;
  }
  const url = CONFIG.baseUrl + CONFIG.endpoints.chat;
  const body = {
    model: String(model || CONFIG.defaultModel),
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(user || '') },
    ],
    stream: false,
    temperature: CONFIG.temperature,
    max_tokens: CONFIG.maxTokens,
  };
  if (CONFIG.jsonMode) body.response_format = { type: 'json_object' };

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
    if (!res.ok) {
      logger.warn('ai', t(errorKey(res.status), { status: res.status }));
      return null;
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (!text) {
      logger.warn('ai', t('ai.emptyAnswer'));
      return null;
    }
    return String(text);
  } catch (e) {
    logger.warn('ai', t(e && e.name === 'AbortError' ? 'ai.timeout' : 'ai.error', { error: e.message }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Код отказа человеческими словами. Коды - из документации Deepseek. */
function errorKey(status) {
  if (status === 401) return 'ai.badKey';
  if (status === 402) return 'ai.noBalance';
  if (status === 429) return 'ai.rateLimited';
  if (status === 400) return 'ai.badRequest';
  if (status >= 500) return 'ai.serverDown';
  return 'ai.httpFailed';
}

/**
 * Проверка ключа из настроек: самый дешёвый запрос, какой можно задать. Нужна
 * ровно затем, чтобы человек узнал об опечатке в ключе сразу, а не через сотню
 * писем, когда придёт время обновлять тексты.
 */
async function test(apiKey, model) {
  if (!hasKey(apiKey)) return { ok: false, reason: 'no_key' };
  const answer = await chat({
    apiKey,
    model,
    system: 'Answer with a JSON object {"ok":true} and nothing else.',
    user: 'ping',
    timeoutMs: 30000,
  });
  return answer ? { ok: true } : { ok: false, reason: 'failed' };
}

module.exports = { chat, test, hasKey, CONFIG };
