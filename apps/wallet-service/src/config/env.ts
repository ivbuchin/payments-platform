import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  /** Без AMQP_URL события остаются в outbox и не публикуются. */
  AMQP_URL: z.string().url().optional(),
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
