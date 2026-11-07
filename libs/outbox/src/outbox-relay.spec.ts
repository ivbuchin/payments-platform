import type { EventEnvelope } from '@pp/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { EventPublisher } from './event-publisher';
import { OUTBOX_LEASE_SQL, OUTBOX_TABLE_SQL, OutboxEvent } from './outbox-event.entity';
import { DEFAULT_RELAY_OPTIONS, OutboxRelay, type OutboxRelayOptions } from './outbox-relay';

type Envelope = EventEnvelope<string, unknown>;

/** Публикатор в памяти с управляемыми задержкой и сбоями. */
class FakePublisher extends EventPublisher {
  readonly published: string[] = [];
  delayMs = 0;
  /** Номера (с 1) вызовов `publish`, которые должны завершиться ошибкой. */
  failOnCalls = new Set<number>();
  hang = false;
  /** Вызывается после публикации очередного события, до его подтверждения в БД. */
  afterPublish?: (id: string) => Promise<void>;
  private calls = 0;

  async publish(event: Envelope): Promise<void> {
    const call = ++this.calls;
    if (this.hang) return new Promise<void>(() => undefined);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failOnCalls.has(call)) throw new Error('брокер недоступен');
    this.published.push(event.id);
    await this.afterPublish?.(event.id);
  }

  async close(): Promise<void> {}
}

let container: StartedPostgreSqlContainer;
let dataSource: DataSource;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  dataSource = await new DataSource({
    type: 'postgres',
    url: container.getConnectionUri(),
    entities: [OutboxEvent],
  }).initialize();
  await dataSource.query(OUTBOX_TABLE_SQL);
  await dataSource.query(OUTBOX_LEASE_SQL);
});
afterAll(async () => {
  await dataSource.destroy();
  await container.stop();
});
beforeEach(() => dataSource.query('TRUNCATE outbox_events'));

/** Добавляет события с возрастающим `occurred_at`; возвращает их id в порядке вставки. */
async function seed(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    await dataSource.query(
      `INSERT INTO outbox_events (id, type, payload, occurred_at)
       VALUES ($1, 'test.event', '{}', now() + ($2::int * interval '1 millisecond'))`,
      [id, i],
    );
  }
  return ids;
}

const relayWith = (publisher: FakePublisher, options: Partial<OutboxRelayOptions> = {}) =>
  new OutboxRelay(dataSource, publisher, { ...DEFAULT_RELAY_OPTIONS, ...options });

const unpublished = async (): Promise<number> =>
  Number(
    (await dataSource.query('SELECT count(*) FROM outbox_events WHERE published_at IS NULL'))[0]
      .count,
  );

async function drain(relay: OutboxRelay): Promise<void> {
  while ((await relay.flushOnce()) > 0);
}

describe('OutboxRelay', () => {
  it('публикует события по порядку и помечает их опубликованными', async () => {
    const ids = await seed(5);
    const publisher = new FakePublisher();

    await drain(relayWith(publisher, { batchSize: 2 }));

    expect(publisher.published).toEqual(ids);
    expect(await unpublished()).toBe(0);
  });

  it('два релея на одной БД публикуют каждое событие ровно один раз', async () => {
    const ids = await seed(40);
    const publisher = new FakePublisher();
    publisher.delayMs = 5; // публикация пачки заметно длиннее захвата — окно для гонки
    const options = { batchSize: 5 };

    await Promise.all([drain(relayWith(publisher, options)), drain(relayWith(publisher, options))]);

    expect([...publisher.published].sort()).toEqual([...ids].sort());
    expect(new Set(publisher.published).size).toBe(ids.length);
  });

  it('при сбое останавливается на первом событии и не нарушает порядок', async () => {
    const ids = await seed(6);
    const publisher = new FakePublisher();
    publisher.failOnCalls = new Set([3]);
    const relay = relayWith(publisher);

    expect(await relay.flushOnce()).toBe(2);
    expect(publisher.published).toEqual(ids.slice(0, 2));

    // Неотправленные события сразу доступны (аренда снята), и порядок сохраняется.
    await drain(relay);
    expect(publisher.published).toEqual(ids);
  });

  it('не берёт события, пока действует аренда другого релея, и берёт после её истечения', async () => {
    const ids = await seed(3);
    await dataSource.query(`UPDATE outbox_events SET locked_until = now() + interval '1 hour'`);
    const publisher = new FakePublisher();
    const relay = relayWith(publisher);

    expect(await relay.flushOnce()).toBe(0);

    await dataSource.query(`UPDATE outbox_events SET locked_until = now() - interval '1 second'`);
    expect(await relay.flushOnce()).toBe(3);
    expect(publisher.published).toEqual(ids);
  });

  it('не публикует событие, если не успеет подтвердить его до конца аренды', async () => {
    const ids = await seed(10);
    const publisher = new FakePublisher();
    publisher.delayMs = 100;
    const relay = relayWith(publisher, { leaseMs: 400, publishTimeoutMs: 150 });

    // Публикации стартуют на 0, 100, 200 мс; на 300 мс запас 150 мс до конца аренды уже не остаётся.
    expect(await relay.flushOnce()).toBe(3);
    expect(publisher.published).toEqual(ids.slice(0, 3));

    await drain(relay);
    expect(publisher.published).toEqual(ids);
  });

  it('не затирает событие, которое после истечения аренды взял другой релей', async () => {
    const [id] = await seed(1);
    const publisher = new FakePublisher();
    publisher.afterPublish = async () => {
      // Другой релей перехватил событие, пока мы ждали подтверждения.
      await dataSource.query(
        `UPDATE outbox_events SET locked_until = now() + interval '1 hour' WHERE id = $1`,
        [id],
      );
    };

    await relayWith(publisher).flushOnce();

    const [row] = await dataSource.query(
      `SELECT published_at, locked_until > now() AS leased FROM outbox_events WHERE id = $1`,
      [id],
    );
    expect(row).toEqual({ published_at: null, leased: true });
  });

  it('отклоняет аренду, не превышающую таймаут публикации', () => {
    expect(() => relayWith(new FakePublisher(), { leaseMs: 100, publishTimeoutMs: 100 })).toThrow(
      RangeError,
    );
  });

  it('зависший брокер не держит событие: таймаут подтверждения освобождает его', async () => {
    await seed(2);
    const publisher = new FakePublisher();
    publisher.hang = true;
    const relay = relayWith(publisher, { publishTimeoutMs: 100 });

    expect(await relay.flushOnce()).toBe(0);
    expect(await unpublished()).toBe(2);

    publisher.hang = false;
    expect(await relay.flushOnce()).toBe(2);
  });
});
