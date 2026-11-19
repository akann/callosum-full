// Console API entrypoint.
import { buildApi } from './app.ts';
import { config } from './config.ts';
import { createDb } from './db.ts';
import { Hub } from './live/hub.ts';

const sql = createDb();
const hub = new Hub(sql);
await hub.start();
const app = await buildApi({ sql, hub, logger: true });
await app.listen({ port: config.apiPort, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => hub.stop())
      .then(() => sql.end())
      .then(() => process.exit(0));
  });
}
