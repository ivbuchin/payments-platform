import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from './domain-error';

/** Единый формат бизнес-ошибок: `{ code, message }`. Остальные исключения обрабатывает Nest. */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter<DomainError> {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(error: DomainError, host: ArgumentsHost): void {
    this.logger.warn(`${error.code}: ${error.message}`);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(error.httpStatus)
      .json({ code: error.code, message: error.message });
  }
}
