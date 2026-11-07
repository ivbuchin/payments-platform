/**
 * Базовая бизнес-ошибка. Каждый сервис наследует её и задаёт собственный набор кодов;
 * общий фильтр превращает любую такую ошибку в `{ code, message }` с нужным HTTP-статусом.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
