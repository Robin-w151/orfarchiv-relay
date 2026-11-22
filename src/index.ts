import { Data, Effect, Runtime, Schedule } from 'effect';
import { relayConfig } from './config';
import { startRelayServer } from './server';

const STATS_INTERVAL = '5 minutes';

class RelayStartError extends Data.TaggedError('RelayStartError')<{ message: string; cause: unknown }> {}

const program = Effect.gen(function* () {
  const config = yield* relayConfig;
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startRelayServer(config),
      catch: (cause) => new RelayStartError({ message: `Failed to start relay on port ${config.port}`, cause }),
    }),
    (server) =>
      Effect.gen(function* () {
        yield* Effect.log(`Stopping relay (${server.stats().connections} connections)`);
        yield* Effect.promise(() => server.close());
        yield* Effect.log('Relay stopped');
      }),
  );

  yield* Effect.log(
    `Relay listening on port ${server.port} (${config.allowedOrigins.length} allowed origins, max ${config.maxConnections} connections)`,
  );
  yield* Effect.forkScoped(
    Effect.suspend(() => {
      const { rooms, connections } = server.stats();
      return Effect.log(`Relay stats: ${rooms} rooms, ${connections} connections`);
    }).pipe(Effect.schedule(Schedule.spaced(STATS_INTERVAL))),
  );
  return yield* Effect.never;
}).pipe(Effect.scoped);

const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  const interrupt = () => fiber.interruptUnsafe();
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  fiber.addObserver((exit) => {
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
    teardown(exit, (code) => process.exit(code === 130 ? 0 : code));
  });
});

runMain(program);
