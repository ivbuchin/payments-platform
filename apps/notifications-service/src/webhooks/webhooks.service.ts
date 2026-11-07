import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { DomainError } from '../domain-error';
import { checkWebhookUrl } from './url-guard';
import { WebhookEndpoint } from './webhook-endpoint.entity';

export const ALLOW_PRIVATE_TARGETS = Symbol('ALLOW_PRIVATE_TARGETS');

@Injectable()
export class WebhooksService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(ALLOW_PRIVATE_TARGETS) private readonly allowPrivate: boolean,
  ) {}

  /** Возвращает эндпоинт вместе с секретом — единственный раз, когда он виден клиенту. */
  async create(url: string, eventTypes: string[]): Promise<WebhookEndpoint> {
    const problem = checkWebhookUrl(url, this.allowPrivate);
    if (problem) throw new DomainError('WEBHOOK_URL_REJECTED', `URL отклонён: ${problem}`);

    const manager = this.dataSource.manager;
    return manager.save(
      manager.create(WebhookEndpoint, {
        url,
        eventTypes,
        secret: `whsec_${randomBytes(32).toString('hex')}`,
      }),
    );
  }

  list(): Promise<WebhookEndpoint[]> {
    return this.dataSource.manager.find(WebhookEndpoint, { order: { createdAt: 'DESC' } });
  }

  async remove(id: string): Promise<void> {
    const result = await this.dataSource.manager.delete(WebhookEndpoint, { id });
    if (!result.affected) throw new DomainError('WEBHOOK_NOT_FOUND', `Вебхук ${id} не найден`);
  }
}
