'use strict';
/**
 * Per-profile browser fingerprint.
 *
 * Each profile gets a stable, randomised identity generated once and stored
 * with the profile. Применяется он в два приёма:
 *
 * 1. `contextOptions(fp)` - то, что Playwright умеет на уровне браузера
 *    (user-agent, локаль, часовой пояс). Это честнее подмены из JS: заголовки
 *    запросов и Intl совпадают с тем, что видит страница.
 * 2. `injectionScript(fp)` - остаток, которого в опциях нет (platform, железо,
 *    экран, WebGL). Ставится через `context.addInitScript`, то есть до любого
 *    скрипта сайта и во всех вкладках профиля.
 *
 * Это прагматичный фингерпринт, а не антидетект-стек: задача - чтобы инстансы
 * выглядели раздельно, а не чтобы обмануть специализированную проверку.
 */

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

// Small deterministic PRNG so a given seed always yields the same fingerprint.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHROME_VERSIONS = ['122.0.6261.94', '123.0.6312.86', '124.0.6367.60', '125.0.6422.60'];
const PLATFORMS = [
  { platform: 'Win32', ua: 'Windows NT 10.0; Win64; x64', uaPlatform: 'Windows' },
  { platform: 'MacIntel', ua: 'Macintosh; Intel Mac OS X 10_15_7', uaPlatform: 'macOS' },
];
const SCREENS = [
  { width: 1920, height: 1080 }, { width: 1536, height: 864 },
  { width: 1440, height: 900 }, { width: 2560, height: 1440 },
];
const VENDORS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Denver'];
const LANGS = [['en-US', 'en'], ['en-GB', 'en'], ['en-US', 'en', 'es']];
const HW = [4, 8, 12, 16];
const MEM = [4, 8, 16];

function generate(seed) {
  const s = typeof seed === 'number' ? seed : Math.floor(Math.random() * 1e9);
  const rnd = mulberry32(s);
  const os = pick(PLATFORMS, rnd);
  const ver = pick(CHROME_VERSIONS, rnd);
  const screen = pick(SCREENS, rnd);
  const gpu = pick(VENDORS, rnd);
  const userAgent = `Mozilla/5.0 (${os.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
  return {
    seed: s,
    userAgent,
    platform: os.platform,
    uaPlatform: os.uaPlatform,
    chromeVersion: ver,
    screen,
    languages: pick(LANGS, rnd),
    timezone: pick(TIMEZONES, rnd),
    hardwareConcurrency: pick(HW, rnd),
    deviceMemory: pick(MEM, rnd),
    webgl: gpu,
  };
}

/**
 * Опции контекста Playwright. Здесь всё, что браузер умеет подменить сам:
 * user-agent уходит и в заголовок запроса, timezoneId правит Date и Intl,
 * locale - заголовок Accept-Language.
 *
 * `viewport: null` обязателен: иначе Playwright фиксирует вьюпорт 1280x720 и
 * окно профиля перестаёт вести себя как обычное окно Chrome, которое
 * пользователь может растянуть.
 */
function contextOptions(fp) {
  return {
    userAgent: fp.userAgent,
    locale: fp.languages[0],
    timezoneId: fp.timezone,
    viewport: null,
  };
}

/** JS injected into every new document to enforce the fingerprint. */
function injectionScript(fp) {
  return `(() => {
    // Скрипт может прийти во вкладку дважды (например, при переустановке
    // init-скрипта). Второй проход обернул бы getParameter сам на себя.
    try { if (window.__gmFpApplied) return; window.__gmFpApplied = true; } catch (e) { return; }
    const fp = ${JSON.stringify(fp)};
    const def = (obj, prop, val) => {
      try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (e) {}
    };
    // Автоматизационные флаги Chrome мы гасим при запуске, так что webdriver
    // тоже должен выглядеть как у обычного браузера - иначе одно противоречит
    // другому.
    def(navigator, 'webdriver', undefined);
    def(navigator, 'platform', fp.platform);
    def(navigator, 'hardwareConcurrency', fp.hardwareConcurrency);
    def(navigator, 'deviceMemory', fp.deviceMemory);
    // Опция locale задаёт ОДИН язык, а в фингерпринте их два-три - список
    // навешиваем здесь, иначе navigator.languages разошёлся бы с карточкой.
    def(navigator, 'languages', Object.freeze(fp.languages.slice()));
    def(navigator, 'language', fp.languages[0]);
    try {
      const gl = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (p) {
        if (p === 37445) return fp.webgl.vendor;   // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return fp.webgl.renderer;  // UNMASKED_RENDERER_WEBGL
        return gl.call(this, p);
      };
    } catch (e) {}
    def(screen, 'width', fp.screen.width);
    def(screen, 'height', fp.screen.height);
    def(screen, 'availWidth', fp.screen.width);
    def(screen, 'availHeight', fp.screen.height - 40);
  })();`;
}

module.exports = { generate, contextOptions, injectionScript };
