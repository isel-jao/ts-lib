/**
 * The bounds to clamp against, in either of two forms.
 *
 * - **`range`** — a `[number, number]` tuple whose entries are sorted, so
 *   `[10, 0]` and `[0, 10]` behave identically. Use it for bounds that come
 *   out of a computation (a data extent, a reversed axis) where either entry
 *   could legitimately be the larger one.
 * - **`min` / `max`** — two named bounds, which are *not* sorted. `min > max`
 *   has no sensible reading when you named each bound explicitly, so it throws
 *   instead of quietly swapping them.
 *
 * If a value somehow carries both, `range` wins.
 */
export type ClampOptions =
  | { value: number; range: readonly [number, number] }
  | { value: number; min: number; max: number };

/**
 * Constrains `value` to the given bounds, returning the nearest point inside
 * them. `value` itself is returned when it is already in range.
 *
 * With `range` the two entries are sorted first, so the tuple may be given in
 * either direction. With `min`/`max` they are taken as named, and `min > max`
 * throws a `RangeError` — including when either bound is `NaN`, which fails
 * the comparison. A `NaN` *value* is never an error; it propagates, as it does
 * through `Math.min`/`Math.max`.
 *
 * @throws {RangeError} in the `min`/`max` form when `min <= max` is not true.
 *
 * @example
 * clamp({ value: 42, min: 0, max: 10 });    // 10
 * clamp({ value: -3, min: 0, max: 10 });    // 0
 * clamp({ value: 5, min: 0, max: 10 });     // 5 — already in range
 * clamp({ value: 42, range: [10, 0] });     // 10 — bounds sorted for you
 */
export function clamp(options: ClampOptions): number {
  let min: number;
  let max: number;

  if ("range" in options) {
    const [a, b] = options.range;
    min = Math.min(a, b);
    max = Math.max(a, b);
  } else {
    ({ min, max } = options);
    if (!(min <= max)) {
      throw new RangeError(`clamp: invalid bounds min=${min}, max=${max}`);
    }
  }

  return Math.min(Math.max(options.value, min), max);
}
