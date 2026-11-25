// How long a synchronous piece of work takes, as the processor time of this
// process: the wall clock also counts waiting behind whatever else the
// machine is running (ld-ym7). The best of three, as one run may be slowed
// by a collection or a cold start. Not a test itself.

/** Processor milliseconds of `fn`, the least of `tries` runs; it stops at the first under `enough`. */
export function workMs(fn, enough = 0, tries = 3) {
  let best = Infinity;
  for (let i = 0; i < tries && best > enough; i++) {
    const t0 = process.cpuUsage();
    fn();
    const { user, system } = process.cpuUsage(t0);
    best = Math.min(best, (user + system) / 1000);
  }
  return best;
}
