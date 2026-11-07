import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IdempotencyKey, parseAmount } from '@pp/nest-kit';
import { CreateTransferDto, toTransferView } from './dto';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @ApiOperation({ summary: 'Перевод между счетами одной валюты' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@Body() dto: CreateTransferDto, @IdempotencyKey() idempotencyKey: string) {
    const transfer = await this.transfers.create({
      idempotencyKey,
      fromAccountId: dto.fromAccountId,
      toAccountId: dto.toAccountId,
      amount: parseAmount(dto.amount),
      reference: dto.reference ?? null,
    });
    return toTransferView(transfer);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toTransferView(await this.transfers.get(id));
  }
}
