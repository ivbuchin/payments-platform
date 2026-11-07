#!/usr/bin/env bash
# Дымовой сценарий поверх запущенного `docker compose --profile app up`:
# счета → пополнение → платёж → capture → возврат → проверка вебхуков в журнале доставок.
set -euo pipefail

WALLET=${WALLET_URL:-http://localhost:3001}
PAYMENTS=${PAYMENTS_URL:-http://localhost:3002}
NOTIFY=${NOTIFICATIONS_URL:-http://localhost:3003}
# Запросы идут на локальные адреса — системный прокси для них не нужен.
CURL=(curl --noproxy '*' -fsS -H 'content-type: application/json')
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
field() { python3 -c "import sys, json; print(json.load(sys.stdin)['$1'])"; }

echo '1. Подписка на все события'
"${CURL[@]}" -X POST "$NOTIFY/webhooks" -d '{"url":"http://host.docker.internal:9/hook","eventTypes":["*"]}' >/dev/null

echo '2. Счета и пополнение'
PAYER=$("${CURL[@]}" -X POST "$WALLET/accounts" -d "{\"ownerId\":\"payer-$(uuid)\",\"currency\":\"RUB\"}" | field id)
MERCHANT=$("${CURL[@]}" -X POST "$WALLET/accounts" -d "{\"ownerId\":\"merchant-$(uuid)\",\"currency\":\"RUB\"}" | field id)
"${CURL[@]}" -X POST "$WALLET/accounts/$PAYER/deposits" -H "idempotency-key: $(uuid)" -d '{"amount":"100000"}' >/dev/null

echo '3. Платёж: авторизация → списание → возврат'
PAYMENT=$("${CURL[@]}" -X POST "$PAYMENTS/payments" -H "idempotency-key: $(uuid)" \
  -d "{\"payerAccountId\":\"$PAYER\",\"merchantAccountId\":\"$MERCHANT\",\"amount\":\"30000\",\"currency\":\"RUB\"}" | field id)
"${CURL[@]}" -X POST "$PAYMENTS/payments/$PAYMENT/capture" | field status
"${CURL[@]}" -X POST "$PAYMENTS/payments/$PAYMENT/refund" | field status

echo '4. Итоговые балансы'
"${CURL[@]}" "$WALLET/accounts/$PAYER" | field balance
"${CURL[@]}" "$WALLET/accounts/$MERCHANT" | field balance

echo '5. Журнал доставок (события дошли до notifications)'
sleep 3
"${CURL[@]}" "$NOTIFY/deliveries?limit=200" | python3 -c 'import sys, json; d = json.load(sys.stdin); print(len(d), "доставок в журнале")'
