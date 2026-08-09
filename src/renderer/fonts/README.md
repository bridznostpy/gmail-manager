# Шрифты

Оба лежат локально: политика безопасности окна разрешает `font-src 'self'`,
внешние CDN не подтянутся.

| Файлы | Шрифт | Где применяется | Лицензия |
|---|---|---|---|
| `JetBrainsMono-*.woff2` | JetBrains Mono | логи, счётчики, порты, User-Agent - везде, где важно выравнивание по колонкам | SIL OFL 1.1, текст в `OFL.txt` |
| `inter-latin-wght-normal.woff2`, `inter-cyrillic-wght-normal.woff2` | Inter Variable | заголовки, кнопки, подписи интерфейса | SIL OFL 1.1, https://github.com/rsms/inter |

Inter взят двумя сабсетами (латиница и кириллица) в переменном начертании:
интерфейс двуязычный, а одна переменная ось веса заменяет четыре отдельных
файла. Подключение и `unicode-range` - в `styles/theme.css`.
