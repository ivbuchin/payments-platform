import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { startTestApp, TestApp } from './test-app';

let t: TestApp;
const http = () => request(t.url);

async function openAccount(ownerId: string, currency = 'RUB'): Promise<string> {
  const res = await http().post('/accounts').send({ ownerId, currency }).expect(201);
  return res.body.id;
}

async function deposit(accountId: string, amount: string): Promise<void> {
  await http()
    .post(`/accounts/${accountId}/deposits`)
    .set('Idempotency-Key', randomUUID())
    .send({ amount })
    .expect(201);
}

async function snapshot(accountId: string) {
  return (await http().get(`/accounts/${accountId}`).expect(200)).body as {
    balance: string;
    held: string;
    available: string;
  };
}

const transfer = (from: string, to: string, amount: string, key: string = randomUUID()) =>
  http()
    .post('/transfers')
    .set('Idempotency-Key', key)
    .send({ fromAccountId: from, toAccountId: to, amount });

beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.stop();
});

describe('accounts и пополнение', () => {
  it('открывает счёт и не даёт завести второй в той же валюте', async () => {
    await openAccount('dup-owner');
    const res = await http().post('/accounts').send({ ownerId: 'dup-owner', currency: 'RUB' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_ALREADY_EXISTS');
  });

  it('пополнение меняет баланс и пишет проводку двойной записи', async () => {
    const id = await openAccount('depositor');
    await deposit(id, '150000');

    expect(await snapshot(id)).toMatchObject({ balance: '150000', held: '0', available: '150000' });
    const ledger = (await http().get(`/accounts/${id}/ledger`).expect(200)).body;
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({
      direction: 'credit',
      amount: '150000',
      balanceAfter: '150000',
    });
  });

  it('повтор пополнения с тем же ключом не удваивает баланс', async () => {
    const id = await openAccount('replayer');
    const key = randomUUID();
    const send = () =>
      http().post(`/accounts/${id}/deposits`).set('Idempotency-Key', key).send({ amount: '500' });

    const first = await send().expect(201);
    const second = await send().expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect((await snapshot(id)).balance).toBe('500');
  });

  it('тот же ключ с другой суммой отклоняется', async () => {
    const id = await openAccount('key-reuser');
    const key = randomUUID();
    await http()
      .post(`/accounts/${id}/deposits`)
      .set('Idempotency-Key', key)
      .send({ amount: '10' })
      .expect(201);

    const res = await http()
      .post(`/accounts/${id}/deposits`)
      .set('Idempotency-Key', key)
      .send({ amount: '11' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('валидирует вход: нет ключа, дробная сумма, чужие поля', async () => {
    const id = await openAccount('validator');
    await http().post(`/accounts/${id}/deposits`).send({ amount: '10' }).expect(400);
    await http()
      .post(`/accounts/${id}/deposits`)
      .set('Idempotency-Key', 'k1')
      .send({ amount: '12.5' })
      .expect(400);
    await http()
      .post(`/accounts/${id}/deposits`)
      .set('Idempotency-Key', 'k2')
      .send({ amount: '0' })
      .expect(400);
    await http()
      .post(`/accounts/${id}/deposits`)
      .set('Idempotency-Key', 'k3')
      .send({ amount: '1', extra: 1 })
      .expect(400);
    await http().get('/accounts/not-a-uuid').expect(400);
  });

  it('выписка пагинируется курсором без пропусков и дублей', async () => {
    const id = await openAccount('paginator');
    for (let i = 0; i < 5; i++) await deposit(id, '100');

    const page1 = (await http().get(`/accounts/${id}/ledger?limit=2`).expect(200)).body;
    const page2 = (
      await http().get(`/accounts/${id}/ledger?limit=2&before=${page1.nextBefore}`).expect(200)
    ).body;
    const page3 = (
      await http().get(`/accounts/${id}/ledger?limit=2&before=${page2.nextBefore}`).expect(200)
    ).body;

    const ids = [...page1.items, ...page2.items, ...page3.items].map((e: { id: string }) => e.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(page3.nextBefore).toBeNull();
  });
});

describe('переводы', () => {
  it('переводит средства и отклоняет перерасход', async () => {
    const a = await openAccount('payer-1');
    const b = await openAccount('payee-1');
    await deposit(a, '1000');

    await transfer(a, b, '400').expect(201);
    expect(await snapshot(a)).toMatchObject({ balance: '600' });
    expect(await snapshot(b)).toMatchObject({ balance: '400' });

    const res = await transfer(a, b, '601');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
    expect(await snapshot(a)).toMatchObject({ balance: '600' });
  });

  it('отклоняет перевод самому себе и между валютами', async () => {
    const rub = await openAccount('cur-1', 'RUB');
    const usd = await openAccount('cur-1', 'USD');
    await deposit(rub, '100');

    expect((await transfer(rub, rub, '1')).body.code).toBe('SAME_ACCOUNT');
    expect((await transfer(rub, usd, '1')).body.code).toBe('CURRENCY_MISMATCH');
  });

  it('при гонке расходов не уходит в минус: из 20 переводов по 100 проходят ровно 10', async () => {
    const payer = await openAccount('race-payer');
    const payee = await openAccount('race-payee');
    await deposit(payer, '1000');

    const results = await Promise.all(
      Array.from({ length: 20 }, () => transfer(payer, payee, '100')),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(10);
    expect(await snapshot(payer)).toMatchObject({ balance: '0' });
    expect(await snapshot(payee)).toMatchObject({ balance: '1000' });
  });

  it('параллельные запросы с одним ключом создают ровно один перевод', async () => {
    const payer = await openAccount('same-key-payer');
    const payee = await openAccount('same-key-payee');
    await deposit(payer, '1000');
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(payer, payee, '100', key)),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await snapshot(payee)).toMatchObject({ balance: '100' });
  });

  it('встречные переводы не приводят к deadlock', async () => {
    const a = await openAccount('deadlock-a');
    const b = await openAccount('deadlock-b');
    await deposit(a, '10000');
    await deposit(b, '10000');

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0 ? transfer(a, b, '10') : transfer(b, a, '10'),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await snapshot(a)).toMatchObject({ balance: '10000' });
    expect(await snapshot(b)).toMatchObject({ balance: '10000' });
  });
});

describe('холды', () => {
  const hold = (accountId: string, amount: string, key: string = randomUUID()) =>
    http()
      .post('/holds')
      .set('Idempotency-Key', key)
      .send({ accountId, amount, reference: 'order-1' });

  it('резервирует, уменьшая доступный остаток, и не даёт зарезервировать лишнее', async () => {
    const id = await openAccount('holder-1');
    await deposit(id, '1000');

    await hold(id, '700').expect(201);
    expect(await snapshot(id)).toMatchObject({ balance: '1000', held: '700', available: '300' });

    const res = await hold(id, '301');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('перевод не может потратить замороженные средства', async () => {
    const a = await openAccount('frozen-a');
    const b = await openAccount('frozen-b');
    await deposit(a, '1000');
    await hold(a, '800').expect(201);

    expect((await transfer(a, b, '201')).body.code).toBe('INSUFFICIENT_FUNDS');
    await transfer(a, b, '200').expect(201);
  });

  it('capture списывает резерв получателю; повтор безопасен, чужой получатель — конфликт', async () => {
    const payer = await openAccount('cap-payer');
    const payee = await openAccount('cap-payee');
    const other = await openAccount('cap-other');
    await deposit(payer, '1000');
    const { body: h } = await hold(payer, '600').expect(201);

    const first = await http()
      .post(`/holds/${h.id}/capture`)
      .send({ toAccountId: payee })
      .expect(200);
    expect(first.body.hold.status).toBe('captured');
    expect(await snapshot(payer)).toMatchObject({ balance: '400', held: '0', available: '400' });
    expect(await snapshot(payee)).toMatchObject({ balance: '600' });

    const again = await http()
      .post(`/holds/${h.id}/capture`)
      .send({ toAccountId: payee })
      .expect(200);
    expect(again.body.transfer.id).toBe(first.body.transfer.id);
    expect(await snapshot(payee)).toMatchObject({ balance: '600' });

    const conflict = await http().post(`/holds/${h.id}/capture`).send({ toAccountId: other });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('HOLD_STATE_CONFLICT');
  });

  it('параллельные capture одного холда создают единственный перевод', async () => {
    const payer = await openAccount('pcap-payer');
    const payee = await openAccount('pcap-payee');
    await deposit(payer, '1000');
    const { body: h } = await hold(payer, '1000').expect(201);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        http().post(`/holds/${h.id}/capture`).send({ toAccountId: payee }),
      ),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await snapshot(payee)).toMatchObject({ balance: '1000' });
    expect(await snapshot(payer)).toMatchObject({ balance: '0', held: '0' });
  });

  it('release возвращает доступность; после release capture невозможен, после capture release — тоже', async () => {
    const payer = await openAccount('rel-payer');
    const payee = await openAccount('rel-payee');
    await deposit(payer, '1000');

    const { body: released } = await hold(payer, '500').expect(201);
    await http().post(`/holds/${released.id}/release`).expect(200);
    await http().post(`/holds/${released.id}/release`).expect(200);
    expect(await snapshot(payer)).toMatchObject({ held: '0', available: '1000' });
    expect(
      (await http().post(`/holds/${released.id}/capture`).send({ toAccountId: payee })).status,
    ).toBe(409);

    const { body: captured } = await hold(payer, '500').expect(201);
    await http().post(`/holds/${captured.id}/capture`).send({ toAccountId: payee }).expect(200);
    expect((await http().post(`/holds/${captured.id}/release`)).status).toBe(409);
  });
});

describe('границы доверия', () => {
  /** Идентификатор системного счёта виден клиенту в `fromAccountId` любого пополнения. */
  async function systemAccountId(): Promise<string> {
    const id = await openAccount(`sys-probe-${randomUUID()}`);
    const res = await http()
      .post(`/accounts/${id}/deposits`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '1' })
      .expect(201);
    return res.body.fromAccountId;
  }

  it('нельзя выпустить деньги переводом с системного счёта', async () => {
    const system = await systemAccountId();
    const victim = await openAccount(`mint-${randomUUID()}`);

    const res = await transfer(system, victim, '100000');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SYSTEM_ACCOUNT_FORBIDDEN');
    expect(await snapshot(victim)).toMatchObject({ balance: '0' });
  });

  it('системный счёт закрыт и как получатель перевода, capture и холда', async () => {
    const system = await systemAccountId();
    const user = await openAccount(`to-system-${randomUUID()}`);
    await deposit(user, '1000');
    const { body: h } = await http()
      .post('/holds')
      .set('Idempotency-Key', randomUUID())
      .send({ accountId: user, amount: '100' })
      .expect(201);

    expect((await transfer(user, system, '100')).body.code).toBe('SYSTEM_ACCOUNT_FORBIDDEN');
    const capture = await http().post(`/holds/${h.id}/capture`).send({ toAccountId: system });
    expect(capture.status).toBe(403);
    const hold = await http()
      .post('/holds')
      .set('Idempotency-Key', randomUUID())
      .send({ accountId: system, amount: '1' });
    expect(hold.status).toBe(403);
    expect(await snapshot(user)).toMatchObject({ balance: '1000', held: '100' });
  });

  it.each(['#hold-capture:abc', 'a b', 'a/b'])(
    'клиентский Idempotency-Key %j вне разрешённого алфавита отклоняется',
    async (key) => {
      const a = await openAccount(`key-a-${randomUUID()}`);
      const b = await openAccount(`key-b-${randomUUID()}`);
      const res = await http()
        .post('/transfers')
        .set('Idempotency-Key', key)
        .send({ fromAccountId: a, toAccountId: b, amount: '1' });
      expect(res.status).toBe(400);
    },
  );

  it('capture не блокируется заранее занятым «внутренним» ключом', async () => {
    const payer = await openAccount(`squat-payer-${randomUUID()}`);
    const payee = await openAccount(`squat-payee-${randomUUID()}`);
    await deposit(payer, '1000');
    const { body: h } = await http()
      .post('/holds')
      .set('Idempotency-Key', randomUUID())
      .send({ accountId: payer, amount: '100' })
      .expect(201);

    // Раньше внутренний ключ capture был обычной строкой, и клиент мог занять его заранее.
    await transfer(payer, payee, '1', `hold-capture:${h.id}`).expect(201);

    await http().post(`/holds/${h.id}/capture`).send({ toAccountId: payee }).expect(200);
    expect(await snapshot(payee)).toMatchObject({ balance: '101' });
  });

  it('отсутствующий reference и строка "null" — разные запросы', async () => {
    const a = await openAccount(`ref-a-${randomUUID()}`);
    const b = await openAccount(`ref-b-${randomUUID()}`);
    await deposit(a, '1000');
    const key = randomUUID();

    await http()
      .post('/transfers')
      .set('Idempotency-Key', key)
      .send({ fromAccountId: a, toAccountId: b, amount: '10' })
      .expect(201);
    const res = await http()
      .post('/transfers')
      .set('Idempotency-Key', key)
      .send({ fromAccountId: a, toAccountId: b, amount: '10', reference: 'null' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('повтор холда с тем же ключом, но другой суммой — конфликт, а не прежний холд', async () => {
    const id = await openAccount(`hold-replay-${randomUUID()}`);
    await deposit(id, '1000');
    const key = randomUUID();
    const create = (amount: string) =>
      http().post('/holds').set('Idempotency-Key', key).send({ accountId: id, amount });

    await create('100').expect(201);
    expect((await create('100')).status).toBe(201);
    const res = await create('200');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await snapshot(id)).toMatchObject({ held: '100' });
  });

  it('переполнение баланса даёт 422, а не 500', async () => {
    // Отдельная валюта: общий системный счёт валюты упирается в предел и не должен задеть другие тесты.
    const id = (
      await http()
        .post('/accounts')
        .send({ ownerId: `big-${randomUUID()}`, currency: 'XTS' })
    ).body.id;
    const huge = '999999999999';

    let rejected: request.Response | undefined;
    for (let i = 0; i < 12 && !rejected; i++) {
      const res = await http()
        .post(`/accounts/${id}/deposits`)
        .set('Idempotency-Key', randomUUID())
        .send({ amount: huge });
      if (res.status !== 201) rejected = res;
    }

    expect(rejected?.status).toBe(422);
    expect(rejected?.body.code).toBe('BALANCE_LIMIT_EXCEEDED');

    // Упёршийся в предел клиент не мешает пополнять чужие счета в той же валюте.
    const other = (
      await http()
        .post('/accounts')
        .send({ ownerId: `other-${randomUUID()}`, currency: 'XTS' })
    ).body.id;
    const res = await http()
      .post(`/accounts/${other}/deposits`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: '100' });
    expect(res.status).toBe(201);
  });
});

describe('инварианты и события', () => {
  it('сумма всех балансов равна нулю, а баланс каждого счёта равен сумме его проводок', async () => {
    const [{ total }] = await t.dataSource.query(
      `SELECT COALESCE(SUM(balance), 0)::text AS total FROM accounts`,
    );
    expect(total).toBe('0');

    const mismatches = await t.dataSource.query(`
      SELECT a.id FROM accounts a
      LEFT JOIN (
        SELECT account_id,
               SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END) AS net
        FROM ledger_entries GROUP BY account_id
      ) l ON l.account_id = a.id
      WHERE a.balance <> COALESCE(l.net, 0)
    `);
    expect(mismatches).toEqual([]);
  });

  it('каждая мутация оставляет событие в outbox', async () => {
    const rows: { type: string; n: string }[] = await t.dataSource.query(
      `SELECT type, COUNT(*)::text AS n FROM outbox_events GROUP BY type`,
    );
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual([
      'wallet.hold.captured',
      'wallet.hold.created',
      'wallet.hold.released',
      'wallet.transfer.completed',
    ]);
  });

  it('health отвечает ok', async () => {
    const res = await http().get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
