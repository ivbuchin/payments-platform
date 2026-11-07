import { parseEnvelope } from './event-envelope';

const valid = {
  id: '0b2d6a5e-3b3a-4f4e-9c5e-2f6f1d7a9a11',
  type: 'payment.status_changed',
  occurredAt: '2024-01-01T00:00:00.000Z',
  payload: { paymentId: 'p1' },
};

describe('parseEnvelope', () => {
  it('разбирает валидный конверт', () => {
    expect(parseEnvelope(Buffer.from(JSON.stringify(valid)))).toEqual(valid);
  });

  it.each([
    ['не JSON', 'not json'],
    ['неизвестный тип', JSON.stringify({ ...valid, type: 'wallet.unknown' })],
    ['id не UUID', JSON.stringify({ ...valid, id: '1' })],
    ['нет payload', JSON.stringify({ ...valid, payload: undefined })],
  ])('возвращает null: %s', (_name, body) => {
    expect(parseEnvelope(Buffer.from(body))).toBeNull();
  });
});
