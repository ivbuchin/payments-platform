import type { PaymentStatus } from '@pp/contracts';
import { canTransition, isTerminal } from './payment-status';

const ALL: PaymentStatus[] = [
  'created',
  'authorized',
  'captured',
  'refunded',
  'canceled',
  'failed',
];

describe('payment-status', () => {
  it.each([
    ['created', 'authorized'],
    ['created', 'failed'],
    ['authorized', 'captured'],
    ['authorized', 'canceled'],
    ['captured', 'refunded'],
  ] as const)('разрешает %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('запрещает всё остальное, включая переходы в себя и назад', () => {
    const allowed = new Set([
      'created>authorized',
      'created>failed',
      'authorized>captured',
      'authorized>canceled',
      'captured>refunded',
    ]);
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('терминальные статусы не имеют выходов', () => {
    expect(ALL.filter(isTerminal).sort()).toEqual(['canceled', 'failed', 'refunded']);
  });
});
