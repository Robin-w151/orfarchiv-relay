import { decodeRelayServerMessage, type RelayServerMessage } from '#common/relay/relay';
import { RELAY_PROTOCOL_VERSION, RelayCloseCode, RelayErrorCode } from '#common/relay/relay.constants';
import { randomBytes } from 'node:crypto';
import { Result } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DEFAULT_ALLOWED_ORIGINS } from './config';
import { parseAllowedOrigins } from './origins';
import { RATE_LIMIT_CLOSE_CODE, REPLACED_CLOSE_CODE, startRelayServer, type RelayServer } from './server';

const ALLOWED_ORIGIN = 'https://orfarchiv.news';

interface TestClient {
  readonly socket: WebSocket;
  readonly messages: Array<RelayServerMessage>;
  next(): Promise<RelayServerMessage>;
  closed: Promise<number>;
}

function roomId() {
  return randomBytes(32).toString('hex');
}

function peerId() {
  return randomBytes(16).toString('base64url');
}

function connect(server: RelayServer, options: { origin?: string; autoPong?: boolean } = {}): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    origin: options.origin ?? ALLOWED_ORIGIN,
    autoPong: options.autoPong ?? true,
  });
  const messages: Array<RelayServerMessage> = [];
  const waiting: Array<(message: RelayServerMessage) => void> = [];
  let read = 0;

  socket.on('message', (data) => {
    const message = Result.getOrThrow(decodeRelayServerMessage(data.toString()));
    messages.push(message);
    waiting.shift()?.(message);
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));

  const client: TestClient = {
    socket,
    messages,
    closed,
    next() {
      const index = read++;
      if (index < messages.length) {
        return Promise.resolve(messages[index]);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
  };

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(client));
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.once('error', reject);
  });
}

function sendJson(client: TestClient, message: unknown) {
  client.socket.send(JSON.stringify(message));
}

async function join(server: RelayServer, room: string, id = peerId(), version = RELAY_PROTOCOL_VERSION) {
  const client = await connect(server);
  sendJson(client, { type: 'join', room, peerId: id, version });
  return { client, id, first: await client.next() };
}

async function health(server: RelayServer) {
  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  return { status: response.status, body: await response.json() };
}

async function eventually(assertion: () => Promise<void> | void) {
  await vi.waitFor(assertion, { timeout: 2000, interval: 10 });
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

describe('relay server', () => {
  let server: RelayServer;
  const clients: Array<TestClient> = [];
  const consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));

  async function track<T extends { client: TestClient } | TestClient>(value: Promise<T>): Promise<T> {
    const resolved = await value;
    clients.push('client' in resolved ? resolved.client : resolved);
    return resolved;
  }

  beforeAll(async () => {
    server = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      maxConnections: 100,
      allowedOrigins: parseAllowedOrigins(DEFAULT_ALLOWED_ORIGINS),
      messagesPerSecond: 1000,
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.socket.terminate();
    }
    await eventually(async () =>
      expect((await health(server)).body).toEqual({ status: 'ok', rooms: 0, connections: 0 }),
    );
  });

  afterAll(async () => {
    await server.close();
    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  describe('http', () => {
    it('reports health with counts', async () => {
      expect(await health(server)).toEqual({ status: 200, body: { status: 'ok', rooms: 0, connections: 0 } });
    });

    it.each(['/', '/healthz', '/ws', '/health/x'])('responds 404 to %s', async (path) => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(response.status).toBe(404);
    });

    it('refuses upgrades on other paths', async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/other`, { origin: ALLOWED_ORIGIN });
      const status = await new Promise((resolve) =>
        socket.once('unexpected-response', (_request, response) => resolve(response.statusCode)),
      );
      expect(status).toBe(404);
    });
  });

  describe('origins', () => {
    it.each([
      'https://orfarchiv.news',
      'https://develop.orfarchiv.news',
      'https://orfarchiv-git-feat-x-robins-projects-bb10f956.vercel.app',
      'https://orfarchiv-abc123-robins-projects-bb10f956.vercel.app',
    ])('accepts %s with the default allow-list', async (origin) => {
      const client = await track(connect(server, { origin }));
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });

    it.each([
      'https://evil.vercel.app',
      'https://orfarchiv-a.b-robins-projects-bb10f956.vercel.app',
      'https://orfarchiv--robins-projects-bb10f956.vercel.app',
      'https://orfarchiv-x-robins-projects-bb10f956.vercel.app.evil.com',
      'http://orfarchiv.news',
      'https://orfarchiv.news:8443',
      'https://evil.orfarchiv.news',
      'https://evilorfarchiv.news',
      'null',
    ])('refuses %s with the default allow-list', async (origin) => {
      await expect(connect(server, { origin })).rejects.toThrow('HTTP 403');
    });

    it('accepts clients without an Origin header', async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.terminate();
    });
  });

  describe('rooms', () => {
    it('sends the peer list after a join and when someone joins', async () => {
      const room = roomId();
      const a = await track(join(server, room));
      expect(a.first).toEqual({ type: 'peers', peers: [] });

      const b = await track(join(server, room));
      expect(b.first).toEqual({ type: 'peers', peers: [a.id] });
      expect(await a.client.next()).toEqual({ type: 'peers', peers: [b.id] });
    });

    it('forwards a send only to the addressed peer with the same payload', async () => {
      const room = roomId();
      const a = await track(join(server, room));
      const b = await track(join(server, room));
      const c = await track(join(server, room));
      const payload = randomBytes(1024).toString('base64url');

      sendJson(a.client, { type: 'send', to: b.id, payload });

      await eventually(() => expect(b.client.messages.at(-1)).toEqual({ type: 'message', from: a.id, payload }));
      expect(c.client.messages.filter((message) => message.type === 'message')).toEqual([]);
      expect(a.client.messages.filter((message) => message.type !== 'peers')).toEqual([]);
    });

    it('answers UnknownPeer for a peer in another room and delivers nothing there', async () => {
      const r = roomId();
      const a = await track(join(server, r));
      await track(join(server, r));
      const s = await track(join(server, roomId()));

      sendJson(a.client, { type: 'send', to: s.id, payload: 'aGVsbG8' });

      expect(await a.client.next()).toEqual({ type: 'peers', peers: expect.any(Array) });
      expect(await a.client.next()).toEqual({ type: 'error', code: RelayErrorCode.UnknownPeer });
      sendJson(s.client, { type: 'send', to: peerId(), payload: '' });
      expect(await s.client.next()).toEqual({ type: 'error', code: RelayErrorCode.UnknownPeer });
      expect(s.client.messages).toEqual([
        { type: 'peers', peers: [] },
        { type: 'error', code: RelayErrorCode.UnknownPeer },
      ]);
    });

    it('answers NotJoined for a send before join', async () => {
      const client = await track(connect(server));
      sendJson(client, { type: 'send', to: peerId(), payload: '' });
      expect(await client.next()).toEqual({ type: 'error', code: RelayErrorCode.NotJoined });
    });

    it.each([
      ['invalid JSON', '{'],
      ['an unknown type', JSON.stringify({ type: 'leave' })],
      ['an invalid room ID', JSON.stringify({ type: 'join', room: 'x', peerId: peerId(), version: 1 })],
    ])('answers InvalidMessage for %s and keeps the socket open', async (_label, data) => {
      const client = await track(connect(server));
      client.socket.send(data);
      expect(await client.next()).toEqual({ type: 'error', code: RelayErrorCode.InvalidMessage });
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });

    it('answers InvalidMessage for a binary frame', async () => {
      const client = await track(connect(server));
      client.socket.send(Buffer.from(JSON.stringify({ type: 'send', to: peerId(), payload: '' })), { binary: true });
      expect(await client.next()).toEqual({ type: 'error', code: RelayErrorCode.InvalidMessage });
    });

    it('answers InvalidMessage for a second join on the same socket', async () => {
      const room = roomId();
      const a = await track(join(server, room));
      sendJson(a.client, { type: 'join', room: roomId(), peerId: peerId(), version: RELAY_PROTOCOL_VERSION });
      expect(await a.client.next()).toEqual({ type: 'error', code: RelayErrorCode.InvalidMessage });
      expect(a.client.socket.readyState).toBe(WebSocket.OPEN);
      expect((await health(server)).body.rooms).toBe(1);
    });

    it('answers UnsupportedVersion and closes for another protocol version', async () => {
      const a = await track(join(server, roomId(), peerId(), RELAY_PROTOCOL_VERSION + 1));
      expect(a.first).toEqual({ type: 'error', code: RelayErrorCode.UnsupportedVersion });
      expect(await a.client.closed).toBe(RelayCloseCode.UnsupportedVersion);
    });

    it('answers RoomFull and closes the 17th peer', async () => {
      const room = roomId();
      const members = [];
      for (let i = 0; i < 16; i++) {
        members.push(await track(join(server, room)));
      }
      expect(members.at(-1)?.first).toEqual({ type: 'peers', peers: expect.any(Array) });

      const extra = await track(join(server, room));
      expect(extra.first).toEqual({ type: 'error', code: RelayErrorCode.RoomFull });
      expect(await extra.client.closed).toBe(RelayCloseCode.RoomFull);
      const last = members.at(-1)!;
      expect(last.client.messages).toEqual([last.first]);
    });

    it('replaces the old socket when a peer ID rejoins', async () => {
      const room = roomId();
      const a = await track(join(server, room));
      const old = await track(join(server, room));
      await a.client.next();

      const fresh = await track(join(server, room, old.id));
      expect(fresh.first).toEqual({ type: 'peers', peers: [a.id] });
      expect(await old.client.closed).toBe(REPLACED_CLOSE_CODE);
      expect(await a.client.next()).toEqual({ type: 'peers', peers: [old.id] });

      const payload = 'cmVwbGFjZWQ';
      sendJson(a.client, { type: 'send', to: old.id, payload });
      expect(await fresh.client.next()).toEqual({ type: 'message', from: a.id, payload });
      expect(a.client.messages).toHaveLength(3);
    });

    it('sends an updated peer list when a peer leaves and deletes the empty room', async () => {
      const room = roomId();
      const a = await track(join(server, room));
      const b = await track(join(server, room));
      const c = await track(join(server, room));
      await a.client.next();
      await a.client.next();
      await b.client.next();
      expect((await health(server)).body).toEqual({ status: 'ok', rooms: 1, connections: 3 });

      c.client.socket.close();
      expect(await a.client.next()).toEqual({ type: 'peers', peers: [b.id] });
      expect(await b.client.next()).toEqual({ type: 'peers', peers: [a.id] });

      b.client.socket.close();
      expect(await a.client.next()).toEqual({ type: 'peers', peers: [] });
      expect((await health(server)).body.rooms).toBe(1);

      a.client.socket.close();
      await eventually(async () =>
        expect((await health(server)).body).toEqual({ status: 'ok', rooms: 0, connections: 0 }),
      );
    });
  });

  describe('limits', () => {
    it('closes a socket sending a 70 KiB frame with 1009 and keeps running', async () => {
      const room = roomId();
      const a = await track(join(server, room));
      const b = await track(join(server, room));

      sendJson(a.client, { type: 'send', to: b.id, payload: 'a'.repeat(70 * 1024) });

      expect(await a.client.closed).toBe(RelayCloseCode.TooLarge);
      expect(b.client.messages.filter((message) => message.type === 'message')).toEqual([]);
      expect((await health(server)).status).toBe(200);
      const c = await track(join(server, room));
      expect(c.first).toEqual({ type: 'peers', peers: [b.id] });
    });

    it('forwards a frame just under the size limit', async () => {
      const room = roomId();
      const a = await track(join(server, room));
      const b = await track(join(server, room));
      const payload = 'a'.repeat(64 * 1024 - 100);

      sendJson(a.client, { type: 'send', to: b.id, payload });

      await eventually(() => expect(b.client.messages.at(-1)).toEqual({ type: 'message', from: a.id, payload }));
    });
  });

  it('answers RateLimited over the limit and closes over 3x the limit', async () => {
    const limited = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      maxConnections: 10,
      allowedOrigins: [ALLOWED_ORIGIN],
      messagesPerSecond: 2,
    });
    try {
      const client = await connect(limited);
      for (let i = 0; i < 7; i++) {
        sendJson(client, { type: 'send', to: peerId(), payload: '' });
      }
      expect(await client.closed).toBe(RATE_LIMIT_CLOSE_CODE);
      expect(client.messages.map((message) => (message.type === 'error' ? message.code : message.type))).toEqual([
        RelayErrorCode.NotJoined,
        RelayErrorCode.NotJoined,
        RelayErrorCode.RateLimited,
        RelayErrorCode.RateLimited,
        RelayErrorCode.RateLimited,
        RelayErrorCode.RateLimited,
        RelayErrorCode.RateLimited,
      ]);
    } finally {
      await limited.close();
    }
  });

  it('closes new sockets with 1013 over the connection cap', async () => {
    const capped = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      maxConnections: 2,
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    try {
      const a = await connect(capped);
      const b = await connect(capped);
      const c = await connect(capped);
      expect(await c.closed).toBe(RelayCloseCode.ServerFull);
      expect(capped.stats().connections).toBe(2);

      a.socket.close();
      await a.closed;
      await eventually(() => expect(capped.stats().connections).toBe(1));
      const d = await connect(capped);
      expect(d.socket.readyState).toBe(WebSocket.OPEN);
      b.socket.terminate();
      d.socket.terminate();
    } finally {
      await capped.close();
    }
  });

  it('closes dead sockets after a missed ping', async () => {
    const pinging = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      maxConnections: 10,
      allowedOrigins: [ALLOWED_ORIGIN],
      pingIntervalMs: 50,
    });
    try {
      const alive = await connect(pinging);
      const dead = await connect(pinging, { autoPong: false });
      expect(await dead.closed).toBe(1006);
      expect(alive.socket.readyState).toBe(WebSocket.OPEN);
      alive.socket.terminate();
    } finally {
      await pinging.close();
    }
  });

  it('closes open sockets with 1001 on shutdown', async () => {
    const stopping = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      maxConnections: 10,
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    const client = await connect(stopping);
    await stopping.close();
    expect(await client.closed).toBe(1001);
  });
});

describe('join timeout', () => {
  let server: RelayServer;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startRelayServer({
      port: 0,
      host: '127.0.0.1',
      maxConnections: 10,
      allowedOrigins: [ALLOWED_ORIGIN],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
  });

  it('closes a socket that sends no join within 10 s with 4000', async () => {
    const client = await connect(server);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    await vi.advanceTimersByTimeAsync(1);
    expect(await client.closed).toBe(RelayCloseCode.JoinTimeout);
  });

  it('keeps a socket that joined in time', async () => {
    const client = await connect(server);
    sendJson(client, { type: 'join', room: roomId(), peerId: peerId(), version: RELAY_PROTOCOL_VERSION });
    await client.next();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.terminate();
  });
});
