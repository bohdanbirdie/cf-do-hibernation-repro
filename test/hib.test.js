import { env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { it, expect, describe } from 'vitest';

const IDLE_MS = 12_000; // workerd evicts after 10s of inactivity (hard-coded kj::Timer)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Residency oracle WITHOUT instrumenting the DO: stamp an in-memory-only marker
 * on the live instance via runInDurableObject, then re-read it later.
 * A wake cannot restore the marker, and a resident DO cannot lose it -> the
 * probe's own wake does not corrupt the answer (no real observer effect).
 */
async function markResident(stub) {
  await runInDurableObject(stub, (instance) => {
    instance.__probe = 'alive';
  });
}
async function isStillResident(stub) {
  return runInDurableObject(stub, (instance) => instance.__probe === 'alive');
}

describe('natural hibernation eligibility (no DO instrumentation)', () => {
  it('idle DO with no timers DOES hibernate', async () => {
    const stub = env.PLAIN_ROOM.get(env.PLAIN_ROOM.idFromName('plain-1'));
    await stub.fetch('http://x/');
    await markResident(stub);

    await sleep(IDLE_MS);

    expect(await isStillResident(stub)).toBe(false); // torn down => hibernated
  });

  it('REGRESSION GUARD: idle DO with a long setInterval does NOT hibernate', async () => {
    const stub = env.TIMER_ROOM.get(env.TIMER_ROOM.idFromName('timer-1'));
    await stub.fetch('http://x/');
    await markResident(stub);

    await sleep(IDLE_MS);

    // Pinned resident by the keepalive timer -> marker survives.
    expect(await isStillResident(stub)).toBe(true);
  });
});

describe('scenario 4: auto-response wired correctly, proven without waking', () => {
  it('ping is auto-answered during hibernation; webSocketMessage never runs', async () => {
    const stub = env.PLAIN_ROOM.get(env.PLAIN_ROOM.idFromName('ws-1'));
    const res = await stub.fetch('http://x/', { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket;
    ws.accept();
    const pongs = [];
    ws.addEventListener('message', (e) => pongs.push(e.data));

    // Wiring assertion: configuration is readable directly.
    const configured = await runInDurableObject(stub, (_i, state) =>
      state.getWebSocketAutoResponse()?.request
    );
    expect(configured).toBe('ping');

    await sleep(IDLE_MS); // let it hibernate for real
    ws.send('ping');
    await sleep(1000);

    // Retroactive proof, maintained across hibernation.
    const { ts, cacheRebuilt } = await runInDurableObject(stub, (instance, state) => {
      const [sock] = state.getWebSockets();
      return {
        ts: state.getWebSocketAutoResponseTimestamp(sock)?.toISOString() ?? null,
        cacheRebuilt: instance.cache.size, // 0 => webSocketMessage never handled the ping
      };
    });

    expect(pongs).toEqual(['pong']); // client got its pong
    expect(ts).not.toBeNull(); // runtime auto-answered it => DO did NOT wake
    expect(cacheRebuilt).toBe(0); // webSocketMessage never ran
  });
});

describe('scenario 5: rehydration across a forced hibernation cycle', () => {
  it('evictDurableObject({webSockets:"hibernate"}) keeps sockets and rebuilds state', async () => {
    const stub = env.PLAIN_ROOM.get(env.PLAIN_ROOM.idFromName('evict-1'));
    const res = await stub.fetch('http://x/', { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket;
    ws.accept();
    const seen = [];
    ws.addEventListener('message', (e) => seen.push(e.data));

    await markResident(stub);
    await evictDurableObject(stub, { webSockets: 'hibernate' });

    // Instance was destroyed...
    expect(await isStillResident(stub)).toBe(false);

    // ...but the hibernated socket still round-trips, waking the DO.
    ws.send('after-hibernation');
    await sleep(1000);
    expect(seen).toContain('echo:after-hibernation');

    const sockets = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    expect(sockets).toBe(1); // attachment registry rebuilt
  });
});
