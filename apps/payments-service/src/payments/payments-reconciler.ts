import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { PaymentsService } from './payments.service';

export const RECONCILER_OPTIONS = Symbol('RECONCILER_OPTIONS');

export interface ReconcilerOptions {
  /** Период запуска сверки; `0` отключает фоновый цикл (сверку можно вызвать вручную). */
  intervalMs: number;
  /** Возраст платежа в `created`, начиная с которого он считается зависшим. */
  staleAfterMs: number;
  /** Срок жизни авторизации: позже резерв снимается автоматически; `0` — не истекает. */
  authorizationTtlMs: number;
}

/** Фоновый цикл: доводит зависшие платежи (`created`) и снимает резерв с просроченных авторизаций. */
@Injectable()
export class PaymentsReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentsReconciler.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly payments: PaymentsService,
    @Inject(RECONCILER_OPTIONS) private readonly options: ReconcilerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.intervalMs > 0) this.schedule();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Следующий запуск планируется после завершения предыдущего: прогоны не накладываются. */
  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (!this.stopped) this.schedule();
      });
    }, this.options.intervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const settled = await this.payments.reconcileStale(this.options.staleAfterMs);
      if (settled > 0) this.logger.log(`Сверка: доведено платежей — ${settled}`);
      if (this.options.authorizationTtlMs > 0) {
        const expired = await this.payments.expireAuthorizations(this.options.authorizationTtlMs);
        if (expired > 0) this.logger.log(`Просроченных авторизаций отменено — ${expired}`);
      }
    } catch (error) {
      this.logger.error(`Сверка платежей завершилась ошибкой: ${String(error)}`);
    }
  }
}
