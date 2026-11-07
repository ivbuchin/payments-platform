import { ApiProperty } from '@nestjs/swagger';
import { AMOUNT_PATTERN, AMOUNT_PATTERN_MESSAGE } from '@pp/nest-kit';
import { IsUUID, Matches } from 'class-validator';
import type { PaymentTransition } from './payment-transition.entity';
import type { Payment } from './payment.entity';

export class CreatePaymentDto {
  @ApiProperty({ description: 'Счёт плательщика в wallet-service' })
  @IsUUID()
  payerAccountId: string;

  @ApiProperty({ description: 'Счёт мерчанта в wallet-service' })
  @IsUUID()
  merchantAccountId: string;

  @ApiProperty({ example: '25000', description: 'Минорные единицы (копейки), строкой' })
  @Matches(AMOUNT_PATTERN, { message: AMOUNT_PATTERN_MESSAGE })
  amount: string;

  @ApiProperty({ example: 'RUB' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency: три заглавные латинские буквы' })
  currency: string;
}

export const toPaymentView = (p: Payment) => ({
  id: p.id,
  status: p.status,
  payerAccountId: p.payerAccountId,
  merchantAccountId: p.merchantAccountId,
  amount: p.amount.toString(),
  currency: p.currency,
  failureReason: p.failureReason,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const toTransitionView = (t: PaymentTransition) => ({
  from: t.fromStatus,
  to: t.toStatus,
  at: t.createdAt,
});
