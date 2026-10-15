---
name: tkbk-amocrm
description: amoCRM (Kommo) — сделки, контакты, примечания и задачи через MCP-сервер TKBK (tkbk-amo) или API v4 напрямую. Поиск сделки по телефону, примечание из переписки, выгрузка воронки.
license: Apache-2.0
metadata:
  author: TKBK
  version: "1.0"
  docs: https://github.com/tkbk-online/tkbk-mcp
---

# amoCRM / Kommo

Используй, когда задача про amoCRM: найти сделку или контакт, добавить примечание, завести сделку, собрать статистику по воронке, написать интеграцию.

## 1. Способ доступа

Предпочтительно — MCP-сервер `tkbk-amo` (сделки, контакты, примечание к сделке). Если его нет — предложи подключить:

```json
{
  "tkbk-amo": {
    "url": "https://mcp.tkbk.online/mcp/amo",
    "headers": {
      "Authorization": "Bearer cr_…",
      "x-amo-subdomain": "yourcompany",
      "x-amo-token": "…"
    }
  }
}
```

Локально: `npx -y github:tkbk-online/tkbk-mcp amocrm` с переменными `AMOCRM_DOMAIN` и `AMOCRM_TOKEN`. Поддомены `amocrm.ru`, `amocrm.com`, `kommo.com`.

Для кода интеграции — API v4: `https://<поддомен>.amocrm.ru/api/v4/...`, заголовок `Authorization: Bearer <долгосрочный токен>`. Токен читай только из переменных окружения и не печатай.

## 2. Полезные вызовы API v4

| Задача | Запрос | Заметки |
|---|---|---|
| Сделки | `GET /api/v4/leads?with=contacts&limit=250&page=N` | фильтры `filter[statuses][0][pipeline_id]`, `filter[statuses][0][status_id]`, `filter[updated_at][from]` |
| Сделка по id | `GET /api/v4/leads/{id}?with=contacts` | |
| Новая сделка | `POST /api/v4/leads` — массив объектов `{name, price, pipeline_id, status_id, _embedded:{contacts:[{id}]}}` | |
| Контакты | `GET /api/v4/contacts?query=<телефон или имя>` | поиск по `query` ищет и по телефону |
| Новый контакт | `POST /api/v4/contacts` — `{name, custom_fields_values:[{field_code:"PHONE", values:[{value, enum_code:"WORK"}]}]}` | |
| Примечание | `POST /api/v4/leads/notes` — `[{entity_id, note_type:"common", params:{text}}]` | |
| Задача | `POST /api/v4/tasks` — `[{text, complete_till, entity_id, entity_type:"leads", responsible_user_id}]` | `complete_till` — unix time |
| Воронки и статусы | `GET /api/v4/leads/pipelines` | id статусов нужны для фильтров и создания |
| Пользователи | `GET /api/v4/users` | для `responsible_user_id` |

Лимит — 7 запросов в секунду; на `429` подожди секунду и повтори. Ответы постраничные: следи за `_links.next`.

## 3. Правила

- Любое создание/изменение — после подтверждения с показом полей.
- Поиск клиента по переписке: сначала по телефону (`+7…`), затем по email, затем по имени; если нашлось несколько — покажи варианты, не выбирай сам.
- Примечание из переписки: 3–6 строк — кто, что хочет, срок, сумма (если есть), следующий шаг. Без копирования всей переписки.
- Статистика по воронке: количество и сумма сделок по статусам, средний чек, доля проигранных (`status_id` 143) и успешных (`status_id` 142).
- Не выводи телефоны и email клиентов в файлы без запроса пользователя.
