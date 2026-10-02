export type MapRangeOptions = {
  /** The input value. Need not lie inside `from`. */
  value: number;
  /**
   * The input range, as `[start, end]`. May run in either direction; a
   * descending range inverts the mapping. The two entries must differ.
   */
  from: readonly [number, number];
  /** The output range, as `[start, end]`. May run in either direction, and may be zero-width. */
  to: readonly [number, number];
  /**
   * Whether to confine the result to the `to` endpoints. When `false` (the
   * default) a `value` outside `from` is extrapolated past them.
   */
  clamp?: boolean;
};

/**
 * Rescales `value` from one range to another, linearly. `from[0]` maps to
 * `to[0]`, `from[1]` maps to `to[1]`, and everything between is interpolated.
 *
 * Values outside `from` are extrapolated by default; pass `clamp: true` to pin
 * them to the nearest `to` endpoint instead. Either range may run in either
 * direction, and because clamping happens in normalized space it works the
 * same way for a descending `to`.
 *
 * The two endpoints come back exactly — `value === from[1]` returns `to[1]`
 * with no floating-point drift — and with `clamp: true` the result is always
 * between the `to` entries.
 *
 * @throws {RangeError} when `from` has zero width, which has no meaningful
 * normalized position. A zero-width `to` is fine and yields that constant.
 *
 * @example
 * mapRange({ value: 0.5, from: [0, 1], to: [0, 100] });              // 50
 * mapRange({ value: 2, from: [0, 1], to: [0, 100] });                // 200 — extrapolated
 * mapRange({ value: 2, from: [0, 1], to: [0, 100], clamp: true });   // 100
 * mapRange({ value: 98.6, from: [32, 212], to: [0, 100] });          // 37 — °F to °C
 */
export function mapRange({ value, from, to, clamp = false }: MapRangeOptions): number {
  const [a, b] = from;
  if (a === b) {
    throw new RangeError(`mapRange: 'from' range has zero width (${a})`);
  }

  let t = (value - a) / (b - a);
  if (clamp) t = Math.min(Math.max(t, 0), 1);

  return (1 - t) * to[0] + t * to[1];
}
