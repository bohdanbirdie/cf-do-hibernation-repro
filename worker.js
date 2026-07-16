// Experiment: does local workerd (wrangler dev) hibernate an idle DO with a
// hibernatable WebSocket, and does a pending setInterval prevent it?
//
// Detection method = the "constructor counter" hack under test:
//   constructor increments a persisted `boots` counter.
//   Probe /boots later; if it incremented, the DO had been torn down (hibernated/evicted).

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Count every construction (= every wake) durably.
    ctx.blockConcurrencyWhile(async () => {
      const boots = ((await ctx.storage.get('boots')) ?? 0) + 1;
      await ctx.storage.put('boots', boots);
      this.boots = boots;
    });

    // The regression under test: a long keepalive timer (Effect.never does
    // setInterval(() => {}, 2**31 - 1)). Enabled only for the PINNED variant.
    if (env.PIN_WITH_TIMER === 'true') {
      this.timer = setInterval(() => {}, 2 ** 31 - 1);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/boots') {
      return Response.json({
        boots: this.boots,
        sockets: this.ctx.getWebSockets().length,
        autoResponse: this.ctx.getWebSocketAutoResponse()?.request ?? null,
        autoResponseTs: this.ctx
          .getWebSockets()
          .map((ws) => this.ctx.getWebSocketAutoResponseTimestamp(ws)?.toISOString() ?? null),
        // Did webSocketMessage ever run in THIS instance?
        msgs: this.msgs ?? 0,
      });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      // Hibernatable accept (NOT ws.accept()).
      this.ctx.acceptWebSocket(pair[1]);
      // Register the app-level keepalive auto-response (scenario 4's "correct wiring").
      if (this.env.AUTO_RESPONSE === 'true') {
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('ok');
  }

  // If the auto-response is wired correctly, a "ping" must NEVER reach here.
  async webSocketMessage(ws, msg) {
    this.msgs = (this.msgs ?? 0) + 1;
    await this.ctx.storage.put('lastMsg', String(msg));
    ws.send(`echo:${msg}`);
  }

  async webSocketClose() {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = env.ROOM.idFromName(url.searchParams.get('room') ?? 'a');
    return env.ROOM.get(id).fetch(request);
  },
};
