import { z } from 'zod';

/** Значения из документации: известны всем, поэтому ключи на их основе предсказуемы. */
const KNOWN_PLACEHOLDERS = ['change-me', 'сгенерируйте', 'dev-only'];

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3002),
  DATABASE_URL: z.string().url(),
  WALLET_URL: z.string().url(),
  /** Секрет вывода ключей идемпотентности вызовов wallet; менять нельзя — повторы потеряют связь с прежними операциями. */
  WALLET_KEY_SECRET: z
    .string()
    .min(16)
    .refine((value) => !KNOWN_PLACEHOLDERS.some((p) => value.includes(p)), {
      message: 'значение-пример из документации; задайте случайный секрет (openssl rand -hex 24)',
    }),
  WALLET_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /** Период фоновой сверки зависших платежей, мс; 0 — отключить. */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().nonnegative().default(15_000),
  RECONCILE_STALE_AFTER_MS: z.coerce.number().int().positive().default(30_000),
  /** Срок жизни авторизации, мс (по умолчанию 7 суток); 0 — резерв не снимается автоматически. */
  AUTHORIZATION_TTL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(7 * 24 * 3600_000),
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
