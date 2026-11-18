/**
 * Not a preload: a script the stop/continue system test runs to pin the event-loop ordering the
 * watchdog relies on. A 50 ms interval runs; on the first tick whose gap is past two intervals (the
 * process was stopped), it records whether the SIGCONT listener had run by the timer callback and
 * by that callback's `setImmediate`, prints one JSON line, and ends.
 */
const INTERVAL_MS = 50;
let continues = 0;
process.on('SIGCONT', () => {
  continues += 1;
});
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  const gap = now - last;
  last = now;
  if (gap <= 2 * INTERVAL_MS) return;
  const inTimer = continues > 0;
  setImmediate(() => {
    process.stdout.write(`${JSON.stringify({ gapMs: Math.round(gap), inTimer, inImmediate: continues > 0 })}\n`);
    clearInterval(timer);
  });
}, INTERVAL_MS);
process.stdout.write('ready\n');
