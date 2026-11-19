// Propagation worker entrypoint. Run as many copies as needed; they coordinate through Postgres.
import { config } from './config.ts';
import { createDb } from './db.ts';
import { PropagationWorker } from './propagation/worker.ts';

const sql = createDb();
const worker = new PropagationWorker(sql, {
  gatewayUrl: config.gatewayUrl,
  meteringUrl: config.meteringUrl,
  log: (msg, extra) => console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra })),
});
await worker.start();
console.log('propagation worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void worker
      .stop()
      .then(() => sql.end())
      .then(() => process.exit(0));
  });
}
