# cf-do-hibernation-repro

A minimal, generic reproduction asking one question: **is Cloudflare Durable Object WebSocket
hibernation regression-testable?**

## The problem

Durable Objects bill for **wall-clock residency**, not CPU time. WebSocket Hibernation is the mechanism
that keeps that bill down: an idle DO is evicted from memory while its sockets stay open at the edge, and
it is reconstructed on the next event.

Hibernation is silently disqualified while the isolate has **any pending `setTimeout`/`setInterval`**
(alongside other documented gates — in-flight requests, `waitUntil`, outbound connections). This makes it
a quiet failure mode: a dependency can register a single long-lived keepalive timer, and from then on the
DO **never hibernates** and bills full wall-clock residency for every live connection — with no error, no
warning, and nothing in the connection's behavior to signal it.

So the property you want to lock down in CI is simple to state — *"an idle, connected DO with no pending
timers hibernates; the same DO with a keepalive timer does not"* — and the open question this repo probes
is whether that property can actually be **asserted with supported tooling**.

## The fixture

Deliberately generic and uninstrumented (no boot counters, no UUIDs, no test hooks) so nothing here is
specific to any one framework — see [`src/do.js`](./src/do.js):

- **`PlainRoom`** — a plain DO; hibernation-eligible when idle.
- **`TimerRoom`** — the identical DO plus one `setInterval(() => {}, 2 ** 31 - 1)`, standing in for a
  dependency that registers a keepalive timer.

## What it shows

Under [`@cloudflare/vitest-pool-workers`](https://www.npmjs.com/package/@cloudflare/vitest-pool-workers),
an idle DO **never hibernates naturally** — probing residency every 5s over 30s returns `RESIDENT` the
whole way, and `evictDurableObject` on an idle DO does not act as a residency oracle (it times out with
*"it still has active references"*, i.e. the actor is pinned, not hibernated).

The consequence is the point of the repo: a hibernation regression guard written against this harness
passes **vacuously** — because *nothing* hibernates, `"the timer DO did not hibernate"` is trivially true,
so the guard stays green even if the bug is reintroduced. See the two paired tests in
[`test/guard.test.js`](./test/guard.test.js): the no-timer **baseline** (which must go green for the guard
to mean anything) *fails*, while the timer **guard** *passes*.

The `wrangler dev` rig ([`worker.js`](./worker.js) + [`probe.mjs`](./probe.mjs)) is the differential that
checks whether the underlying platform models timer-pinning at all — connect a socket, idle past the
eviction window, and read a reconstruction counter for `PlainRoom` vs `TimerRoom`.

## Run

```sh
npm install

npm test                        # vitest-pool-workers harness

npm run dev:plain               # terminal 1 — DO with no timer
npm run probe 8787              # terminal 2 — plain DO: expect it to reconstruct after idle (hibernated)

npm run dev:timer               # terminal 1 — same DO + setInterval(2**31-1)
npm run probe 8787              # terminal 2 — timer DO: expect it to stay resident (pinned)
```

Every finding here is **version-scoped** (the results above hold for `vitest-pool-workers` 0.18.x /
`vitest` 4.1.x). The lockfile is committed; record `npm run versions` output alongside any result.

## Three traps

1. **A passing test proves nothing here.** Under vitest-pool-workers nothing hibernates at all, so a
   hibernation guard passes *vacuously* and stays green even if the bug returns. Always pair it with a
   baseline that must fail, or a differential.
2. **`wrangler dev` does not tear down the isolate on eviction.** It re-runs the constructor with fresh
   instance fields but **keeps module-level state**. Know which one you're measuring — instance fields
   reset, module-level counters persist.
3. **The tests use `expect(x).toBe('__SHOW__')` to force a failure** so the real value shows up in the
   assertion diff (the reporter swallows `console.log`). Intentional — read the diff, not the pass/fail.
