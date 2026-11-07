import { ApiProperty } from '@nestjs/swagger';
import { EVENT_TYPES } from '@pp/contracts';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsUrl,
  MaxLength,
} from 'class-validator';
import type { WebhookEndpoint } from './webhook-endpoint.entity';

export const SUBSCRIBABLE = [...EVENT_TYPES, '*'] as const;

export class CreateWebhookDto {
  @ApiProperty({ example: 'https://shop.example.com/hooks/pp' })
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  url: string;

  @ApiProperty({ enum: SUBSCRIBABLE, isArray: true, example: ['payment.status_changed'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SUBSCRIBABLE.length)
  @ArrayUnique()
  @IsIn(SUBSCRIBABLE, { each: true })
  eventTypes: string[];
}

export const toWebhookView = (w: WebhookEndpoint) => ({
  id: w.id,
  url: w.url,
  eventTypes: w.eventTypes,
  createdAt: w.createdAt,
});
