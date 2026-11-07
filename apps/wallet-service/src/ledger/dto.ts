import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AMOUNT_PATTERN, AMOUNT_PATTERN_MESSAGE } from '@pp/nest-kit';
import type { Transfer } from './transfer.entity';

export class CreateTransferDto {
  @ApiProperty() @IsUUID() fromAccountId: string;
  @ApiProperty() @IsUUID() toAccountId: string;

  @ApiProperty({ example: '25000', description: 'Минорные единицы (копейки), строкой' })
  @Matches(AMOUNT_PATTERN, { message: AMOUNT_PATTERN_MESSAGE })
  amount: string;

  @ApiPropertyOptional({ example: 'order-1001' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
}

export const toTransferView = (t: Transfer) => ({
  id: t.id,
  fromAccountId: t.fromAccountId,
  toAccountId: t.toAccountId,
  amount: t.amount.toString(),
  currency: t.currency,
  reference: t.reference,
  createdAt: t.createdAt,
});
