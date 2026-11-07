import { isIP } from 'node:net';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

/**
 * Первая линия защиты от SSRF: запрещаем http(s)-адреса, указывающие на локальные и частные сети.
 * Ограничение: проверяется только адрес в URL; защита от DNS rebinding требует резолва при отправке
 * (см. docs/adr/0003-webhook-delivery.md).
 */
export function checkWebhookUrl(raw: string, allowPrivate: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'некорректный URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'допустимы только http и https';
  if (url.username || url.password) return 'учётные данные в URL запрещены';
  if (allowPrivate) return null;
  if (url.protocol !== 'https:') return 'в этом окружении допустим только https';

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return 'адрес указывает на локальную сеть';
  }
  const family = isIP(host);
  if (family === 4 && PRIVATE_V4.some((re) => re.test(host))) return 'частный IPv4-адрес';
  if (
    family === 6 &&
    (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))
  ) {
    return 'локальный IPv6-адрес';
  }
  return null;
}
