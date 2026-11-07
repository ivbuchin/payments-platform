import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IdempotencyKey, parseAmount } from '@pp/nest-kit';
import { toTransferView } from '../ledger/dto';
import { CaptureHoldDto, CreateHoldDto, toHoldView } from './dto';
import { HoldsService } from './holds.service';

@ApiTags('holds')
@Controller('holds')
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @Post()
  @ApiOperation({ summary: 'Зарезервировать средства (авторизация)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@Body() dto: CreateHoldDto, @IdempotencyKey() idempotencyKey: string) {
    const hold = await this.holds.create({
      idempotencyKey,
      accountId: dto.accountId,
      amount: parseAmount(dto.amount),
      reference: dto.reference ?? null,
    });
    return toHoldView(hold);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toHoldView(await this.holds.get(id));
  }

  @Post(':id/capture')
  @HttpCode(200)
  @ApiOperation({ summary: 'Списать резерв на счёт получателя (повтор безопасен)' })
  async capture(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CaptureHoldDto) {
    const { hold, transfer } = await this.holds.capture(id, dto.toAccountId);
    return { hold: toHoldView(hold), transfer: toTransferView(transfer) };
  }

  @Post(':id/release')
  @HttpCode(200)
  @ApiOperation({ summary: 'Снять резерв без списания (повтор безопасен)' })
  async release(@Param('id', ParseUUIDPipe) id: string) {
    return toHoldView(await this.holds.release(id));
  }
}
