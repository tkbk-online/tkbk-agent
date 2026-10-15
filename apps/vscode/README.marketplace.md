<p align="center">
  <img src="assets/icons/icon.png" width="80" alt="TKBK Agent" />
</p>

<h1 align="center">TKBK Agent</h1>

<p align="center">
Автономный агент для кода в VS Code. Claude, GPT, DeepSeek, GLM и Grok — по одному ключу TKBK, оплата в рублях.
</p>

<p align="center">
<a href="https://tkbk.online">tkbk.online</a> ·
<a href="https://tkbk.online/login">Вход через Telegram</a> ·
<a href="https://tkbk.online/buy">Купить ключ</a> ·
<a href="https://github.com/tkbk-online/tkbk-mcp">MCP-серверы TKBK</a>
</p>

---

TKBK Agent пишет и правит файлы, запускает команды в терминале, работает с браузером и MCP-серверами — и спрашивает подтверждение на каждом шаге. Это сборка открытого агента [Cline](https://github.com/cline/cline) (Apache 2.0) под брендом TKBK: провайдер TKBK по умолчанию, вход через Telegram-бота, русский интерфейс первого запуска и стартовые скилы для российских сервисов.

## Установка за минуту

1. **Скачайте `.vsix`** из [релизов](https://github.com/tkbk-online/tkbk-agent/releases) (или соберите сами, см. ниже).
2. В VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → выберите файл. Или в терминале:

   ```bash
   code --install-extension tkbk-agent-0.1.0.vsix
   ```

3. Откройте TKBK Agent в боковой панели (иконка **TK**).
4. Нажмите **«Войти через Telegram-бота»** — откроется tkbk.online/login. Подтвердите вход в боте, скопируйте ключ `cr_…` из кабинета и вставьте его в поле «Ключ TKBK». Нет ключа — **«Купить ключ»**.
5. Выберите модель (по умолчанию Claude Sonnet 5) и нажмите **«Начать»**.

Готово: первая задача — просто опишите, что нужно сделать.

> Публикация в Open VSX и VS Code Marketplace готовится; после неё установка будет в один клик из каталога расширений. Инструкция для публикации — [docs/tkbk/OPEN-VSX.md](https://github.com/tkbk-online/tkbk-agent/blob/main/docs/tkbk/OPEN-VSX.md).

## Модели

Провайдер **TKBK** ходит на `https://api.tkbk.online/v1`: Claude — через Anthropic Messages (`/v1/messages`, кэш промптов и расширенное мышление), остальные — через OpenAI-совместимый `/v1/chat/completions`. Протокол выбирается по модели автоматически.

| Модель | Для чего |
|---|---|
| `claude-sonnet-5` | повседневный код, по умолчанию |
| `claude-opus-5-5`, `claude-fable-5-1` | сложная архитектура и отладка |
| `gpt-6.1-sol` | GPT-линейка |
| `deepseek-v4-pro` | экономичный вариант с рассуждением |
| `glm-5.3` | экономичный вариант |
| `grok-4.7` | Grok |

После сохранения ключа список дополняется живым каталогом `GET https://api.tkbk.online/v1/models`; любой id можно ввести вручную. Цены в интерфейсе показаны в долларах объёма — так же списывается баланс в кабинете TKBK.

**Свой ключ другого провайдера** (OpenAI, Anthropic, Gemini, OpenRouter, Ollama и ещё ~60) — выберите его в списке провайдеров: всё, что умеет Cline, осталось на месте.

## Скилы

Скилы — инструкции в формате `SKILL.md` ([Agent Skills](https://agentskills.io), как у vercel-labs/skills). Агент подхватывает их из:

- `<проект>/.tkbk/skills/<имя>/SKILL.md` — скилы проекта;
- `~/.tkbk/skills/<имя>/SKILL.md` — ваши глобальные скилы;
- а также из `.cline/skills`, `.claude/skills`, `.agents/skills` — совместимость с Cline и Claude Code.

При первом запуске TKBK Agent кладёт в `~/.tkbk/skills` пять стартовых скилов (и больше никогда их не перезаписывает):

| Скил | Что делает |
|---|---|
| `tkbk-marketplaces` | Wildberries и Ozon через MCP TKBK: заказы, остатки, цены, отзывы |
| `tkbk-bitrix24` | Битрикс24: лиды, сделки, задачи, выборки по воронке |
| `tkbk-amocrm` | amoCRM / Kommo: сделки, контакты, примечания |
| `tkbk-review-reply` | ответ на отзыв покупателя от имени магазина |
| `tkbk-tech-spec` | техзадание из переписки с заказчиком |

Переменная `TKBK_DIR` переопределяет домашнюю папку `~/.tkbk`.

## MCP-серверы TKBK

Wildberries, Ozon, Яндекс Маркет, Битрикс24, amoCRM, Авито, Яндекс Директ, Метрика, Вебмастер, DaData — хостинг `https://mcp.tkbk.online/mcp/<сервис>` по тому же ключу `cr_…` или локально через `npx`. Подключение описано в [tkbk-online/tkbk-mcp](https://github.com/tkbk-online/tkbk-mcp); в расширении серверы добавляются в разделе «MCP-серверы».

## Сборка из исходников

Нужны [Bun](https://bun.com) ≥ 1.4 и Node ≥ 22.

```bash
git clone https://github.com/tkbk-online/tkbk-agent
cd tkbk-agent
bun install
bun run build:sdk
cd apps/vscode
bun run protos
bun run download-ripgrep
bun run package
bunx vsce package --no-dependencies --out tkbk-agent-0.1.0.vsix
```

На Windows встроенный `protoc` из `grpc-tools` может не запускаться (собран с отладочной библиотекой); положите официальный `protoc.exe` из [релизов protobuf](https://github.com/protocolbuffers/protobuf/releases) в `apps/vscode/tmp-protoc/bin/` — скрипт сборки подхватит его сам.

Тесты: `bun run test:unit` (расширение), `cd webview-ui && bun run test` (интерфейс), в `sdk/packages/*` — `bun run test`.

## Что изменено относительно Cline

- `@cline/llms`: провайдер `tkbk` (base URL `https://api.tkbk.online/v1`, встроенный каталог семи моделей, маршрутизация протокола по модели).
- `@cline/core`: живой каталог моделей TKBK из `GET /v1/models` по ключу.
- `@cline/shared`: пути скилов `.tkbk/skills` и `~/.tkbk/skills`.
- Расширение: провайдер TKBK по умолчанию, экран первого запуска на русском с входом через Telegram-бота, кнопки «Войти через Telegram-бота» / «Купить ключ», стартовые скилы, иконка и тексты TKBK, id расширения `tkbk-online.tkbk-agent`.

Телеметрия Cline в этой сборке не включена: ключи аналитики в сборку не подставляются.

## Лицензия

Apache License 2.0. TKBK Agent основан на [Cline](https://github.com/cline/cline) © Cline Bot Inc.; см. [LICENSE](https://github.com/tkbk-online/tkbk-agent/blob/main/apps/vscode/LICENSE) и [NOTICE](https://github.com/tkbk-online/tkbk-agent/blob/main/NOTICE). Товарные знаки TKBK принадлежат TKBK.
