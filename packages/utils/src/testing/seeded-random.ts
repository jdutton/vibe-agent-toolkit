/**
 * mulberry32: a tiny seeded PRNG, so a generated test case is reproducible from
 * its seed. The one copy every generator-driven suite draws from.
 *
 * @param seed - Any integer; taken modulo 2^32
 * @returns A function giving the next value in `[0, 1)` on each call
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
