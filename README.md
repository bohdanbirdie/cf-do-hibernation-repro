# cf-do-hibernation-repro

A minimal, generic reproduction of one testability gap: **you cannot assert Cloudflare
Durable Object WebSocket hibernation with a supported API — only by instrumenting the DO
itself and burning real wall-clock time.**

## The problem

Durable Objects bill for **wall-clock residency**, not CPU time. WebSocket Hibernation keeps
that bill down: an idle DO is evicted from memory while its sockets stay open at the edge, and
it is reconstructed on the next event.

Hibernation is silently disqualified while the isolate has **any pending `setTimeout` /
`setInterval`** (alongside other documented gates). This is a quiet failure mode: a dependency
can register a single long-lived keepalive timer, and from then on the DO **never hibernates**
and bills full residency for every live connection — no error, no warning, nothing in the
connection's behavior to signal it. (This is exactly what a `setInterval`-based `Effect.never`
did in one real codebase.)

So the property you want to lock down in CI is simple to state: *"an idle, connected DO with
no pending timers hibernates; the same DO with a keepalive timer does not."*

## What this repo shows

Under [`@cloudflare/vitest-pool-workers`](https://www.npmjs.com/package/@cloudflare/vitest-pool-workers),
that property **is** assertable, and the regression **is** catchable — the platform models
timer-pinning correctly. Measured with a durable reconstruction counter (`boots`, bumped in the
constructor, read over a normal request), across a 20s idle window:

```
plain DO:  boots 1 -> 2   # hibernated (reconstructed on the wake read)
timer DO:  boots 1 -> 1   # pinned resident by one setInterval
```

The catch is the **cost of making it assertable**:

1. **You must instrument production code.** There is no supported "did it hibernate / is it
   eligible" signal, so the DO must carry a durable reconstruction counter purely for the test.
   Cloudflare's own `y-partyserver` does the same thing (`YHibernateTracker` counts `onStart`
   calls in `ctx.storage`).
2. **You must burn real wall-clock.** workerd's ~10s inactivity timer is not fakeable or
   configurable, so every hibernation test idles for real — the three tests here take ~40s.
3. **`evictDurableObject` does not cover this.** It *forces* hibernation, bypassing the
   eligibility gate — so it structurally cannot catch the timer regression, which is the whole
   point.

The fixture is generic: [`src/do.js`](./src/do.js) is a plain DO (`PlainRoom`) and the same DO
holding one `setInterval` (`TimerRoom`).

## Run

```sh
npm install

npm test                        # vitest-pool-workers: control + plain-hibernates + timer-pinned

npm run dev:plain               # terminal 1 — DO with no timer
npm run probe 8787              # terminal 2 — plain DO: boots should increment after idle
npm run dev:timer               # terminal 1 — same DO + setInterval(2**31-1)
npm run probe 8787              # terminal 2 — timer DO: boots should stay 1
```

Every finding here is **version-scoped** (results hold for `vitest-pool-workers` 0.18.x /
`vitest` 4.1.x). The lockfile is committed; record `npm run versions` output alongside any result.

## Traps (learned the hard way)

1. **Measure via a durable counter over a normal request path — not `runInDurableObject` or a
   retained stub.** Either one pins the actor and produces a false "never hibernated" reading.
   (An earlier version of this repro concluded DOs never hibernate here; that was this exact
   measurement artifact, not the platform.)
2. **Pair the regression guard with a baseline that must hibernate.** A guard that only asserts
   "the timer DO did not hibernate" passes vacuously if the harness ever stops hibernating at
   all; the plain-DO baseline is what proves the guard can still catch anything.
3. **The idle is real wall-clock** (~10s workerd inactivity timer, not fakeable). Hibernation
   tests are slow by construction.
