# clamp

Constrains a number to a pair of bounds, returning the nearest point inside them. `clamp({ value: 42, min: 0, max: 10 })` gives `10`.

Reach for it wherever a number arrives from somewhere you do not control — pointer coordinates, scroll offsets, a parsed query param, a volume slider — and the rest of the code assumes it is in range.

## Why

The expression itself is not the hard part:

```ts
Math.min(Math.max(value, min), max);
```

What goes wrong is the reading. Nested `Math.min`/`Math.max` gives no hint which bound is which, so `Math.min(Math.max(x, max), min)` — the transposed version — looks exactly as plausible and silently returns the wrong bound forever. Named arguments leave nowhere for that mistake to hide.

The second problem is `min > max`. The nested form has a defined answer for it: `Math.min(Math.max(x, 10), 0)` is always `0`, the lower bound, whatever `x` was. That is a bug wearing a plausible number — bounds that got swapped, or a `max` computed from an empty array, produce a constant instead of an error. `NaN` bounds behave the same way, pinning every input to `NaN` without complaint.

But sorting bounds is not always wrong either. Bounds that come out of a computation — a data extent, an inverted axis, two timestamps in arbitrary order — can legitimately arrive in either direction, and forcing the caller to sort them first is noise.

So this function provides both, and the form you pick is the statement of intent:

- You named `min` and `max` yourself, so `min > max` is a bug → **throws**.
- You handed over a `range` tuple whose direction you do not vouch for → **sorted for you**.

## How it works

One branch on the shape of the options object, then the same two-sided comparison.

```ts
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
```

`ClampOptions` is a union, and `"range" in options` is the discriminant — there is no tag field to keep in sync, and TypeScript narrows on the `in` check directly. A value carrying both shapes resolves to `range`.

**The guard is `!(min <= max)`, not `min > max`.** The two differ on `NaN`: every comparison against `NaN` is false, so `NaN > max` would pass the check and let the bad bound through to produce a silent `NaN` result. Negating the *success* condition catches unordered bounds and `NaN` bounds in one expression.

That guard only exists on the `min`/`max` branch. The `range` branch cannot produce unordered bounds — `Math.min`/`Math.max` of the same two numbers are ordered by construction — but it also cannot detect a `NaN`, since both calls just return `NaN`. A `NaN` inside a `range` tuple therefore yields `NaN` rather than throwing. The asymmetry is the cost of not validating a tuple you were explicitly told not to trust the ordering of.

**A `NaN` value is not an error.** Only bounds are validated. `NaN` input propagates to `NaN` output, exactly as it would through the `Math.min`/`Math.max` you are replacing, so a clamp never converts missing data into a plausible-looking number.

**Infinities work as open sides.** `min: -Infinity` or `max: Infinity` leaves that direction unbounded, which is the usual way to express a one-sided clamp without a second code path.

**Signed zero survives.** `Math.max(-5, -0)` is `-0`, so clamping a negative value against a lower bound of `-0` returns `-0`, where a bound of `0` returns `0`. Equality treats the two as the same number, so this only matters if you format the result or use `Object.is`.

**Properties.** Idempotent — clamping a clamped value changes nothing. The result is always within the bounds, and equal to `value` whenever `value` already was. Never allocates; the options object and the `range` tuple are not mutated.

## API

### `clamp`

```ts
function clamp(options: ClampOptions): number;
```

- `options.value` — the number to constrain. `NaN` propagates; infinities clamp to the finite bounds.
- `options.range` — bounds as a tuple, in either direction. Sorted internally, never validated.
- `options.min` / `options.max` — bounds as named numbers, taken as given.

Returns the nearest number to `value` within the bounds.

**Throws** `RangeError` in the `min`/`max` form when `min <= max` is not true — bounds in the wrong order, or either bound `NaN`. The `range` form never throws.

### Types

```ts
type ClampOptions =
  | { value: number; range: readonly [number, number] }
  | { value: number; min: number; max: number };
```

The tuple is `readonly`, so a `readonly [number, number]` or a mutable `[number, number]` both work. A `number[]` does not — widen it with `as const` at the literal, or type the variable as a tuple:

```ts
const range: [number, number] = [0, 10]; // fine
const loose = [0, 10]; // number[] — rejected
clamp({ value: 5, range: [0, 10] }); // fine — inferred as a tuple in position
```

## Usage

```ts
import { clamp } from "@isel-jao/ts-lib";

clamp({ value: 5, min: 0, max: 10 }); // 5  — already in range
clamp({ value: 42, min: 0, max: 10 }); // 10 — pulled down
clamp({ value: -3, min: 0, max: 10 }); // 0  — pulled up

clamp({ value: 42, range: [10, 0] }); // 10 — tuple direction does not matter
clamp({ value: 5, min: 10, max: 0 }); // RangeError
```

A one-sided clamp, without a second branch:

```ts
clamp({ value: parsedCount, min: 0, max: Number.POSITIVE_INFINITY }); // floor at zero
```

Bounds derived from data are exactly the case the `range` form is for — the extent can come back either way round, and sorting it by hand at every call site is the thing worth deleting:

```ts
import { clamp } from "@isel-jao/ts-lib";

function clampToData(value: number, samples: readonly number[]) {
  // no guarantee which end is larger — a descending series inverts it
  const extent: readonly [number, number] = [samples[0] ?? 0, samples.at(-1) ?? 0];
  return clamp({ value, range: extent });
}

clampToData(50, [0, 10, 20]); // 20
clampToData(50, [20, 10, 0]); // 20 — same bounds, authored backwards
```

Keeping an index inside an array, where a swapped bound would be a real bug and should be loud:

```ts
const safeIndex = (i: number, items: readonly unknown[]) =>
  clamp({ value: i, min: 0, max: items.length - 1 });

safeIndex(99, ["a", "b", "c"]); // 2
safeIndex(-1, ["a", "b", "c"]); // 0
safeIndex(0, []); // RangeError — max is -1, which is the real problem
```

That last line is the point of the throwing form: an empty collection has no valid index, and a silent `0` would hand you an out-of-bounds read instead.

## Edge cases

| Input | Result |
| --- | --- |
| `value` inside the bounds | returned unchanged |
| `value` equal to a bound | that bound |
| `min === max` | that value, for any input |
| `range: [10, 0]` | treated as `[0, 10]` |
| `range: [0, 0]` | that value, for any input |
| `min > max` | `RangeError` |
| `min` or `max` is `NaN` | `RangeError` |
| `NaN` inside `range` | `NaN` — not validated |
| `value` is `NaN` | `NaN`, in both forms |
| `value` is `±Infinity` | clamped to the finite bound |
| `min: -Infinity` / `max: Infinity` | that side is unbounded |
| Lower bound of `-0`, value below it | `-0` rather than `0` |
| Both `range` and `min`/`max` present | `range` wins |
| Options object and `range` tuple | never mutated |
