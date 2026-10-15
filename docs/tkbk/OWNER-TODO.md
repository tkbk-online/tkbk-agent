# TKBK Agent — что требует владельца

Состояние на 15.10.2026, версия 0.1.0 (первая сборка).

## Нужно сделать владельцу

| # | Что | Зачем | Где описано |
|---|---|---|---|
| 1 | Аккаунт Open VSX, принять Publisher Agreement, создать namespace `tkbk-online`, токен `OVSX_PAT` | Публикация в открытый каталог (VSCodium, Cursor, Windsurf) | [OPEN-VSX.md](OPEN-VSX.md) |
| 2 | Решение по VS Code Marketplace (Microsoft): нужен ли, когда | Marketplace требует Azure DevOps-аккаунт и модерацию; без подтверждения не публикуем | [OPEN-VSX.md](OPEN-VSX.md), раздел 4 |
| 3 | Финальная иконка 128×128 | Сейчас — уменьшенный `public/icon-512.png` с сайта; иконка в боковой панели — монограмма TK из `Logo.tsx` | `apps/vscode/assets/icons/icon.png`, `icon.svg` |
| 4 | Тест с реальным ключом `cr_…` | Проверить вход, живой список моделей (`GET /v1/models`), задачу на Claude и на GPT; сессия сборки ключа не имеет | Настройки → провайдер TKBK |
| 5 | Страница `/docs` на сайте или другой адрес для «Документации» | В расширении ссылка `https://tkbk.online/docs`; если страницы нет — поправить `TKBK_DOCS_URL` в `TkbkProvider.tsx` и `docsUrl` в `builtins.ts` | — |
| 6 | Решить, нужна ли телеметрия | Сейчас аналитика Cline отключена (ключи не подставляются в сборку). Своя телеметрия — отдельная задача | — |
| 7 | Релиз на GitHub | Загрузить `.vsix` в Releases репозитория `tkbk-online/tkbk-agent`, чтобы ссылка из README заработала | — |

## Что сделано

- Форк `cline/cline` → `tkbk-online/tkbk-agent`, лицензия Apache 2.0 и NOTICE с атрибуцией Cline.
- Провайдер **TKBK** по умолчанию: `https://api.tkbk.online/v1`, Claude через Anthropic Messages, остальные через OpenAI-совместимый endpoint, каталог из 7 моделей + живой `GET /v1/models` по ключу.
- Кнопки «Войти через Telegram-бота» (tkbk.online/login) и «Купить ключ» (tkbk.online/buy) в настройках провайдера и на экране первого запуска; экран первого запуска на русском.
- BYOK-провайдеры Cline (OpenAI, Anthropic, Gemini, OpenRouter, Ollama и др.) сохранены.
- Скилы `SKILL.md` из `.tkbk/skills` проекта и `~/.tkbk/skills`; пять стартовых скилов ставятся при первом запуске.
- Бренд: имя «TKBK Agent», publisher `tkbk-online`, id `tkbk-online.tkbk-agent`, иконки, русские названия команд и walkthrough, кнопка аккаунта Cline скрыта.
- Тесты: провайдер TKBK (llms), живой каталог (core), пути скилов (shared), установщик скилов и UI провайдера (расширение).

## Известные ограничения первой версии

- Внутри интерфейса остаётся много английских текстов Cline (настройки, чат, подсказки). Переведены: первый запуск, настройки TKBK, команды, walkthrough, манифест.
- Пункт «Аккаунт» (Cline Account) убран из панели, но провайдеры `cline` и `cline-pass` остались в списке — это аккаунт Cline, не TKBK.
- CLI (`apps/cli`), JetBrains-плагин и настольное приложение из монорепозитория Cline не ребрендированы — только расширение VS Code.
- Синхронизация с upstream Cline: ветка `main` форка содержит правки TKBK поверх upstream; при обновлении делать `git merge upstream/main` и прогонять тесты.
