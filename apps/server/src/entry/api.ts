import { serve } from '@hono/node-server';
import { bootLog, createContext, loadConfig, prepareDatabase } from '../bootstrap.js';
import { createApp } from '../http/app.js';

async function main() {
  const config = loadConfig();
  const ctx = createContext(config);
  bootLog(ctx);
  await prepareDatabase(ctx);
  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    ctx.log.info({ port: info.port }, 'api listening');
  });
  const shutdown = async () => {
    ctx.log.info('api shutting down');
    server.close();
    await ctx.sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
