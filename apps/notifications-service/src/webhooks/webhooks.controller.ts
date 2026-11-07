import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateWebhookDto, toWebhookView } from './dto';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @ApiOperation({ summary: 'Подписаться на события; секрет подписи возвращается только здесь' })
  async create(@Body() dto: CreateWebhookDto) {
    const endpoint = await this.webhooks.create(dto.url, dto.eventTypes);
    return { ...toWebhookView(endpoint), secret: endpoint.secret };
  }

  @Get()
  async list() {
    return (await this.webhooks.list()).map(toWebhookView);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.webhooks.remove(id);
  }
}
