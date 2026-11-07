#!/usr/bin/env python3
"""Приёмник вебхуков для smoke.sh: пишет каждый запрос (заголовки и тело) строкой JSON в файл."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port, log_path = int(sys.argv[1]), sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(json.dumps({"headers": dict(self.headers), "body": body}) + "\n")
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_):
        pass


HTTPServer(("0.0.0.0", port), Handler).serve_forever()
