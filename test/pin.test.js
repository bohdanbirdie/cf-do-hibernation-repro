import { env, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Why does an idle DO hibernate under `wrangler dev` but stay resident under
// vitest-pool-workers? Hypothesis: the test holding a DurableObjectStub (and/or
// the test's own in-flight invocation) keeps an ActiveRequest ref on the actor.

it('A: full error text from evict after idle', async () => {
  const ns = env.PLAIN_ROOM;
  const stub = ns.get(ns.idFromName(`pinA-${crypto.randomUUID()}`));
  await stub.fetch('http://x/');
  await sleep(25_000);
  let verdict;
  try {
    await evictDurableObject(stub);
    verdict = 'EVICT_OK(was resident)';
  } catch (e) {
    verdict = `THREW: ${e.message}`;
  }
  expect(verdict).toBe('__SHOW__');
}, 120_000);

it('B: drop the stub reference before idling', async () => {
  const ns = env.PLAIN_ROOM;
  const name = `pinB-${crypto.randomUUID()}`;
  let stub = ns.get(ns.idFromName(name));
  await stub.fetch('http://x/');
  await runInDurableObject(stub, (i) => {
    i.__probe = 'alive';
  });
  stub = null; // drop the only reference

  await sleep(25_000);

  const fresh = ns.get(ns.idFromName(name));
  const resident = await runInDurableObject(fresh, (i) => i.__probe === 'alive');
  expect(resident ? 'RESIDENT(stub-drop did not help)' : 'HIBERNATED(stub was the pin)').toBe(
    '__SHOW__'
  );
}, 120_000);

it('C: does the DO hibernate when driven via SELF (no stub held)?', async () => {
  // Reach the DO only through the entry worker, mirroring the wrangler-dev setup
  // where no stub is retained across the idle window.
  const { SELF } = await import('cloudflare:test');
  await SELF.fetch('http://example.com/plain');
  await sleep(25_000);
  const ns = env.PLAIN_ROOM;
  const fresh = ns.get(ns.idFromName('a')); // same id the entry worker uses
  let verdict;
  try {
    await evictDurableObject(fresh);
    verdict = 'EVICT_OK(still resident after 25s)';
  } catch (e) {
    verdict = `THREW: ${e.message}`;
  }
  expect(verdict).toBe('__SHOW__');
}, 120_000);
