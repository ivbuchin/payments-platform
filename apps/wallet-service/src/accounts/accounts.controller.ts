import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IdempotencyKey, parseAmount } from '@pp/nest-kit';
import { toTransferView } from '../ledger/dto';
import { TransfersService } from '../ledger/transfers.service';
import { AccountsService } from './accounts.service';
import {
  CreateAccountDto,
  DepositDto,
  LedgerQueryDto,
  toAccountView,
  toLedgerEntryView,
} from './dto';

@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transfers: TransfersService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Открыть счёт (один на владельца и валюту)' })
  async create(@Body() dto: CreateAccountDto) {
    return toAccountView(await this.accounts.create(dto.ownerId, dto.currency));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Баланс: всего, заморожено, доступно' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toAccountView(await this.accounts.get(id));
  }

  @Post(':id/deposits')
  @HttpCode(201)
  @ApiOperation({ summary: 'Пополнить счёт (перевод с системного счёта)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async deposit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DepositDto,
    @IdempotencyKey() idempotencyKey: string,
  ) {
    const transfer = await this.transfers.deposit({
      idempotencyKey,
      accountId: id,
      amount: parseAmount(dto.amount),
      reference: dto.reference ?? null,
    });
    return toTransferView(transfer);
  }

  @Get(':id/ledger')
  @ApiOperation({ summary: 'Выписка (проводки), новые первыми, keyset-пагинация' })
  async ledger(@Param('id', ParseUUIDPipe) id: string, @Query() query: LedgerQueryDto) {
    const page = await this.accounts.listLedger(id, query.limit, query.before);
    return { items: page.items.map(toLedgerEntryView), nextBefore: page.nextBefore };
  }
}
