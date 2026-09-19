import { bootLog, createContext, loadConfig, prepareDatabase } from '../bootstrap.js';
import { Worker } from '../worker/loop.js';

async function main() {
  const config = loadConfig();
  const ctx = createContext(config);
  bootLog(ctx);
  await prepareDatabase(ctx);
  const worker = new Worker(ctx);
  worker.start();
  const sweeper = setInterval(() => {
    worker.sweep().then((r) => {
      if (r.released || r.exhausted || r.cleaned) ctx.log.info(r, 'sweep');
    }).catch((err: unknown) => ctx.log.error({ err: String(err) }, 'sweep failed'));
  }, 60_000);
  ctx.log.info({ worker_id: config.workerId }, 'worker started');
  const shutdown = async () => {
    ctx.log.info('worker shutting down');
    clearInterval(sweeper);
    await worker.stop();
    await ctx.sql.end({ timeout: 10 });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
