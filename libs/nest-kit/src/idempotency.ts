import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

const MAX_KEY_LENGTH = 128;
/**
 * Допустимый алфавит клиентских ключей. Символы вне него (например, `#`) зарезервированы
 * за внутренними ключами сервисов, чтобы клиент не мог «занять» ключ внутренней операции.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Значение заголовка `Idempotency-Key`; обязателен для всех денежных мутаций. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const raw = ctx.switchToHttp().getRequest<Request>().header('idempotency-key')?.trim();
  if (!raw || raw.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(raw)) {
    throw new BadRequestException(
      `Заголовок Idempotency-Key обязателен (1–${MAX_KEY_LENGTH} символов: латиница, цифры, . _ : -)`,
    );
  }
  return raw;
});

/**
 * Отпечаток параметров запроса. Повтор с тем же ключом и тем же отпечатком возвращает прежний
 * результат, с другим — ошибка `IDEMPOTENCY_KEY_REUSED`.
 */
export function fingerprint(parts: readonly (string | bigint | null)[]): string {
  return (
    createHash('sha256')
      // `null` остаётся JSON-null, а не строкой "null": отсутствующее и буквальное значения различимы.
      .update(JSON.stringify(parts.map((part) => (part === null ? null : String(part)))))
      .digest('hex')
  );
}
