import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AppModule as NotificationsModule } from '../apps/notifications-service/src/app.module';
import { configureApp } from '../apps/notifications-service/src/app.setup';
import { verifySignatureHeader } from '../apps/notifications-service/src/delivery/signing';
import { AppModule as PaymentsModule } from '../apps/payments-service/src/app.module';
import { AppModule as WalletModule } from '../apps/wallet-service/src/app.module';

/**
 * Сквозной сценарий на реальной инфраструктуре: PostgreSQL, RabbitMQ и три сервиса,
 * общающиеся по HTTP и через события. Проверяет всю цепочку:
 * платёж → резерв в wallet → outbox → RabbitMQ → inbox → подписанный вебхук.
 */

interface Hook {
  type: string;
  payload: Record<string, unknown>;
  signatureOk: boolean;
}

let pg: StartedPostgreSqlContainer;
let mq: StartedRabbitMQContainer;
let wallet: INestApplication;
let payments: INestApplication;
let notifications: INestApplication;
let receiverServer: Server;
let webhookSecret: string;
const hooks: Hook[] = [];
const urls = {} as { wallet: string; payments: string; notifications: string; receiver: string };

const dbUrl = (db: string) => {
  const u = new URL(pg.getConnectionUri());
  u.pathname = `/${db}`;
  return u.toString();
};

async function boot(
  module: { forRoot: unknown } | object,
  configure?: (app: INestApplication) => void,
) {
  const moduleRef = await Test.createTestingModule({ imports: [module as never] }).compile();
  const app = moduleRef.createNestApplication();
  if (configure) configure(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

async function api<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  key?: string,
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function eventually<T>(probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('eventually: таймаут ожидания');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  [pg, mq] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RabbitMQContainer('rabbitmq:4-alpine').start(),
  ]);
  for (const db of ['wallet', 'payments', 'notifications']) {
    await pg.exec(['psql', '-U', pg.getUsername(), '-c', `CREATE DATABASE ${db}`]);
  }
  const amqpUrl = mq.getAmqpUrl();

  receiverServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const event = JSON.parse(body) as { type: string; payload: Record<string, unknown> };
      hooks.push({
        type: event.type,
        payload: event.payload,
        signatureOk: verifySignatureHeader(
          webhookSecret,
          String(req.headers['x-pp-signature']),
          body,
          Math.floor(Date.now() / 1000),
        ),
      });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiverServer.listen(0, '127.0.0.1', r));
  urls.receiver = `http://127.0.0.1:${(receiverServer.address() as AddressInfo).port}/hook`;

  const { configureApp: configureWallet } = await import('../apps/wallet-service/src/app.setup');
  wallet = await boot(WalletModule.forRoot(dbUrl('wallet'), amqpUrl), configureWallet);
  urls.wallet = await wallet.getUrl();

  const { configureApp: configurePayments } =
    await import('../apps/payments-service/src/app.setup');
  payments = await boot(
    PaymentsModule.forRoot({ databaseUrl: dbUrl('payments'), walletUrl: urls.wallet, amqpUrl }),
    configurePayments,
  );
  urls.payments = await payments.getUrl();

  notifications = await boot(
    NotificationsModule.forRoot({
      databaseUrl: dbUrl('notifications'),
      amqpUrl,
      allowPrivateWebhookTargets: true,
      delivery: {
        maxAttempts: 5,
        baseDelayMs: 50,
        maxDelayMs: 500,
        timeoutMs: 2000,
        batchSize: 20,
        leaseMs: 30_000,
        pollIntervalMs: 100,
        autoStart: true,
      },
    }),
    configureApp,
  );
  urls.notifications = await notifications.getUrl();

  const hook = await api<{ secret: string }>(urls.notifications, 'POST', '/webhooks', {
    url: urls.receiver,
    eventTypes: ['*'],
  });
  expect(hook.status).toBe(201);
  webhookSecret = hook.body.secret;
});

afterAll(async () => {
  await Promise.allSettled([wallet?.close(), payments?.close(), notifications?.close()]);
  await new Promise<void>((r) => (receiverServer ? receiverServer.close(() => r()) : r()));
  await Promise.allSettled([pg?.stop(), mq?.stop()]);
});

describe('платёж через всю платформу', () => {
  it('create → capture → refund приводит к подписанным вебхукам по каждому шагу', async () => {
    const open = async (ownerId: string) =>
      (await api<{ id: string }>(urls.wallet, 'POST', '/accounts', { ownerId, currency: 'RUB' }))
        .body.id;
    const payer = await open('payer');
    const merchant = await open('merchant');
    await api(
      urls.wallet,
      'POST',
      `/accounts/${payer}/deposits`,
      { amount: '100000' },
      randomUUID(),
    );

    const created = await api<{ id: string; status: string }>(
      urls.payments,
      'POST',
      '/payments',
      { payerAccountId: payer, merchantAccountId: merchant, amount: '30000', currency: 'RUB' },
      randomUUID(),
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('authorized');
    const paymentId = created.body.id;

    // Резерв реально лёг в wallet-service.
    const reserved = await api<{ held: string; available: string }>(
      urls.wallet,
      'GET',
      `/accounts/${payer}`,
    );
    expect(reserved.body).toMatchObject({ held: '30000', available: '70000' });

    expect((await api(urls.payments, 'POST', `/payments/${paymentId}/capture`)).status).toBe(200);
    expect((await api(urls.payments, 'POST', `/payments/${paymentId}/refund`)).status).toBe(200);

    const merchantAfter = await api<{ balance: string }>(
      urls.wallet,
      'GET',
      `/accounts/${merchant}`,
    );
    const payerAfter = await api<{ balance: string }>(urls.wallet, 'GET', `/accounts/${payer}`);
    expect(merchantAfter.body.balance).toBe('0');
    expect(payerAfter.body.balance).toBe('100000');

    // Все четыре статуса платежа дошли до подписчика, и подпись каждого верна.
    const statusesOf = () =>
      hooks.filter((h) => h.type === 'payment.status_changed' && h.payload.paymentId === paymentId);
    await eventually(() => (statusesOf().length >= 4 ? true : undefined));
    expect(new Set(statusesOf().map((h) => h.payload.status))).toEqual(
      new Set(['created', 'authorized', 'captured', 'refunded']),
    );

    // События wallet тоже пришли (подписка на *).
    await eventually(() =>
      hooks.some((h) => h.type === 'wallet.hold.captured') ? true : undefined,
    );
    expect(hooks.every((h) => h.signatureOk)).toBe(true);
  });

  it('недостаточно средств: платёж failed, резерв не создан, вебхук о неудаче доставлен', async () => {
    const open = async (ownerId: string) =>
      (await api<{ id: string }>(urls.wallet, 'POST', '/accounts', { ownerId, currency: 'RUB' }))
        .body.id;
    const payer = await open('poor-payer');
    const merchant = await open('poor-merchant');

    const created = await api<{ id: string; status: string; failureReason: string }>(
      urls.payments,
      'POST',
      '/payments',
      { payerAccountId: payer, merchantAccountId: merchant, amount: '500', currency: 'RUB' },
      randomUUID(),
    );
    expect(created.body).toMatchObject({ status: 'failed', failureReason: 'INSUFFICIENT_FUNDS' });

    await eventually(() =>
      hooks.find((h) => h.payload.paymentId === created.body.id && h.payload.status === 'failed'),
    );
    const wallet_ = await api<{ held: string }>(urls.wallet, 'GET', `/accounts/${payer}`);
    expect(wallet_.body.held).toBe('0');
  });
});
