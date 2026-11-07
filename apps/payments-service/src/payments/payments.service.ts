import { Injectable } from '@nestjs/common';
import type { PaymentStatus } from '@pp/contracts';
import { fingerprint, isUniqueViolation } from '@pp/nest-kit';
import { OutboxWriter } from '@pp/outbox';
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
@Injectable()
export class PaymentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly wallet: WalletGateway,
    private readonly outbox: OutboxWriter,
  ) {}

  /**
   * Создаёт платёж и авторизует его (резервирует средства). Повтор с тем же ключом возвращает
   * тот же платёж; если прошлая попытка оборвалась на `created`, авторизация доводится до конца.
   */
  async create(input: CreatePaymentInput): Promise<Payment> {
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
    return this.authorize(payment);
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
    const payment = await this.load(id);
    if (payment.status === 'canceled') return payment;
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
        idempotencyKey: `payment:${payment.id}:refund`,
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
      const hold = await this.callWallet(() =>
        this.wallet.createHold({
          idempotencyKey: `payment:${payment.id}:hold`,
          accountId: payment.payerAccountId,
          amount: payment.amount.toString(),
          reference: payment.id,
        }),
      );
      if (hold.currency !== payment.currency) {
        await this.callWallet(() => this.wallet.releaseHold(hold.id));
        return await this.move(payment, 'failed', { failureReason: 'CURRENCY_MISMATCH' });
      }
      return await this.move(payment, 'authorized', { holdId: hold.id });
    } catch (error) {
      if (error instanceof WalletRejectedError) {
        return this.move(payment, 'failed', { failureReason: error.code });
      }
      throw error;
    }
  }

  private resume(payment: Payment): Promise<Payment> | Payment {
    return payment.status === 'created' ? this.authorize(payment) : payment;
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
