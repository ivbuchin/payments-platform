import { BlockList, isIP } from 'node:net';

/**
 * Защита от SSRF в две линии:
 *  1. `checkWebhookUrl` — при регистрации подписки: схема, учётные данные, адрес в URL.
 *  2. `isPublicAddress` — при каждом исходящем соединении (см. `post-webhook.ts`): проверяется
 *     адрес, в который ОС реально резолвит имя. Это закрывает DNS rebinding и имена вроде
 *     `internal.example.com → 10.0.0.5`, которые первая линия увидеть не может.
 */
const NON_PUBLIC = new BlockList();

const V4_RANGES: readonly [string, number][] = [
  ['0.0.0.0', 8], // «этот» хост
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, метаданные облаков
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // документация
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // бенчмарки
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // зарезервировано + broadcast
];
const V6_RANGES: readonly [string, number][] = [
  ['::', 96], // unspecified, loopback и IPv4-compatible (`::127.0.0.1`)
  ['64:ff9b::', 96], // NAT64: 64:ff9b::7f00:1 ведёт на 127.0.0.1
  ['64:ff9b:1::', 48],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // документация
  ['2002::', 16], // 6to4: внутри зашит IPv4
  ['fc00::', 7], // ULA
  ['fe80::', 10], // link-local
  ['fec0::', 10], // устаревший site-local
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of V4_RANGES) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6_RANGES) NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

/** Имена, которые заведомо ведут во внутреннюю сеть (в том числе однокомпонентные: `intranet`). */
const INTERNAL_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain', '.lan', '.home'];

/** `true`, если адрес публичный. Нераспознанный адрес считается непубличным. */
export function isPublicAddress(address: string): boolean {
  // IPv4-mapped (`::ffff:a.b.c.d`) Node сопоставляет с IPv4-правилами сам; правило для всего
  // `::ffff:0:0/96` нельзя: оно же перекрыло бы любой обычный IPv4.
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function isInternalHostname(host: string): boolean {
  return (
    host === 'localhost' || !host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))
  );
}

/**
 * Проверка URL подписки. Возвращает причину отказа либо `null`.
 * В режиме `allowPrivate` (разработка, тесты) локальные адреса разрешены, схемы — нет.
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

  // Хвостовая точка (`localhost.`) — тот же хост; квадратные скобки у IPv6 снимаем.
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  if (isIP(host)) return isPublicAddress(host) ? null : 'адрес не из публичной сети';
  return isInternalHostname(host) ? 'адрес указывает на локальную сеть' : null;
}
