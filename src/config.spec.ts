import { ConfigProvider, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { relayConfig } from './config';

function load(env: Record<string, string>) {
  return relayConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    Effect.exit,
    Effect.runPromise,
  );
}

describe('relayConfig', () => {
  it('uses the defaults', async () => {
    expect(await load({})).toEqual(
      Exit.succeed({
        port: 8080,
        maxConnections: 2000,
        allowedOrigins: [
          'https://orfarchiv.news',
          'https://develop.orfarchiv.news',
          'https://orfarchiv-*-robins-projects-bb10f956.vercel.app',
        ],
      }),
    );
  });

  it('reads the environment', async () => {
    expect(
      await load({ PORT: '3004', RELAY_MAX_CONNECTIONS: '10', RELAY_ALLOWED_ORIGINS: 'http://localhost:3001' }),
    ).toEqual(Exit.succeed({ port: 3004, maxConnections: 10, allowedOrigins: ['http://localhost:3001'] }));
  });

  it.each<{ name: string; env: Record<string, string> }>([
    { name: 'a non-numeric port', env: { PORT: 'abc' } },
    { name: 'an out-of-range port', env: { PORT: '70000' } },
    { name: 'a fractional connection cap', env: { RELAY_MAX_CONNECTIONS: '1.5' } },
    { name: 'a zero connection cap', env: { RELAY_MAX_CONNECTIONS: '0' } },
    { name: 'an invalid origin', env: { RELAY_ALLOWED_ORIGINS: 'https://orfarchiv.news/' } },
  ])('rejects $name', async ({ env }) => {
    expect(Exit.isFailure(await load(env))).toBe(true);
  });
});
