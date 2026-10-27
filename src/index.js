// Entry point: web pages + API (fetch) and the every-minute background job (scheduled).
import { handleApi } from './api.js';
import { runTick } from './scheduler.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Local testing helper: run the background job on demand (only with DEV_TOOLS=1).
    if (url.pathname === '/api/__tick' && env.DEV_TOOLS === '1') {
      return Response.json(await runTick(env, Date.now()));
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runTick(env, event.scheduledTime).then(
        (summary) => console.log('tick', JSON.stringify(summary)),
        (err) => console.error('tick failed', err && err.stack ? err.stack : String(err))
      )
    );
  },
};
