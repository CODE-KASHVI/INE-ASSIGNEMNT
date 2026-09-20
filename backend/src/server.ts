// Loads backend/.env for local development. On Render, real environment variables are set in
// the dashboard and this is a harmless no-op (no .env file present in the deployed container).
import 'dotenv/config';
import { createApp } from './app';
import { env } from './config/env';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(JSON.stringify({ event: 'server_started', port: env.PORT, nodeEnv: env.NODE_ENV }));
});

// Render sends SIGTERM before recycling an instance — close cleanly so in-flight requests finish
// instead of being cut off mid-response.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(JSON.stringify({ event: 'shutdown_signal', signal }));
    server.close(() => process.exit(0));
    // Belt-and-suspenders: if something (e.g. a hung Playwright browser) keeps the event loop
    // alive, don't let the process hang forever waiting for server.close()'s callback.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
