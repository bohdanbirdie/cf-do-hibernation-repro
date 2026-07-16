import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-check: does natural (timer-driven) hibernation EVER happen inside
// vitest-pool-workers? Under `wrangler dev` the identical DO hibernates after ~12s.
// Results are surfaced via the assertion diff (reporter swallows console.log).
it('does an idle DO ever hibernate under vitest-pool-workers?', async () => {
  const stub = env.PLAIN_ROOM.get(env.PLAIN_ROOM.idFromName(`nat-${crypto.randomUUID()}`));
  await stub.fetch('http://x/');
  await runInDurableObject(stub, (i) => {
    i.__probe = 'alive';
  });

  const trace = [];
  for (const waited of [5, 10, 15, 20, 25, 30]) {
    await sleep(5000);
    const resident = await runInDurableObject(stub, (i) => i.__probe === 'alive');
    trace.push(`${waited}s:${resident ? 'RESIDENT' : 'HIBERNATED'}`);
    if (!resident) break;
  }

  expect(trace.join(' ')).toBe('__SHOW_TRACE__');
}, 120_000);

// Control: zero probing during the window, in case the probe itself pins the actor.
it('idle 25s with ZERO probing during the window', async () => {
  const stub = env.PLAIN_ROOM.get(env.PLAIN_ROOM.idFromName(`nat2-${crypto.randomUUID()}`));
  await stub.fetch('http://x/');
  await runInDurableObject(stub, (i) => {
    i.__probe = 'alive';
  });

  await sleep(25_000);

  const resident = await runInDurableObject(stub, (i) => i.__probe === 'alive');
  expect(resident ? 'RESIDENT_after_25s' : 'HIBERNATED_after_25s').toBe('__SHOW__');
}, 120_000);

// Control 2: plain stub.fetch only — never touch runInDurableObject before the wait.
it('idle 25s, marker set via fetch-free path (evict oracle)', async () => {
  const stub = env.PLAIN_ROOM.get(env.PLAIN_ROOM.idFromName(`nat3-${crypto.randomUUID()}`));
  await stub.fetch('http://x/');

  await sleep(25_000);

  // The evictDurableObject error-contract oracle: throws "not currently running"
  // iff the actor is already torn down (a pure server-side map lookup, no wake).
  const { evictDurableObject } = await import('cloudflare:test');
  let verdict;
  try {
    await evictDurableObject(stub);
    verdict = 'WAS_RESIDENT(evict succeeded)';
  } catch (e) {
    verdict = `WAS_NOT_RUNNING(${e.message})`;
  }
  expect(verdict).toBe('__SHOW__');
}, 120_000);
