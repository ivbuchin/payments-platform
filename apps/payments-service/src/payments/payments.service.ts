import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PaymentStatus } from '@pp/contracts';
import { fingerprint, isUniqueViolation } from '@pp/nest-kit';
import { OutboxWriter } from '@pp/outbox';
import { createHmac } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import {
  WalletGateway,
  WalletRejectedError,
  WalletUnavailableError,
} from '../wallet/wallet.gateway';
import { DomainError } from './domain-error';
import { canTransition } from './payment-status';
import { PaymentTransition } from './payment-transition.entity';
import { Payment } from './payment.entity';

export interface CreatePaymentInput {
  idempotencyKey: string;
  payerAccountId: string;
  merchantAccountId: string;
  amount: bigint;
  currency: string;
}

/**
 * Оркестрация платежа поверх wallet-service.
 *
 * Принципы надёжности:
 *  1. Намерение (`created`) фиксируется в БД до обращения к wallet — после сбоя есть что продолжать.
 *  2. Все вызовы wallet идемпотентны, ключи выводятся из id платежа: повтор не удваивает списание.
 *  3. Переходы статуса — compare-and-set (`UPDATE … WHERE status = :from`), без долгих блокировок
 *     на время сетевых вызовов; проигравший гонку перечитывает актуальное состояние.
 *  4. Переход, запись журнала и событие outbox атомарны.
 */
/** Текущая схема ключей wallet; платежи с `keyVersion` 1 используют прежние предсказуемые ключи. */
const CURRENT_KEY_VERSION = 2;

/** Секрет, из которого выводятся ключи идемпотентности вызовов wallet. */
export const WALLET_KEY_SECRET = Symbol('WALLET_KEY_SECRET');

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly wallet: WalletGateway,
    private readonly outbox: OutboxWriter,
    @Inject(WALLET_KEY_SECRET) private readonly walletKeySecret: string,
  ) {}

  /**
   * Ключ идемпотентности вызова wallet. Детерминирован (повтор не удваивает операцию), но
   * непредсказуем без секрета: клиент, знающий id платежа, не может заранее занять ключ в
   * общем пространстве `Idempotency-Key` wallet и заблокировать возврат или резерв.
   *
   * Схема зависит от `payment.keyVersion`: операция, начатая до обновления, могла выполниться в
   * wallet под прежним ключом, и повтор обязан его использовать — иначе деньги уйдут дважды.
   * Секрет менять нельзя (повторы потеряют связь с выполненными операциями); для ротации нужна
   * новая версия схемы, а не замена значения.
   */
  private walletKey(operation: 'hold' | 'refund', payment: Payment): string {
    if (payment.keyVersion < 2) return `payment:${payment.id}:${operation}`;
    const digest = createHmac('sha256', this.walletKeySecret)
      .update(`${operation}:${payment.id}`)
      .digest('hex');
    return `i${digest}`;
  }

  /**
   * Создаёт платёж и авторизует его (резервирует средства). Повтор с тем же ключом возвращает
   * тот же платёж; если прошлая попытка оборвалась на `created`, авторизация доводится до конца.
   */
  async create(input: CreatePaymentInput): Promise<Payment> {
    if (input.payerAccountId === input.merchantAccountId) {
      throw new DomainError('SAME_ACCOUNT', 'Плательщик и мерчант не могут совпадать');
    }
    const requestHash = fingerprint([
      input.payerAccountId,
      input.merchantAccountId,
      input.amount,
      input.currency,
    ]);

    const existing = await this.findByKey(input.idempotencyKey);
    if (existing) return this.resume(this.replay(existing, requestHash));

    let payment: Payment;
    try {
      payment = await this.dataSource.transaction(async (manager) => {
        const created = await manager.save(
          manager.create(Payment, {
            idempotencyKey: input.idempotencyKey,
            requestHash,
            payerAccountId: input.payerAccountId,
            merchantAccountId: input.merchantAccountId,
            amount: input.amount,
            currency: input.currency,
            status: 'created',
            keyVersion: CURRENT_KEY_VERSION,
          }),
        );
        await this.publishStatus(manager, created);
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.findByKey(input.idempotencyKey);
        if (winner) return this.resume(this.replay(winner, requestHash));
      }
      throw error;
    }
    return this.authorizeOrReportId(payment);
  }

  /**
   * Платёж, оборвавшийся на `created`, виден клиенту только по идентификатору из ошибки 503:
   * повтор с тем же ключом, `POST /cancel` или фоновая сверка доведут его до итогового статуса.
   */
  private async authorizeOrReportId(payment: Payment): Promise<Payment> {
    try {
      return await this.authorize(payment);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WALLET_UNAVAILABLE') {
        throw new DomainError(
          'WALLET_UNAVAILABLE',
          `${error.message}. Платёж ${payment.id} создан и будет доведён автоматически`,
        );
      }
      throw error;
    }
  }

  /**
   * Сверка зависших платежей: `created` старше `olderThanMs` означает, что авторизация оборвалась
   * (таймаут wallet, падение процесса). `authorize` идемпотентен и построен на CAS, поэтому сверку
   * безопасно запускать параллельно с клиентскими повторами и на нескольких репликах.
   * Возвращает число платежей, доведённых до итогового статуса.
   */
  async reconcileStale(olderThanMs: number, limit = 50): Promise<number> {
    const stale = await this.dataSource.manager
      .createQueryBuilder(Payment, 'p')
      .where("p.status = 'created' AND p.updated_at < now() - make_interval(secs => :secs)", {
        secs: olderThanMs / 1000,
      })
      .orderBy('p.updated_at', 'ASC')
      .limit(limit)
      .getMany();

    let settled = 0;
    for (const payment of stale) {
      try {
        if ((await this.authorize(payment)).status !== 'created') settled++;
      } catch (error) {
        this.logger.warn(`Сверка платежа ${payment.id} не удалась: ${String(error)}`);
      }
    }
    return settled;
  }

  /**
   * Снимает резерв у авторизованных платежей старше `ttlMs`, которые мерчант так и не списал и не
   * отменил: иначе деньги плательщика заморожены бессрочно. Использует обычный `cancel`; проигранная
   * гонка с `capture` (wallet отклонит снятие) не ошибка — платёж просто остаётся как есть.
   * Возвращает число отменённых платежей.
   */
  async expireAuthorizations(ttlMs: number, limit = 50): Promise<number> {
    const expired = await this.dataSource.manager
      .createQueryBuilder(Payment, 'p')
      .where("p.status = 'authorized' AND p.updated_at < now() - make_interval(secs => :secs)", {
        secs: ttlMs / 1000,
      })
      .orderBy('p.updated_at', 'ASC')
      .limit(limit)
      .getMany();

    let canceled = 0;
    for (const payment of expired) {
      try {
        await this.cancel(payment.id);
        canceled++;
      } catch (error) {
        this.logger.warn(`Истечение авторизации ${payment.id} не удалось: ${String(error)}`);
      }
    }
    return canceled;
  }

  async get(id: string): Promise<{ payment: Payment; history: PaymentTransition[] }> {
    const payment = await this.dataSource.manager.findOneBy(Payment, { id });
    if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', `Платёж ${id} не найден`);
    const history = await this.dataSource.manager.find(PaymentTransition, {
      where: { paymentId: id },
      order: { id: 'ASC' },
    });
    return { payment, history };
  }

  /** Списывает зарезервированные средства в пользу мерчанта. */
  async capture(id: string): Promise<Payment> {
    const payment = await this.load(id);
    if (payment.status === 'captured') return payment;
    this.assertTransition(payment, 'captured');

    const { transferId } = await this.callWallet(() =>
      this.wallet.captureHold(payment.holdId!, payment.merchantAccountId),
    ).catch(this.rejectedAs('PAYMENT_STATE_CONFLICT', 'Wallet отклонил списание'));

    return this.expect(
      await this.move(payment, 'captured', { captureTransferId: transferId }),
      'captured',
    );
  }

  /** Отменяет авторизованный платёж и снимает резерв. */
  async cancel(id: string): Promise<Payment> {
    let payment = await this.load(id);
    if (payment.status === 'canceled') return payment;
    // Оборванная авторизация: холд в wallet мог быть создан, а платёж об этом не знает.
    // Сначала доводим авторизацию (идемпотентно по ключу холда), затем отменяем как обычно.
    if (payment.status === 'created') payment = await this.authorizeOrReportId(payment);
    this.assertTransition(payment, 'canceled');

    await this.callWallet(() => this.wallet.releaseHold(payment.holdId!)).catch(
      this.rejectedAs('PAYMENT_STATE_CONFLICT', 'Wallet отклонил снятие резерва'),
    );
    return this.expect(await this.move(payment, 'canceled'), 'canceled');
  }

  /** Полный возврат: обратный перевод от мерчанта плательщику. */
  async refund(id: string): Promise<Payment> {
    const payment = await this.load(id);
    if (payment.status === 'refunded') return payment;
    this.assertTransition(payment, 'refunded');

    const { transferId } = await this.callWallet(() =>
      this.wallet.transfer({
        idempotencyKey: this.walletKey('refund', payment),
        fromAccountId: payment.merchantAccountId,
        toAccountId: payment.payerAccountId,
        amount: payment.amount.toString(),
        reference: payment.id,
      }),
    ).catch(this.rejectedAs('REFUND_REJECTED', 'Возврат отклонён'));

    return this.expect(
      await this.move(payment, 'refunded', { refundTransferId: transferId }),
      'refunded',
    );
  }

  /** Резервирует средства. Бизнес-отказ wallet → `failed`; недоступность → платёж остаётся `created`. */
  private async authorize(payment: Payment): Promise<Payment> {
    try {
      await this.assertMerchant(payment);
      const hold = await this.callWallet(() =>
        this.wallet.createHold({
          idempotencyKey: this.walletKey('hold', payment),
          accountId: payment.payerAccountId,
          amount: payment.amount.toString(),
          reference: payment.id,
        }),
      );
      if (hold.currency !== payment.currency) {
        await this.callWallet(() => this.wallet.releaseHold(hold.id));
        return await this.move(payment, 'failed', { failureReason: 'CURRENCY_MISMATCH' });
      }
      const moved = await this.move(payment, 'authorized', { holdId: hold.id });
      // Проиграли гонку повторов: платёж уже `failed`, а холд создан — снимаем его, иначе
      // средства останутся замороженными без платежа. Иные итоги (тот же холд) оставляем как есть.
      if (moved.holdId !== hold.id) await this.callWallet(() => this.wallet.releaseHold(hold.id));
      return moved;
    } catch (error) {
      if (error instanceof WalletRejectedError) {
        return this.move(payment, 'failed', { failureReason: error.code });
      }
      throw error;
    }
  }

  /** Счёт мерчанта проверяется до резервирования: иначе деньги плательщика замёрзли бы зря. */
  private async assertMerchant(payment: Payment): Promise<void> {
    const merchant = await this.callWallet(() => this.wallet.getAccount(payment.merchantAccountId));
    if (merchant.kind !== 'user') {
      throw new WalletRejectedError('MERCHANT_ACCOUNT_INVALID', 'Счёт мерчанта недопустим');
    }
    if (merchant.currency !== payment.currency) {
      throw new WalletRejectedError('CURRENCY_MISMATCH', 'Валюта счёта мерчанта не совпадает');
    }
  }

  private resume(payment: Payment): Promise<Payment> | Payment {
    return payment.status === 'created' ? this.authorizeOrReportId(payment) : payment;
  }

  /**
   * Compare-and-set перехода. Возвращает актуальную строку: если переход выполнил другой запрос,
   * это уже обновлённый платёж, и вызывающий проверяет итоговый статус через `expect`.
   */
  private async move(
    payment: Payment,
    to: PaymentStatus,
    patch: Partial<
      Pick<Payment, 'holdId' | 'captureTransferId' | 'refundTransferId' | 'failureReason'>
    > = {},
  ): Promise<Payment> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(Payment)
        .set({ ...patch, status: to, updatedAt: () => 'now()' })
        .where('id = :id AND status = :from', { id: payment.id, from: payment.status })
        .execute();

      const current = await manager.findOneByOrFail(Payment, { id: payment.id });
      if (result.affected === 1) {
        await manager.insert(PaymentTransition, {
          paymentId: payment.id,
          fromStatus: payment.status,
          toStatus: to,
        });
        await this.publishStatus(manager, current);
      }
      return current;
    });
  }

  private publishStatus(manager: EntityManager, payment: Payment): Promise<void> {
    return this.outbox.add(manager, {
      type: 'payment.status_changed',
      payload: {
        paymentId: payment.id,
        status: payment.status,
        amount: payment.amount.toString(),
        currency: payment.currency,
        payerAccountId: payment.payerAccountId,
        merchantAccountId: payment.merchantAccountId,
        failureReason: payment.failureReason,
      },
    });
  }

  private async load(id: string): Promise<Payment> {
    return (await this.get(id)).payment;
  }

  private findByKey(idempotencyKey: string): Promise<Payment | null> {
    return this.dataSource.manager.findOneBy(Payment, { idempotencyKey });
  }

  private replay(existing: Payment, requestHash: string): Payment {
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key уже использован с другими параметрами',
      );
    }
    return existing;
  }

  private assertTransition(payment: Payment, to: PaymentStatus): void {
    if (!canTransition(payment.status, to)) {
      throw new DomainError(
        'PAYMENT_STATE_CONFLICT',
        `Платёж в статусе ${payment.status}, переход в ${to} невозможен`,
      );
    }
  }

  /** После проигранной гонки допустим только тот же итог; иной статус — конфликт. */
  private expect(payment: Payment, status: PaymentStatus): Payment {
    if (payment.status !== status) {
      throw new DomainError(
        'PAYMENT_STATE_CONFLICT',
        `Платёж параллельно переведён в ${payment.status}`,
      );
    }
    return payment;
  }

  /** Сетевой сбой wallet превращаем в 503; бизнес-отказ (`WalletRejectedError`) пробрасываем. */
  private async callWallet<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WalletUnavailableError) {
        throw new DomainError(
          'WALLET_UNAVAILABLE',
          'wallet-service временно недоступен, повторите запрос',
        );
      }
      throw error;
    }
  }

  private rejectedAs(code: 'PAYMENT_STATE_CONFLICT' | 'REFUND_REJECTED', prefix: string) {
    return (error: unknown): never => {
      if (error instanceof WalletRejectedError) {
        throw new DomainError(code, `${prefix}: ${error.message}`);
      }
      throw error;
    };
  }
}
