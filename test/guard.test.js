import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE_MS = 25_000; // 10s timer only starts once the actor goes inactive

/**
 * Asserts whether an idle DO hibernates on its own — using ONLY supported APIs
 * (runInDurableObject) and ZERO instrumentation of the DO under test.
 *
 * Key gotcha: the stub must NOT be retained across the idle window, or it holds
 * an ActiveRequest ref and pins the actor resident (false "did not hibernate").
 */
async function hibernatesWhenIdle(ns, name) {
  let stub = ns.get(ns.idFromName(name));
  await stub.fetch('http://x/');
  // Stamp an in-memory-only marker on the live instance. A wake cannot restore
  // it; a resident instance cannot lose it.
  await runInDurableObject(stub, (i) => {
    i.__probe = 'alive';
  });
  stub = null; // CRITICAL: release the ref or the actor never goes inactive

  await sleep(IDLE_MS);

  const fresh = ns.get(ns.idFromName(name));
  const survived = await runInDurableObject(fresh, (i) => i.__probe === 'alive');
  return !survived; // marker gone => instance was torn down => it hibernated
}

it('baseline: an idle DO with no timers hibernates', async () => {
  expect(await hibernatesWhenIdle(env.PLAIN_ROOM, `g1-${crypto.randomUUID()}`)).toBe(true);
}, 120_000);

it('REGRESSION GUARD: a long setInterval (cf. Effect.never) defeats hibernation', async () => {
  // This is the dependency-upgrade regression from scenario 1, caught in CI.
  expect(await hibernatesWhenIdle(env.TIMER_ROOM, `g2-${crypto.randomUUID()}`)).toBe(false);
}, 120_000);
