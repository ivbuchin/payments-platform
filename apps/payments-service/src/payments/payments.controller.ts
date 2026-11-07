import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IdempotencyKey, parseAmount } from '@pp/nest-kit';
import { CreatePaymentDto, toPaymentView, toTransitionView } from './dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @ApiOperation({ summary: 'Создать платёж и зарезервировать средства (авторизация)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@Body() dto: CreatePaymentDto, @IdempotencyKey() idempotencyKey: string) {
    const payment = await this.payments.create({
      idempotencyKey,
      payerAccountId: dto.payerAccountId,
      merchantAccountId: dto.merchantAccountId,
      amount: parseAmount(dto.amount),
      currency: dto.currency,
    });
    return toPaymentView(payment);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Платёж и журнал его переходов' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const { payment, history } = await this.payments.get(id);
    return { ...toPaymentView(payment), history: history.map(toTransitionView) };
  }

  @Post(':id/capture')
  @HttpCode(200)
  @ApiOperation({ summary: 'Списать резерв в пользу мерчанта (повтор безопасен)' })
  async capture(@Param('id', ParseUUIDPipe) id: string) {
    return toPaymentView(await this.payments.capture(id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отменить авторизованный платёж (повтор безопасен)' })
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return toPaymentView(await this.payments.cancel(id));
  }

  @Post(':id/refund')
  @HttpCode(200)
  @ApiOperation({ summary: 'Полный возврат списанного платежа (повтор безопасен)' })
  async refund(@Param('id', ParseUUIDPipe) id: string) {
    return toPaymentView(await this.payments.refund(id));
  }
}
