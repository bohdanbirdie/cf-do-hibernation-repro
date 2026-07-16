import { SELF } from 'cloudflare:test';
import { it, expect, describe } from 'vitest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE_MS = 20_000; // workerd evicts an idle DO after ~10s of inactivity

// Keep client sockets referenced so GC can't close them mid-idle.
const openSockets = [];

// Read the DO's durable `boots` counter over a normal request via SELF (never
// runInDurableObject / a retained stub, either of which pins the actor and
// yields a false "never hibernated"). boots grew since connect => it hibernated.
async function boots(kind, room) {
  const res = await SELF.fetch(`http://x/boots?kind=${kind}&room=${room}`);
  return (await res.json()).boots;
}

async function connect(kind, room) {
  const res = await SELF.fetch(`http://x/?kind=${kind}&room=${room}`, {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket;
  ws.accept();
  openSockets.push(ws);
  return ws;
}

describe('DO WebSocket hibernation, observed via a durable reconstruction counter', () => {
  // The oracle itself must be trustworthy: reading the counter must not
  // reconstruct the DO, or "boots grew" would prove nothing.
  it('control: boots stays 1 across back-to-back reads (no idle)', async () => {
    const room = `ctl-${crypto.randomUUID()}`;
    await connect('plain', room);
    expect(await boots('plain', room)).toBe(1);
    expect(await boots('plain', room)).toBe(1);
  });

  // Baseline that must pass for the guard below to mean anything: an idle plain
  // DO hibernates, so a later read reconstructs it and boots > 1.
  it('plain idle DO hibernates → boots increments', async () => {
    const room = `plain-${crypto.randomUUID()}`;
    await connect('plain', room);
    expect(await boots('plain', room)).toBe(1);
    await sleep(IDLE_MS);
    expect(await boots('plain', room)).toBeGreaterThan(1);
  }, 60_000);

  // Regression guard: the same DO holding one setInterval must NOT hibernate.
  it('REGRESSION: timer DO does not hibernate → boots stays 1', async () => {
    const room = `timer-${crypto.randomUUID()}`;
    await connect('timer', room);
    expect(await boots('timer', room)).toBe(1);
    await sleep(IDLE_MS);
    expect(await boots('timer', room)).toBe(1);
  }, 60_000);
});
