// Drives the hibernation experiment against a running `wrangler dev`.
// Usage: node probe.mjs <port> <roomName>
const port = process.argv[2] ?? '8787';
const room = process.argv[3] ?? 'a';
const base = `http://127.0.0.1:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boots = async (tag) => {
  const res = await fetch(`${base}/boots?room=${room}`);
  const j = await res.json();
  console.log(`[${tag}]`, JSON.stringify(j));
  return j;
};

// 1. Open a hibernatable WebSocket.
const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}`);
const pongs = [];
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
  setTimeout(() => reject(new Error('ws open timeout')), 10000);
});
ws.addEventListener('message', (e) => {
  pongs.push(e.data);
  console.log('[client] recv:', e.data);
});
console.log('[client] websocket open');

// 2. Baseline boot count (this fetch itself keeps the DO alive, so read it now).
await boots('after-connect');

// 3. Idle well past workerd's 10s inactivity eviction timer.
console.log('[client] idling 14s (workerd evicts after 10s of inactivity)...');
await sleep(14000);

// 4. Send the app-level keepalive ping. If setWebSocketAutoResponse is wired,
//    the runtime answers WITHOUT waking the DO (no constructor run).
console.log('[client] sending "ping"');
ws.send('ping');
await sleep(2000);

// 5. Probe. This wake adds exactly +1 boot itself.
//    boots==2 => DO hibernated during idle AND the ping did NOT wake it (auto-response worked).
//    boots==3 => the ping woke it too (auto-response NOT effective).
//    boots==1 => DO never hibernated at all (pinned resident).
const final = await boots('after-idle+ping');

console.log('\n=== VERDICT ===');
console.log('pongs received:', JSON.stringify(pongs));
if (final.boots === 1) console.log('DO NEVER HIBERNATED (stayed resident the whole time)');
else if (final.boots === 2) console.log('DO HIBERNATED and ping did NOT wake it');
else console.log(`DO woke ${final.boots - 1}x -> ping likely woke it`);
ws.close();
process.exit(0);
