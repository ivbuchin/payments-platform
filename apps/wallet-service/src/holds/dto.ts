import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AMOUNT_PATTERN, AMOUNT_PATTERN_MESSAGE } from '@pp/nest-kit';
import type { Hold } from './hold.entity';

export class CreateHoldDto {
  @ApiProperty() @IsUUID() accountId: string;

  @ApiProperty({ example: '25000', description: 'Минорные единицы (копейки), строкой' })
  @Matches(AMOUNT_PATTERN, { message: AMOUNT_PATTERN_MESSAGE })
  amount: string;

  @ApiPropertyOptional({ example: 'payment-7f3a' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
}

export class CaptureHoldDto {
  @ApiProperty({ description: 'Счёт получателя' }) @IsUUID() toAccountId: string;
}

export const toHoldView = (h: Hold) => ({
  id: h.id,
  accountId: h.accountId,
  amount: h.amount.toString(),
  currency: h.currency,
  reference: h.reference,
  status: h.status,
  transferId: h.transferId,
  createdAt: h.createdAt,
  settledAt: h.settledAt,
});
