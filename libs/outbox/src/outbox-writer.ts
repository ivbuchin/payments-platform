import { Injectable } from '@nestjs/common';
import type { NewEvent } from '@pp/contracts';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { OutboxEvent } from './outbox-event.entity';

@Injectable()
export class OutboxWriter {
  /** Добавляет событие в рамках переданной транзакции (`manager` обязан быть транзакционным). */
  async add(manager: EntityManager, event: NewEvent): Promise<void> {
    await manager.insert(OutboxEvent, {
      id: randomUUID(),
      type: event.type,
      payload: event.payload,
      occurredAt: new Date(),
      publishedAt: null,
      lockedUntil: null,
    });
  }
}
