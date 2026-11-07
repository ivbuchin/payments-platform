import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { DeliveryStatus, WebhookDelivery } from './delivery.entity';
import { DeliveriesService } from './deliveries.service';

class ListDeliveriesQuery {
  @IsOptional()
  @IsIn(['pending', 'delivered', 'dead'])
  status?: DeliveryStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

const toDeliveryView = (d: WebhookDelivery) => ({
  id: d.id,
  endpointId: d.endpointId,
  eventId: d.eventId,
  eventType: d.eventType,
  status: d.status,
  attempts: d.attempts,
  nextAttemptAt: d.nextAttemptAt,
  lastStatusCode: d.lastStatusCode,
  lastError: d.lastError,
  deliveredAt: d.deliveredAt,
  createdAt: d.createdAt,
});

@ApiTags('deliveries')
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  @ApiOperation({ summary: 'Журнал доставок; status=dead — очередь ручного разбора' })
  async list(@Query() query: ListDeliveriesQuery) {
    return (await this.deliveries.list(query.status, query.limit)).map(toDeliveryView);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return toDeliveryView(await this.deliveries.get(id));
  }

  @Post(':id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Повторить «мёртвую» доставку' })
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    return toDeliveryView(await this.deliveries.retry(id));
  }
}
