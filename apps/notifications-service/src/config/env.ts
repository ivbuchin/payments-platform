import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3003),
  DATABASE_URL: z.string().url(),
  /** Без AMQP_URL потребитель событий не стартует (сервис работает только как API вебхуков). */
  AMQP_URL: z.string().url().optional(),
  /** Разрешить вебхуки на localhost и частные сети. Только для локальной разработки. */
  ALLOW_PRIVATE_WEBHOOK_TARGETS: bool.default(false),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  DELIVERY_BASE_DELAY_MS: z.coerce.number().int().positive().default(2000),
  DELIVERY_MAX_DELAY_MS: z.coerce.number().int().positive().default(3_600_000),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export type Env = z.infer<typeof schema>;

/** Валидирует переменные окружения при старте: сервис падает сразу, а не в рантайме. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректное окружение: ${details}`);
  }
  return parsed.data;
}
