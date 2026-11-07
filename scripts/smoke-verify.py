#!/usr/bin/env python3
"""Проверка итогов smoke.sh: каждый вебхук подписан верно, а журнал доставок согласован с приёмником.

Аргументы: файл журнала приёмника, секрет подписки, id подписки, URL notifications-service.
"""
import hashlib
import hmac
import json
import sys
import time
import urllib.request

log_path, secret, endpoint_id, notify = sys.argv[1:5]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # только localhost


def received():
    try:
        with open(log_path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []


def final_event_seen(items):
    for item in items:
        payload = json.loads(item["body"]).get("payload", {})
        if payload.get("status") == "refunded":
            return True
    return False


deadline = time.time() + 40
while time.time() < deadline and not final_event_seen(received()):
    time.sleep(1)

items = received()
if not final_event_seen(items):
    sys.exit(f"FAIL: итоговое событие payment refunded не дошло до получателя (получено {len(items)})")

for item in items:
    header = item["headers"].get("X-PP-Signature") or item["headers"].get("x-pp-signature", "")
    parts = dict(p.split("=", 1) for p in header.split(","))
    expected = hmac.new(secret.encode(), f"{parts['t']}.{item['body']}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, parts.get("v1", "")):
        sys.exit("FAIL: неверная подпись вебхука")

event_ids = {item["headers"].get("X-PP-Event-Id") or item["headers"].get("x-pp-event-id") for item in items}

with opener.open(f"{notify}/deliveries?limit=200") as response:
    mine = [d for d in json.load(response) if d["endpointId"] == endpoint_id]
dead = [d for d in mine if d["status"] == "dead"]
delivered = {d["eventId"] for d in mine if d["status"] == "delivered"}
if dead:
    sys.exit(f"FAIL: {len(dead)} доставок в статусе dead")
if not event_ids <= delivered:
    sys.exit("FAIL: получатель видел событие, которое журнал не считает доставленным")

print(f"OK: получено {len(items)} запросов, {len(event_ids)} событий, все подписи верны, dead=0")
