import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Подписка внешней системы на события. */
@Entity('webhook_endpoints')
export class WebhookEndpoint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  url: string;

  /** Ключ HMAC. Хранится открытым, потому что нужен для подписи; наружу отдаётся один раз при создании. */
  @Column({ type: 'text' })
  secret: string;

  /** Типы событий или `*` для всех. */
  @Column({ type: 'text', array: true, name: 'event_types' })
  eventTypes: string[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
