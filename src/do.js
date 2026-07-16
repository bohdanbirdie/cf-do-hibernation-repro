// The DO under test, instrumented with the only technique that can observe
// whether it hibernated: a durable reconstruction counter. Every construction
// bumps a persisted `boots`; read it back over a request, and if it grew across
// an idle window the DO was torn down and rebuilt -> it hibernated. Needing this
// instrumentation is the point — there's no supported API to assert hibernation
// (Cloudflare's own y-partyserver YHibernateTracker does the same in storage).

class BaseRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.cache = new Map();

    ctx.blockConcurrencyWhile(async () => {
      const boots = ((await ctx.storage.get('boots')) ?? 0) + 1;
      await ctx.storage.put('boots', boots);
      this.boots = boots;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/boots') {
      return Response.json({ boots: this.boots, sockets: this.ctx.getWebSockets().length });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]); // hibernatable accept, NOT ws.accept()
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('ok');
  }

  async webSocketMessage(ws, msg) {
    this.cache.set('lastMsg', msg);
    ws.send(`echo:${msg}`);
  }
  async webSocketClose() {}
}

/** Hibernation-eligible when idle. */
export class PlainRoom extends BaseRoom {}

/** Regression: a dependency adds a long keepalive timer (cf. Effect.never). */
export class TimerRoom extends BaseRoom {
  constructor(ctx, env) {
    super(ctx, env);
    this.keepalive = setInterval(() => {}, 2 ** 31 - 1);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get('room') ?? 'a';
    const ns = url.searchParams.get('kind') === 'timer' ? env.TIMER_ROOM : env.PLAIN_ROOM;
    // Stub is local to this request, so nothing the test holds pins the actor.
    return ns.get(ns.idFromName(room)).fetch(request);
  },
};
