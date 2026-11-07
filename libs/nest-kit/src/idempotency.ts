import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

const MAX_KEY_LENGTH = 128;

/** Значение заголовка `Idempotency-Key`; обязателен для всех денежных мутаций. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const raw = ctx.switchToHttp().getRequest<Request>().header('idempotency-key')?.trim();
  if (!raw || raw.length > MAX_KEY_LENGTH) {
    throw new BadRequestException(
      `Заголовок Idempotency-Key обязателен (1–${MAX_KEY_LENGTH} символов)`,
    );
  }
  return raw;
});

/**
 * Отпечаток параметров запроса. Повтор с тем же ключом и тем же отпечатком возвращает прежний
 * результат, с другим — ошибка `IDEMPOTENCY_KEY_REUSED`.
 */
export function fingerprint(parts: readonly (string | bigint | null)[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts.map(String)))
    .digest('hex');
}
