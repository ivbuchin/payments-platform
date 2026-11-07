import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from '../webhooks/url-guard';

export interface PostWebhookOptions {
  headers: OutgoingHttpHeaders;
  body: string;
  timeoutMs: number;
  /** Разрешить локальные и частные адреса (только разработка и тесты). */
  allowPrivate: boolean;
}

/** Код ответа получателя; любой сетевой сбой — исключение (см. `describeNetworkFailure`). */
export class WebhookNetworkError extends Error {}

/** Резолв с проверкой: адрес проверяется там же, где используется, поэтому подмена DNS бессильна. */
function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 4);
      const allowed = (addresses as LookupAddress[]).filter(
        ({ address }) => allowPrivate || isPublicAddress(address),
      );
      if (allowed.length === 0) {
        return callback(new WebhookNetworkError('адрес запрещён политикой'), '', 4);
      }
      if (options.all) return callback(null, allowed);
      return callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
}

/**
 * POST JSON-вебхука. Не следует редиректам (публичный URL не может перенаправить нас во внутреннюю
 * сеть) и подключается только к адресам, прошедшим `isPublicAddress`.
 */
export function postWebhook(url: string, options: PostWebhookOptions): Promise<number> {
  const target = new URL(url);
  // Для IP-литералов Node не вызывает `lookup`, поэтому проверяем их отдельно.
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!options.allowPrivate && isIP(host) && !isPublicAddress(host)) {
    return Promise.reject(new WebhookNetworkError('адрес запрещён политикой'));
  }
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<number>((resolve, reject) => {
    const request = send(
      target,
      {
        method: 'POST',
        headers: { ...options.headers, 'content-length': Buffer.byteLength(options.body) },
        lookup: guardedLookup(options.allowPrivate),
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (response) => {
        response.resume(); // тело не нужно, но сокет надо освободить
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

/**
 * Единое сообщение для всех сетевых сбоев. Различие «отказ в соединении / ошибка TLS / таймаут»
 * превратило бы `lastError` в оракул для сканирования портов внутренней сети.
 */
export function describeNetworkFailure(error: unknown): string {
  return error instanceof WebhookNetworkError
    ? 'адрес получателя запрещён политикой безопасности'
    : 'не удалось выполнить запрос к получателю (сеть, TLS или таймаут)';
}
