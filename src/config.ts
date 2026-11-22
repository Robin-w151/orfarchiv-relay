import { Config, Data, Effect } from 'effect';
import { isValidOriginEntry, parseAllowedOrigins } from './origins';

export const DEFAULT_PORT = 8080;
export const DEFAULT_MAX_CONNECTIONS = 2000;
export const DEFAULT_ALLOWED_ORIGINS =
  'https://orfarchiv.news,https://develop.orfarchiv.news,https://orfarchiv-*-robins-projects-bb10f956.vercel.app';

export class RelayConfigError extends Data.TaggedError('RelayConfigError')<{ message: string }> {}

export interface RelayConfig {
  readonly port: number;
  readonly maxConnections: number;
  readonly allowedOrigins: ReadonlyArray<string>;
}

export const relayConfig: Effect.Effect<RelayConfig, Config.ConfigError | RelayConfigError> = Effect.gen(function* () {
  const port = yield* Config.Port('PORT').pipe(Config.withDefault(DEFAULT_PORT));
  const maxConnections = yield* Config.Int('RELAY_MAX_CONNECTIONS').pipe(Config.withDefault(DEFAULT_MAX_CONNECTIONS));
  const allowedOrigins = parseAllowedOrigins(
    yield* Config.String('RELAY_ALLOWED_ORIGINS').pipe(Config.withDefault(DEFAULT_ALLOWED_ORIGINS)),
  );

  if (maxConnections <= 0) {
    return yield* new RelayConfigError({ message: `RELAY_MAX_CONNECTIONS must be positive, got ${maxConnections}.` });
  }
  const invalidOrigin = allowedOrigins.find((origin) => !isValidOriginEntry(origin));
  if (invalidOrigin !== undefined) {
    return yield* new RelayConfigError({
      message: `RELAY_ALLOWED_ORIGINS contains an invalid origin '${invalidOrigin}'.`,
    });
  }

  return { port, maxConnections, allowedOrigins };
});
