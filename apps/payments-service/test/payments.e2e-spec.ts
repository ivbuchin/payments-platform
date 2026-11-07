import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { startTestApp, type TestApp } from './test-app';

let t: TestApp;
const http = () => request(t.url);

/** Пара «плательщик с деньгами + мерчант» в модели wallet. */
function parties(balance = 100_000n, currency = 'RUB') {
  const payer = randomUUID();
  const merchant = randomUUID();
  t.wallet.open(payer, balance, currency);
  t.wallet.open(merchant, 0n, currency);
  return { payer, merchant };
}

const createPayment = (
  p: { payer: string; merchant: string },
  amount = '25000',
  key: string = randomUUID(),
  currency = 'RUB',
) =>
  http()
    .post('/payments')
    .set('Idempotency-Key', key)
    .send({ payerAccountId: p.payer, merchantAccountId: p.merchant, amount, currency });

const statuses = async (paymentId: string): Promise<string[]> => {
  const rows: { status: string }[] = await t.dataSource.query(
    `SELECT payload->>'status' AS status FROM outbox_events
     WHERE payload->>'paymentId' = $1 ORDER BY occurred_at, id`,
    [paymentId],
  );
  return rows.map((r) => r.status);
};

beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.stop();
});
beforeEach(() => {
  t.wallet.failNextCalls = 0;
});

describe('жизненный цикл платежа', () => {
  it('create → capture → refund проходит весь путь и двигает деньги', async () => {
    const p = parties();
    const created = await createPayment(p).expect(201);
    expect(created.body.status).toBe('authorized');

    const captured = await http().post(`/payments/${created.body.id}/capture`).expect(200);
    expect(captured.body.status).toBe('captured');
    expect(t.wallet.balanceOf(p.merchant)).toBe(25000n);

    const refunded = await http().post(`/payments/${created.body.id}/refund`).expect(200);
    expect(refunded.body.status).toBe('refunded');
    expect(t.wallet.balanceOf(p.payer)).toBe(100000n);
    expect(t.wallet.balanceOf(p.merchant)).toBe(0n);

    const view = (await http().get(`/payments/${created.body.id}`).expect(200)).body;
    expect(view.history.map((h: { from: string; to: string }) => `${h.from}>${h.to}`)).toEqual([
      'created>authorized',
      'authorized>captured',
      'captured>refunded',
    ]);
    expect(await statuses(created.body.id)).toEqual([
      'created',
      'authorized',
      'captured',
      'refunded',
    ]);
  });

  it('cancel снимает резерв; после него capture невозможен', async () => {
    const p = parties();
    const { body } = await createPayment(p).expect(201);

    await http().post(`/payments/${body.id}/cancel`).expect(200);
    await http().post(`/payments/${body.id}/cancel`).expect(200);
    expect(t.wallet.balanceOf(p.payer)).toBe(100000n);

    const res = await http().post(`/payments/${body.id}/capture`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_STATE_CONFLICT');
  });

  it('запрещает недопустимые переходы', async () => {
    const p = parties();
    const { body } = await createPayment(p).expect(201);

    expect((await http().post(`/payments/${body.id}/refund`)).body.code).toBe(
      'PAYMENT_STATE_CONFLICT',
    );
    await http().post(`/payments/${body.id}/capture`).expect(200);
    expect((await http().post(`/payments/${body.id}/cancel`)).body.code).toBe(
      'PAYMENT_STATE_CONFLICT',
    );
  });

  it('недостаточно средств → платёж failed с причиной, деньги не тронуты', async () => {
    const p = parties(1000n);
    const res = await createPayment(p, '25000').expect(201);

    expect(res.body).toMatchObject({ status: 'failed', failureReason: 'INSUFFICIENT_FUNDS' });
    expect(t.wallet.balanceOf(p.payer)).toBe(1000n);
    expect((await http().post(`/payments/${res.body.id}/capture`)).status).toBe(409);
  });

  it('несовпадение валюты → failed и резерв снят', async () => {
    const p = parties(100_000n, 'USD');
    const res = await createPayment(p, '100', randomUUID(), 'RUB').expect(201);

    expect(res.body).toMatchObject({ status: 'failed', failureReason: 'CURRENCY_MISMATCH' });
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(0n);
  });

  it('отклонённый возврат (у мерчанта нет денег) не меняет статус', async () => {
    const p = parties();
    const { body } = await createPayment(p).expect(201);
    await http().post(`/payments/${body.id}/capture`).expect(200);
    t.wallet.accounts.get(p.merchant)!.balance = 0n; // мерчант уже вывел деньги

    const res = await http().post(`/payments/${body.id}/refund`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REFUND_REJECTED');
    expect((await http().get(`/payments/${body.id}`)).body.status).toBe('captured');
  });
});

describe('идемпотентность и устойчивость', () => {
  it('повтор create с тем же ключом возвращает тот же платёж и не резервирует дважды', async () => {
    const p = parties();
    const key = randomUUID();
    const first = await createPayment(p, '25000', key).expect(201);
    const second = await createPayment(p, '25000', key).expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(25000n);
  });

  it('тот же ключ с другими параметрами → 409', async () => {
    const p = parties();
    const key = randomUUID();
    await createPayment(p, '100', key).expect(201);

    const res = await createPayment(p, '200', key);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('параллельные create с одним ключом создают один платёж', async () => {
    const p = parties();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createPayment(p, '5000', key)),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(5000n);
    const [{ n }] = await t.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`,
      [key],
    );
    expect(n).toBe(1);
  });

  it('при недоступном wallet платёж остаётся created, а повтор довершает авторизацию', async () => {
    const p = parties();
    const key = randomUUID();
    t.wallet.failNextCalls = 1;

    const failed = await createPayment(p, '7000', key);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('WALLET_UNAVAILABLE');
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(0n);

    const retried = await createPayment(p, '7000', key).expect(201);
    expect(retried.body.status).toBe('authorized');
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(7000n);
    expect(await statuses(retried.body.id)).toEqual(['created', 'authorized']);
  });

  it('сбой wallet при capture не ломает платёж: повтор списывает ровно один раз', async () => {
    const p = parties();
    const { body } = await createPayment(p).expect(201);
    t.wallet.failNextCalls = 1;

    expect((await http().post(`/payments/${body.id}/capture`)).status).toBe(503);
    await http().post(`/payments/${body.id}/capture`).expect(200);
    expect(t.wallet.balanceOf(p.merchant)).toBe(25000n);
  });

  it('параллельные capture дают единственный переход и единственное списание', async () => {
    const p = parties();
    const { body } = await createPayment(p).expect(201);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => http().post(`/payments/${body.id}/capture`)),
    );

    expect(results.every((r) => r.status === 200 && r.body.status === 'captured')).toBe(true);
    expect(t.wallet.balanceOf(p.merchant)).toBe(25000n);
    expect(await statuses(body.id)).toEqual(['created', 'authorized', 'captured']);
  });
});

describe('валидация и служебные эндпоинты', () => {
  it('отклоняет некорректный вход', async () => {
    const p = parties();
    await http().post('/payments').send({}).expect(400);
    await createPayment(p, '10.5').expect(400);
    await createPayment(p, '10', 'k', 'rub').expect(400);
    await http()
      .post('/payments')
      .send({
        payerAccountId: p.payer,
        merchantAccountId: p.merchant,
        amount: '10',
        currency: 'RUB',
      })
      .expect(400); // нет Idempotency-Key
    await http().get('/payments/not-a-uuid').expect(400);
    expect((await http().get(`/payments/${randomUUID()}`)).body.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('health отвечает ok', async () => {
    expect((await http().get('/health').expect(200)).body).toEqual({ status: 'ok' });
  });
});
