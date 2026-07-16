// Two DOs that are NOT instrumented for hibernation testing in any way.
// No boot counters, no instance UUIDs, no test hooks. Deliberately "production" code.

class BaseRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.cache = new Map(); // in-memory state that must rebuild after hibernation
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('ok');
  }

  async webSocketMessage(ws, msg) {
    // A "wrong wiring" implementation would answer pings here, waking the DO.
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
    const ns = url.pathname.startsWith('/timer') ? env.TIMER_ROOM : env.PLAIN_ROOM;
    return ns.get(ns.idFromName('a')).fetch(request);
  },
};
