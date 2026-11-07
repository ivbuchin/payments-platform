import { EVENT_TYPES, type EventEnvelope } from '@pp/contracts';
import { z } from 'zod';

const envelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(EVENT_TYPES),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});

/** Разбор тела сообщения. Возвращает `null` для «ядовитых» сообщений — они уходят в DLQ, а не в ретраи. */
export function parseEnvelope(raw: Buffer): EventEnvelope<string, unknown> | null {
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
