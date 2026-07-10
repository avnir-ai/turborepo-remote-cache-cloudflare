import type { RuntimeEnv } from './runtime/env';

import { handleRequest } from './runtime/handler';
import { runDeleteExpired } from './runtime/retention';

export type Env = RuntimeEnv;
export { handleRequest, runDeleteExpired };

// Kept as a source-level compatibility entrypoint for existing integrations
// and Worker-pool tests. Production deployment is built through Nitro.
export const workerHandler = {
  fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, (promise) => ctx.waitUntil(promise));
  },
  async scheduled(_event: ScheduledEvent, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    const cleanup = runDeleteExpired(env);
    ctx.waitUntil(cleanup);
    await cleanup;
  },
};

export default workerHandler;
