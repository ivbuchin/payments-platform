# payments-platform

Учебная платёжная платформа из трёх микросервисов на **TypeScript · NestJS · PostgreSQL**.
Цель проекта — показать, как строятся надёжные денежные потоки: двойная запись, идемпотентность,
защита от гонок, transactional outbox, inbox-дедупликация и доставка вебхуков с ретраями.

```mermaid
flowchart LR
    C([Клиент]) -->|REST + Idempotency-Key| P[payments-service]
    P -->|HTTP, идемпотентные ключи| W[wallet-service]
    W -- outbox --> MQ{{RabbitMQ<br/>pp.events}}
    P -- outbox --> MQ
    MQ -->|inbox, дедупликация| N[notifications-service]
    N -->|HMAC-подписанный вебхук<br/>ретраи, backoff, DLQ| M([Система мерчанта])
    W --- DW[(PostgreSQL wallet)]
    P --- DP[(PostgreSQL payments)]
    N --- DN[(PostgreSQL notifications)]
```

| Сервис                              | Ответственность                      | Ключевые решения                                                                               |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **wallet-service** (`:3001`)        | Счета, переводы, резервы (holds)     | Двойная запись, `SELECT … FOR UPDATE` в едином порядке, CHECK-инварианты в БД, идемпотентность |
| **payments-service** (`:3002`)      | Жизненный цикл платежа поверх wallet | Конечный автомат, compare-and-set переходов, дообработка после сбоев                           |
| **notifications-service** (`:3003`) | Подписки и доставка вебхуков         | Inbox, `SKIP LOCKED` + lease, backoff с джиттером, HMAC, защита от SSRF                        |

Общий код — в `libs/`: `contracts` (типы событий), `nest-kit` (идемпотентность, ошибки, деньги), `outbox` (запись и релей в RabbitMQ).
Решения и компромиссы описаны в [ADR](docs/adr).

## Быстрый старт

Нужны Node 22+, pnpm и Docker.

```bash
pnpm install
docker compose --profile app up -d --build   # Postgres, RabbitMQ и три сервиса
./scripts/smoke.sh                            # платёж от пополнения до возврата
```

Swagger: <http://localhost:3001/docs>, <http://localhost:3002/docs>, <http://localhost:3003/docs>.
Режим разработки: `pnpm infra:up`, затем `pnpm build` и `pnpm --filter @pp/wallet-service dev` (переменные — в `.env.example`).

## Пример

```bash
# 1. Счета и пополнение (суммы — строки в копейках)
curl -X POST :3001/accounts -H 'content-type: application/json' -d '{"ownerId":"u1","currency":"RUB"}'
curl -X POST :3001/accounts/$PAYER/deposits -H "idempotency-key: $(uuidgen)" \
     -H 'content-type: application/json' -d '{"amount":"100000"}'

# 2. Платёж: авторизация резервирует средства, capture списывает, refund возвращает
curl -X POST :3002/payments -H "idempotency-key: $(uuidgen)" -H 'content-type: application/json' \
     -d '{"payerAccountId":"…","merchantAccountId":"…","amount":"30000","currency":"RUB"}'
curl -X POST :3002/payments/$ID/capture
curl -X POST :3002/payments/$ID/refund
```

Повтор любого запроса с тем же `Idempotency-Key` безопасен: вернётся прежний результат, деньги не задвоятся.
Тот же ключ с другими параметрами — `409 IDEMPOTENCY_KEY_REUSED`.

## Проверка

```bash
pnpm lint && pnpm build && pnpm test
```

Тесты используют **реальные** PostgreSQL и RabbitMQ через Testcontainers (нужен Docker):

- wallet — переводы, холды, гонки (20 параллельных списаний с баланса на 10), встречные переводы без deadlock, инвариант «сумма балансов = 0» и «баланс = сумма проводок»;
- payments — полный цикл, недопустимые переходы, обрыв связи с wallet и дообработка, параллельные capture;
- notifications — дедупликация, фильтры, ретраи, dead-letter и ручной retry, подпись, запрет редиректов;
- `e2e/` — три сервиса и RabbitMQ вместе: платёж → резерв → outbox → брокер → inbox → подписанный вебхук.

## Структура

```
apps/wallet-service · payments-service · notifications-service
libs/contracts · nest-kit · outbox
e2e/        сквозные тесты платформы
docs/adr/   архитектурные решения
```

## Ограничения (осознанные)

- Нет аутентификации и авторизации — на границе платформы ожидается API-gateway.
- Секреты вебхуков хранятся в БД открытым текстом (нужны для подписи); в продакшене — шифрование через KMS.
- Защита от SSRF проверяет адрес в URL; от DNS rebinding нужен резолв с проверкой IP перед отправкой.
- Системный счёт валюты сериализует пополнения этой валюты (см. ADR-0002).
