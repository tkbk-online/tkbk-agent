# Публикация TKBK Agent в Open VSX (инструкция для владельца)

Open VSX — открытый каталог расширений, из него ставят расширения VSCodium, Cursor, Windsurf, Gitpod и другие форки VS Code. Публикация бесплатная, аккаунт нужен один раз. VS Code Marketplace (Microsoft) — отдельная история, см. последний раздел; туда **не публикуем без вашего подтверждения**.

## 1. Аккаунт и namespace (10 минут, один раз)

1. Откройте https://open-vsx.org и нажмите **Log in** → вход через GitHub. Войдите аккаунтом, который владеет организацией `tkbk-online` (сейчас это `berdniko9544-gif`).
2. Откройте профиль → **Settings** → **Publisher Agreement**: прочитайте и примите (Eclipse Foundation Open VSX Publisher Agreement). Без него публикация отклоняется.
3. Там же **Access Tokens** → **Generate New Token**, название `tkbk-agent-publish`. Скопируйте токен сразу — он показывается один раз. Храните его как секрет (GitHub Actions secret `OVSX_PAT`), не в репозитории.
4. Создайте namespace — он должен совпадать с `publisher` в `apps/vscode/package.json`, то есть `tkbk-online`:

   ```bash
   npx ovsx create-namespace tkbk-online --pat <ваш токен>
   ```

5. (Желательно) Подтвердите владение namespace: https://github.com/EclipseFdn/open-vsx.org/issues/new/choose → «Publisher claim» — укажите namespace `tkbk-online`, ссылку на https://github.com/tkbk-online и на https://tkbk.online. После подтверждения у расширения появится галочка «verified».

## 2. Публикация

Соберите `.vsix` (или возьмите из GitHub Release):

```bash
cd apps/vscode
bun run package
bunx vsce package --no-dependencies --out tkbk-agent-0.1.0.vsix
```

Опубликуйте:

```bash
npx ovsx publish --packagePath tkbk-agent-0.1.0.vsix --pat <ваш токен>
```

Через 1–2 минуты расширение появится на https://open-vsx.org/extension/tkbk-online/tkbk-agent, и его можно будет ставить из каталога в VSCodium/Cursor и по ссылке.

Обновление версии: поменяйте `version` в `apps/vscode/package.json`, пересоберите, снова `ovsx publish`. Одну и ту же версию опубликовать повторно нельзя.

## 3. Что проверить перед первой публикацией

- [ ] Финальная иконка `apps/vscode/assets/icons/icon.png` (128×128 PNG) — сейчас взята из логотипа сайта (`public/icon-512.png`), при желании заменить на отрисованную специально.
- [ ] `displayName`, `description`, ссылки в `apps/vscode/package.json`.
- [ ] README расширения (`apps/vscode/README.md` — он же попадает на страницу каталога).
- [ ] Ключ `cr_…` тестового аккаунта: пройти путь «Войти через Telegram-бота → вставить ключ → задача на Claude Sonnet 5 → задача на gpt-6.1-sol».

## 4. VS Code Marketplace (Microsoft) — только по решению владельца

Для Marketplace нужны аккаунт Azure DevOps, Personal Access Token с правами Marketplace → Manage и publisher `tkbk-online` на https://marketplace.visualstudio.com/manage. Публикация:

```bash
npx vsce publish --no-dependencies --packagePath tkbk-agent-0.1.0.vsix --pat <PAT Azure DevOps>
```

Marketplace проверяет расширения модерацией и требует, чтобы `publisher` совпадал с вашим publisher id. Делать это стоит после обкатки в Open VSX и после решения владельца.
