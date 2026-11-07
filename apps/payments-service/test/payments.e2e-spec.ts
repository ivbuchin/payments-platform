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

describe('зависшие платежи и проверка сторон', () => {
  const stuck = async (p: { payer: string; merchant: string }) => {
    t.wallet.failNextCalls = 1; // getAccount мерчанта падает → платёж остаётся created
    const res = await createPayment(p);
    expect(res.status).toBe(503);
    const [row] = await t.dataSource.query(`SELECT id FROM payments WHERE payer_account_id = $1`, [
      p.payer,
    ]);
    return row.id as string;
  };

  it('503 при создании называет id платежа, чтобы его можно было довести', async () => {
    const p = parties();
    t.wallet.failNextCalls = 1;

    const res = await createPayment(p).expect(503);

    const [{ id }] = await t.dataSource.query(
      `SELECT id FROM payments WHERE payer_account_id = $1`,
      [p.payer],
    );
    expect(res.body.code).toBe('WALLET_UNAVAILABLE');
    expect(res.body.message).toContain(id);
  });

  it('сверка доводит зависший платёж до authorized и не трогает свежие', async () => {
    const p = parties();
    const id = await stuck(p);

    expect(await t.payments.reconcileStale(60_000)).toBe(0); // ещё не «зависший»
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(0n);

    expect(await t.payments.reconcileStale(0)).toBeGreaterThanOrEqual(1);
    const view = (await http().get(`/payments/${id}`).expect(200)).body;
    expect(view.status).toBe('authorized');
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(25000n);
  });

  it('сверка при недоступном wallet не падает и оставляет платёж created', async () => {
    const p = parties();
    const id = await stuck(p);
    t.wallet.failNextCalls = 100;
    await expect(t.payments.reconcileStale(0)).resolves.toBeGreaterThanOrEqual(0);
    t.wallet.failNextCalls = 0;
    expect((await http().get(`/payments/${id}`).expect(200)).body.status).toBe('created');
  });

  it('cancel зависшего платежа снимает резерв, который мог быть создан без ведома платежа', async () => {
    const p = parties();
    // Холд в wallet создан, но платёж не успел это записать (обрыв после ответа wallet).
    t.wallet.afterHoldCreated = async () => {
      t.wallet.afterHoldCreated = undefined;
      throw new Error('падение процесса');
    };
    await createPayment(p).expect(500);
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(25000n);
    const [{ id }] = await t.dataSource.query(
      `SELECT id FROM payments WHERE payer_account_id = $1`,
      [p.payer],
    );

    const res = await http().post(`/payments/${id}/cancel`).expect(200);

    expect(res.body.status).toBe('canceled');
    expect(t.wallet.accounts.get(p.payer)!.held).toBe(0n);
  });

  it('счёт мерчанта в другой валюте отклоняется до резервирования', async () => {
    const payer = randomUUID();
    const merchant = randomUUID();
    t.wallet.open(payer, 100_000n, 'RUB');
    t.wallet.open(merchant, 0n, 'USD');

    const res = await createPayment({ payer, merchant }).expect(201);

    expect(res.body).toMatchObject({ status: 'failed', failureReason: 'CURRENCY_MISMATCH' });
    expect(t.wallet.accounts.get(payer)!.held).toBe(0n);
  });

  it('несуществующий счёт мерчанта → failed без резерва', async () => {
    const payer = randomUUID();
    t.wallet.open(payer, 100_000n);

    const res = await createPayment({ payer, merchant: randomUUID() }).expect(201);

    expect(res.body).toMatchObject({ status: 'failed', failureReason: 'ACCOUNT_NOT_FOUND' });
    expect(t.wallet.accounts.get(payer)!.held).toBe(0n);
  });

  it('плательщик и мерчант не могут совпадать: 422, а не 500', async () => {
    const id = randomUUID();
    t.wallet.open(id, 1000n);
    const res = await createPayment({ payer: id, merchant: id });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SAME_ACCOUNT');
  });

  it('проигравший гонку повторов authorize снимает свой холд, если платёж уже failed', async () => {
    const p = parties();
    t.wallet.failNextCalls = 1;
    await createPayment(p).expect(503);
    const [{ id }] = await t.dataSource.query(
      `SELECT id FROM payments WHERE payer_account_id = $1`,
      [p.payer],
    );
    // Пока authorize ждёт ответа wallet, параллельный запрос уже перевёл платёж в failed.
    t.wallet.afterHoldCreated = async () => {
      t.wallet.afterHoldCreated = undefined;
      await t.dataSource.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [id]);
    };

    await t.payments.reconcileStale(0);

    expect(t.wallet.accounts.get(p.payer)!.held).toBe(0n);
  });
});

describe('истечение авторизации', () => {
  it('снимает резерв только у просроченных авторизованных платежей', async () => {
    const old = parties();
    const fresh = parties();
    const captured = parties();
    const oldId: string = (await createPayment(old).expect(201)).body.id;
    const freshId: string = (await createPayment(fresh).expect(201)).body.id;
    const capturedId: string = (await createPayment(captured).expect(201)).body.id;
    await http().post(`/payments/${capturedId}/capture`).expect(200);
    await t.dataSource.query(
      `UPDATE payments SET updated_at = now() - interval '2 days' WHERE id = ANY($1)`,
      [[oldId, capturedId]],
    );

    const canceled = await t.payments.expireAuthorizations(24 * 3600_000);

    expect(canceled).toBe(1);
    expect((await http().get(`/payments/${oldId}`)).body.status).toBe('canceled');
    expect(t.wallet.accounts.get(old.payer)!.held).toBe(0n);
    expect((await http().get(`/payments/${freshId}`)).body.status).toBe('authorized');
    expect((await http().get(`/payments/${capturedId}`)).body.status).toBe('captured');
  });
});

describe('платежи, начатые до введения HMAC-ключей (key_version = 1)', () => {
  it('повтор возврата использует прежний ключ и не выполняется дважды', async () => {
    const p = parties();
    const id: string = (await createPayment(p).expect(201)).body.id;
    await http().post(`/payments/${id}/capture`).expect(200);
    await t.dataSource.query(`UPDATE payments SET key_version = 1 WHERE id = $1`, [id]);

    const before = new Set(t.wallet.transfers.keys());
    await http().post(`/payments/${id}/refund`).expect(200);

    expect([...t.wallet.transfers.keys()].filter((k) => !before.has(k))).toEqual([
      `payment:${id}:refund`,
    ]);
  });

  it('сверка зависшего платежа повторяет резерв под прежним ключом', async () => {
    const p = parties();
    t.wallet.failNextCalls = 1;
    await createPayment(p).expect(503);
    const [{ id }] = await t.dataSource.query(
      `SELECT id FROM payments WHERE payer_account_id = $1`,
      [p.payer],
    );
    await t.dataSource.query(`UPDATE payments SET key_version = 1 WHERE id = $1`, [id]);

    await t.payments.reconcileStale(0);

    expect([...t.wallet.byKey.keys()]).toContain(`payment:${id}:hold`);
  });
});

describe('ключи идемпотентности wallet', () => {
  it('клиент, знающий id платежа, не может занять ключ возврата или резерва заранее', async () => {
    const p = parties();
    const created = await createPayment(p).expect(201);
    const id: string = created.body.id;
    await http().post(`/payments/${id}/capture`).expect(200);
    // Прежние предсказуемые ключи: занятый такой перевод раньше блокировал возврат навсегда.
    await t.wallet.transfer({
      idempotencyKey: `payment:${id}:refund`,
      fromAccountId: p.payer,
      toAccountId: p.merchant,
      amount: '1',
    });

    const before = new Set(t.wallet.transfers.keys());
    const refund = await http().post(`/payments/${id}/refund`);

    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe('refunded');
    // Возврат прошёл под выведенным ключом, а занятый клиентом ключ остался без последствий.
    const refundKeys = [...t.wallet.transfers.keys()].filter((k) => !before.has(k));
    expect(refundKeys).toHaveLength(1);
    expect(refundKeys[0]).toMatch(/^i[0-9a-f]{64}$/);
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
