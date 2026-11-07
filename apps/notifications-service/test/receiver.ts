import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Локальный получатель вебхуков: записывает запросы и отвечает заданными статусами по очереди. */
export class Receiver {
  readonly requests: ReceivedRequest[] = [];
  /** Статусы для ближайших запросов; когда очередь пуста — отвечает 200. */
  statuses: number[] = [];
  /** Задержка ответа, мс: делает окно гонки между воркерами заметным. */
  delayMs = 0;
  private server!: Server;
  url!: string;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = this.statuses.shift() ?? 200;
        setTimeout(() => res.end('ok'), this.delayMs);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hook`;
  }

  reset(): void {
    this.requests.length = 0;
    this.statuses = [];
    this.delayMs = 0;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
