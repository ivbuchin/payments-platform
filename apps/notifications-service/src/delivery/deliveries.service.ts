import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DomainError } from '../domain-error';
import { WebhookDelivery, type DeliveryStatus } from './delivery.entity';

@Injectable()
export class DeliveriesService {
  constructor(private readonly dataSource: DataSource) {}

  list(status: DeliveryStatus | undefined, limit: number): Promise<WebhookDelivery[]> {
    return this.dataSource.manager.find(WebhookDelivery, {
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async get(id: string): Promise<WebhookDelivery> {
    const delivery = await this.dataSource.manager.findOneBy(WebhookDelivery, { id });
    if (!delivery) throw new DomainError('DELIVERY_NOT_FOUND', `Доставка ${id} не найдена`);
    return delivery;
  }

  /** Ручной перезапуск «мёртвой» доставки: счётчик попыток обнуляется. */
  async retry(id: string): Promise<WebhookDelivery> {
    const result = await this.dataSource.manager
      .createQueryBuilder()
      .update(WebhookDelivery)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: () => 'now()', lastError: null })
      .where('id = :id AND status = :status', { id, status: 'dead' })
      .execute();

    const delivery = await this.get(id);
    if (!result.affected) {
      throw new DomainError(
        'DELIVERY_STATE_CONFLICT',
        `Доставка в статусе ${delivery.status}, а не dead`,
      );
    }
    return delivery;
  }
}
