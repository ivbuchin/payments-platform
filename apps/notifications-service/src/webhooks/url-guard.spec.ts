import { checkWebhookUrl, isPublicAddress } from './url-guard';

describe('checkWebhookUrl', () => {
  it.each(['https://hooks.example.com/pp', 'https://8.8.8.8/x'])('пропускает %s', (url) => {
    expect(checkWebhookUrl(url, false)).toBeNull();
  });

  it.each([
    'http://hooks.example.com/pp',
    'https://localhost/x',
    'https://svc.localhost/x',
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://172.20.1.1/x',
    'https://192.168.1.10/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::127.0.0.1]/x',
    'https://[::ffff:7f00:1]/x',
    'https://[::]/x',
    'https://[fec0::1]/x',
    'https://[64:ff9b::7f00:1]/x',
    'https://[2002:7f00:1::]/x',
    'https://100.64.0.1/x',
    'https://198.18.0.1/x',
    'https://224.0.0.1/x',
    'https://0.0.0.0/x',
    'https://localhost./x',
    'https://intranet/x',
    'https://printer.local/x',
    'https://user:pass@hooks.example.com/x',
    'ftp://hooks.example.com/x',
    'не url',
  ])('отклоняет %s', (url) => {
    expect(checkWebhookUrl(url, false)).not.toBeNull();
  });

  it('считает публичными только внешние адреса', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('не адрес')).toBe(false);
  });

  it('в режиме разработки разрешает локальные адреса, но не чужие схемы', () => {
    expect(checkWebhookUrl('http://127.0.0.1:9000/hook', true)).toBeNull();
    expect(checkWebhookUrl('ftp://127.0.0.1/x', true)).not.toBeNull();
  });
});
