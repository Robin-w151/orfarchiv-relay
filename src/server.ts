import { decodeRelayClientMessage, encodeRelayServerMessage, type RelayServerMessage } from '#common/relay/relay';
import {
  RELAY_JOIN_TIMEOUT_MS,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_MAX_PEERS_PER_ROOM,
  RELAY_PING_INTERVAL_MS,
  RELAY_PROTOCOL_VERSION,
  RELAY_RATE_LIMIT_MESSAGES_PER_SECOND,
  RelayCloseCode,
  RelayErrorCode,
} from '#common/relay/relay.constants';
import { Result } from 'effect';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createOriginMatcher } from './origins';
import { RateLimitResult, TokenBucket } from './rateLimit';
import { Rooms } from './rooms';

export const RATE_LIMIT_CLOSE_CODE = 1008;
export const REPLACED_CLOSE_CODE = 1000;
export const SHUTDOWN_CLOSE_CODE = 1001;

const SHUTDOWN_GRACE_MS = 1000;

export interface RelayServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly maxConnections: number;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly maxPeersPerRoom?: number;
  readonly maxMessageBytes?: number;
  readonly messagesPerSecond?: number;
  readonly joinTimeoutMs?: number;
  readonly pingIntervalMs?: number;
}

export interface RelayStats {
  readonly rooms: number;
  readonly connections: number;
}

export interface RelayServer {
  readonly port: number;
  stats(): RelayStats;
  close(): Promise<void>;
}

interface Peer {
  readonly socket: WebSocket;
  readonly bucket: TokenBucket;
  alive: boolean;
  joined: { readonly room: string; readonly peerId: string } | undefined;
  joinTimer: NodeJS.Timeout | undefined;
}

export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const maxPeersPerRoom = options.maxPeersPerRoom ?? RELAY_MAX_PEERS_PER_ROOM;
  const messagesPerSecond = options.messagesPerSecond ?? RELAY_RATE_LIMIT_MESSAGES_PER_SECOND;
  const joinTimeoutMs = options.joinTimeoutMs ?? RELAY_JOIN_TIMEOUT_MS;
  const pingIntervalMs = options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
  const isOriginAllowed = createOriginMatcher(options.allowedOrigins);

  const rooms = new Rooms<Peer>(maxPeersPerRoom);
  const peers = new Set<Peer>();
  const http = createServer(handleRequest);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxMessageBytes ?? RELAY_MAX_MESSAGE_BYTES,
  });

  function stats(): RelayStats {
    return { rooms: rooms.size, connections: peers.size };
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse) {
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname(request) === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok', ...stats() }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'not found' }));
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy());
    if (pathname(request) !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !isOriginAllowed(origin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (peers.size >= options.maxConnections) {
        ws.on('error', () => {});
        ws.close(RelayCloseCode.ServerFull);
        return;
      }
      handleConnection(ws);
    });
  }

  function handleConnection(socket: WebSocket) {
    const peer: Peer = {
      socket,
      bucket: new TokenBucket(messagesPerSecond, Date.now()),
      alive: true,
      joined: undefined,
      joinTimer: undefined,
    };
    peer.joinTimer = setTimeout(() => socket.close(RelayCloseCode.JoinTimeout), joinTimeoutMs);
    peers.add(peer);

    socket.on('error', () => {});
    socket.on('pong', () => {
      peer.alive = true;
    });
    socket.on('message', (data, isBinary) => handleMessage(peer, data, isBinary));
    socket.on('close', () => handleClose(peer));
  }

  function handleMessage(peer: Peer, data: RawData, isBinary: boolean) {
    if (peer.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const limit = peer.bucket.take(Date.now());
    if (limit === RateLimitResult.Exceeded) {
      sendError(peer, RelayErrorCode.RateLimited);
      peer.socket.close(RATE_LIMIT_CLOSE_CODE);
      return;
    }
    if (limit === RateLimitResult.Limited) {
      sendError(peer, RelayErrorCode.RateLimited);
      return;
    }

    const decoded = isBinary ? undefined : decodeRelayClientMessage(rawDataToString(data));
    if (decoded === undefined || Result.isFailure(decoded)) {
      sendError(peer, RelayErrorCode.InvalidMessage);
      return;
    }

    const message = decoded.success;
    if (message.type === 'join') {
      handleJoin(peer, message.room, message.peerId, message.version);
    } else {
      handleSend(peer, message.to, message.payload);
    }
  }

  function handleJoin(peer: Peer, room: string, peerId: string, version: number) {
    if (peer.joined !== undefined) {
      sendError(peer, RelayErrorCode.InvalidMessage);
      return;
    }
    clearTimeout(peer.joinTimer);

    if (version !== RELAY_PROTOCOL_VERSION) {
      sendError(peer, RelayErrorCode.UnsupportedVersion);
      peer.socket.close(RelayCloseCode.UnsupportedVersion);
      return;
    }

    const result = rooms.join(room, peerId, peer);
    if (result.type === 'full') {
      sendError(peer, RelayErrorCode.RoomFull);
      peer.socket.close(RelayCloseCode.RoomFull);
      return;
    }

    peer.joined = { room, peerId };
    if (result.replaced !== undefined) {
      result.replaced.joined = undefined;
      result.replaced.socket.close(REPLACED_CLOSE_CODE);
    }
    broadcastPeers(room);
  }

  function handleSend(peer: Peer, to: string, payload: string) {
    if (peer.joined === undefined) {
      sendError(peer, RelayErrorCode.NotJoined);
      return;
    }
    const target = rooms.route(peer.joined.room, to);
    if (target === undefined) {
      sendError(peer, RelayErrorCode.UnknownPeer);
      return;
    }
    send(target, { type: 'message', from: peer.joined.peerId, payload });
  }

  function handleClose(peer: Peer) {
    clearTimeout(peer.joinTimer);
    peers.delete(peer);
    const joined = peer.joined;
    peer.joined = undefined;
    if (joined !== undefined && rooms.leave(joined.room, joined.peerId, peer)) {
      broadcastPeers(joined.room);
    }
  }

  function broadcastPeers(room: string) {
    const members = rooms.members(room);
    for (const [peerId, member] of members) {
      send(member, { type: 'peers', peers: members.map(([id]) => id).filter((id) => id !== peerId) });
    }
  }

  function sendError(peer: Peer, code: RelayErrorCode) {
    send(peer, { type: 'error', code });
  }

  function send(peer: Peer, message: RelayServerMessage) {
    if (peer.socket.readyState === WebSocket.OPEN) {
      peer.socket.send(encodeRelayServerMessage(message));
    }
  }

  const pingTimer = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      peer.socket.ping();
    }
  }, pingIntervalMs);

  http.on('upgrade', handleUpgrade);

  function close(): Promise<void> {
    clearInterval(pingTimer);
    return new Promise((resolve) => {
      let pending = 2;
      const done = () => {
        pending -= 1;
        if (pending === 0) {
          clearTimeout(forceTimer);
          resolve();
        }
      };
      const forceTimer = setTimeout(() => {
        for (const client of wss.clients) {
          client.terminate();
        }
        http.closeAllConnections();
      }, SHUTDOWN_GRACE_MS);

      http.close(done);
      wss.close(done);
      http.closeIdleConnections();
      for (const client of wss.clients) {
        client.close(SHUTDOWN_CLOSE_CODE);
      }
    });
  }

  return new Promise((resolve, reject) => {
    http.once('error', (error) => {
      clearInterval(pingTimer);
      reject(error);
    });
    http.listen(options.port, options.host, () => {
      const { port } = http.address() as AddressInfo;
      resolve({ port, stats, close });
    });
  });
}

function pathname(request: IncomingMessage): string {
  return new URL(request.url ?? '/', 'http://relay').pathname;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}
