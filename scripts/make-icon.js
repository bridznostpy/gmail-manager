'use strict';
/**
 * Генератор иконки приложения.
 *
 * Запуск: npm run icon
 *
 * Рисует логотип в скрытом окне Electron и снимает его в PNG. Так иконка
 * получается из той же разметки и тех же цветов, что и логотип в рельсе, и
 * не расходится с ним при смене фирменного цвета - в отличие от картинки,
 * нарисованной руками во внешнем редакторе.
 *
 * Результат: assets/icon.png (512x512) и assets/icon-256.png для панели задач.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'assets');
const SIZES = [512, 256];

// Те же цвета, что у --accent/--accent-2 по умолчанию (styles/theme.css).
const HTML = (size) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; background: transparent; }
  .icon {
    width: 100%; height: 100%; border-radius: ${Math.round(size * 0.22)}px;
    background: linear-gradient(135deg, #3ddc84, #16b364);
    display: grid; place-items: center;
    font-family: "Segoe UI", system-ui, sans-serif;
    font-weight: 800; letter-spacing: -0.06em;
    font-size: ${Math.round(size * 0.36)}px;
    color: #04120a;
    box-shadow: inset 0 ${Math.round(size * 0.02)}px ${Math.round(size * 0.06)}px rgba(255,255,255,0.35);
  }
</style></head><body><div class="icon">GM</div></body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Рисуем один раз в максимальном размере, остальные получаем уменьшением:
  // второе прозрачное окно в том же процессе загружается через раз, а
  // качество даунскейла у nativeImage достаточное для иконки.
  const base = SIZES[0];
  const win = new BrowserWindow({
    width: base, height: base, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
  });
  const tmp = path.join(app.getPath('temp'), 'gm-icon.html');
  fs.writeFileSync(tmp, HTML(base), 'utf-8');
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const shot = await win.webContents.capturePage();
  win.destroy();
  try { fs.unlinkSync(tmp); } catch (_e) {}

  for (const size of SIZES) {
    const img = size === base ? shot : nativeImage.createFromBuffer(shot.toPNG()).resize({ width: size, height: size, quality: 'best' });
    const name = size === base ? 'icon.png' : `icon-${size}.png`;
    fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
    console.log('written', path.join('assets', name));
  }

  app.quit();
});
