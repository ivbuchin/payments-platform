import { QueryFailedError } from 'typeorm';

const UNIQUE_VIOLATION = '23505';

/** Нарушение уникального ограничения (в т.ч. гонка двух запросов с одним Idempotency-Key). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION
  );
}
