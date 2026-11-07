import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpWalletGateway } from './http-wallet.gateway';
import { WalletRejectedError, WalletUnavailableError } from './wallet.gateway';

let server: Server;
let gateway: HttpWalletGateway;
let respond: (res: ServerResponse) => void;
let lastRequest: { method?: string; url?: string; key?: string | string[] };

beforeAll(async () => {
  server = createServer((req, res) => {
    lastRequest = { method: req.method, url: req.url, key: req.headers['idempotency-key'] };
    req.resume();
    req.on('end', () => respond(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  gateway = new HttpWalletGateway({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 300 });
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const json = (status: number, body: unknown) => (res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

describe('HttpWalletGateway', () => {
  it('передаёт Idempotency-Key и разбирает успешный ответ', async () => {
    respond = json(201, { id: 'h1', currency: 'RUB' });
    const hold = await gateway.createHold({
      idempotencyKey: 'payment:1:hold',
      accountId: 'a',
      amount: '10',
      reference: 'r',
    });
    expect(hold).toEqual({ id: 'h1', currency: 'RUB' });
    expect(lastRequest).toMatchObject({ method: 'POST', url: '/holds', key: 'payment:1:hold' });
  });

  it('getAccount — GET без тела', async () => {
    respond = json(200, { id: 'a', currency: 'RUB', kind: 'user', balance: '0' });
    await expect(gateway.getAccount('a')).resolves.toEqual({
      id: 'a',
      currency: 'RUB',
      kind: 'user',
    });
    expect(lastRequest).toMatchObject({ method: 'GET', url: '/accounts/a' });
  });

  it('4xx с кодом — бизнес-отказ с этим кодом', async () => {
    respond = json(422, { code: 'INSUFFICIENT_FUNDS', message: 'мало' });
    const error = await gateway.releaseHold('h').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletRejectedError);
    expect((error as WalletRejectedError).code).toBe('INSUFFICIENT_FUNDS');
  });

  it.each([408, 429, 500, 503])(
    'HTTP %i — сбой, исход неизвестен, можно повторять',
    async (status) => {
      respond = json(status, { code: 'X', message: 'x' });
      await expect(gateway.releaseHold('h')).rejects.toBeInstanceOf(WalletUnavailableError);
    },
  );

  it('обрыв соединения посреди тела ответа — недоступность, а не необработанная ошибка', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"id":');
      setTimeout(() => res.destroy(), 20);
    };
    await expect(gateway.releaseHold('h')).rejects.toBeInstanceOf(WalletUnavailableError);
  });

  it('невалидный JSON в успешном ответе — недоступность', async () => {
    respond = (res) => res.writeHead(200).end('не json');
    await expect(gateway.releaseHold('h')).rejects.toBeInstanceOf(WalletUnavailableError);
  });

  it('таймаут — недоступность', async () => {
    respond = () => undefined; // не отвечаем
    await expect(gateway.releaseHold('h')).rejects.toBeInstanceOf(WalletUnavailableError);
  });
});
