# orfarchiv-relay

Stateless WebSocket relay for ORF Archiv bookmark sync. Devices join a room and forward opaque, end-to-end encrypted
messages to each other. The wire protocol lives in [orfarchiv-shared](https://github.com/Robin-w151/orfarchiv-shared)
(`src/relay/`).

## Endpoints

- `GET /health` → `{"status":"ok","rooms":<n>,"connections":<n>}`
- `/ws` → WebSocket

## Configuration

| Variable                | Default                                                                                                         | Description                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8080`                                                                                                          | HTTP/WebSocket port                                                                                |
| `RELAY_MAX_CONNECTIONS` | `2000`                                                                                                          | Total connection cap, further sockets are closed with 1013                                         |
| `RELAY_ALLOWED_ORIGINS` | `https://orfarchiv.news,https://develop.orfarchiv.news,https://orfarchiv-*-robins-projects-bb10f956.vercel.app` | Comma-separated `Origin` allow-list. `*` matches one or more of `[a-z0-9-]` in the host, never `.` |

## Security model

- Nothing is persisted: rooms only exist in memory and are dropped on restart.
- The relay only sees room IDs, peer IDs, ciphertext, IP addresses and timing. It never logs IDs, payloads or IP
  addresses, only start/stop, counts and errors.
- Messages are only forwarded to peers in the same room. Frame size, peers per room, message rate and the total number
  of connections are limited.
- Upgrades with an `Origin` header that is not on the allow-list are refused with 403. This stops other websites, not
  scripts, which can fake or omit the header.

## Development

```sh
git submodule update --init --recursive
npm install
PORT=3004 RELAY_ALLOWED_ORIGINS=http://localhost:3001 npm start
npm run lint
npm run test
```

Docker: `docker run -p 3004:8080 -e RELAY_ALLOWED_ORIGINS=http://localhost:3001 ghcr.io/robin-w151/orfarchiv-relay`
