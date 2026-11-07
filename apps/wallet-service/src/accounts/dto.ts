import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { AMOUNT_PATTERN, AMOUNT_PATTERN_MESSAGE } from '@pp/nest-kit';
import type { LedgerEntry } from '../ledger/ledger-entry.entity';
import type { Account } from './account.entity';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class CreateAccountDto {
  @ApiProperty({ example: 'user-42' })
  @IsString()
  @MaxLength(128)
  ownerId: string;

  @ApiProperty({ example: 'RUB', description: 'ISO 4217, три заглавные буквы' })
  @Matches(CURRENCY_PATTERN, { message: 'currency: три заглавные латинские буквы' })
  currency: string;
}

export class DepositDto {
  @ApiProperty({ example: '150000', description: 'Минорные единицы (копейки), строкой' })
  @Matches(AMOUNT_PATTERN, { message: AMOUNT_PATTERN_MESSAGE })
  amount: string;

  @ApiPropertyOptional({ example: 'topup-2024-001' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  reference?: string;
}

export class LedgerQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Курсор `nextBefore` из предыдущего ответа' })
  @IsOptional()
  @Matches(/^\d{1,18}$/)
  before?: string;
}

export class AccountIdParam {
  @IsUUID()
  id: string;
}

export const toAccountView = (a: Account) => ({
  id: a.id,
  ownerId: a.ownerId,
  currency: a.currency,
  balance: a.balance.toString(),
  held: a.held.toString(),
  available: a.available.toString(),
  createdAt: a.createdAt,
});

export const toLedgerEntryView = (e: LedgerEntry) => ({
  id: e.id,
  transferId: e.transferId,
  direction: e.direction,
  amount: e.amount.toString(),
  balanceAfter: e.balanceAfter.toString(),
  createdAt: e.createdAt,
});
