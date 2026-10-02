# mapRange

Rescales a number from one range to another, linearly. `mapRange({ value: 0.5, from: [0, 1], to: [0, 100] })` gives `50`.

Reach for it wherever two ranges have to be reconciled: data values to pixels, a slider position to a parameter, a scroll offset to an opacity, Fahrenheit to Celsius.

## Why

Written inline, the mapping is two steps that look obvious and go wrong in three places:

```ts
const t = (value - inMin) / (inMax - inMin);
return outMin + t * (outMax - outMin);
```

1. **Four loose parameters in a fixed order.** `mapRange(x, 0, 1, 0, 100)` reads as noise at the call site, and transposing one pair produces a plausible wrong number rather than an error. An options object with two labelled tuples says which range is which.
2. **A zero-width input range gives `±Infinity` or `NaN`.** When `inMax === inMin`, `t` divides by zero — and when `value` also equals that bound, `0 / 0` makes the result `NaN`. Both propagate into layout code far from the cause. That input has no normalized position at all, so this function throws instead.
3. **The endpoints drift.** `outMin + t * (outMax - outMin)` does not reliably return `outMax` when `t` is `1` — it misses in roughly half of random float pairs, and overshoots the range slightly for `t` just below `1`. Values that should land exactly on a boundary end up a hair past it, which is how a clamped progress bar ends up at `100.00000000000001%`.

## How it works

Normalize into `t`, optionally clamp `t`, then interpolate.

```ts
const [a, b] = from;
if (a === b) {
  throw new RangeError(`mapRange: 'from' range has zero width (${a})`);
}

let t = (value - a) / (b - a);
if (clamp) t = Math.min(Math.max(t, 0), 1);

return (1 - t) * to[0] + t * to[1];
```

**The guard.** `a === b` catches the only genuinely undefined input. It also catches `[0, -0]`, since `0 === -0` — which is right, because `-0 - 0` is `0` and the range really is zero width. A `NaN` bound is *not* caught: `NaN !== NaN`, so the comparison is false and the result comes back `NaN`. A zero-width `to` is deliberately allowed; it is a meaningful mapping that collapses every input to one constant.

**Clamping happens to `t`, not to the result.** That is what makes it direction-agnostic: `t` is confined to `0..1` before anything knows which end of `to` is larger, so a descending `to` like `[480, 0]` — a flipped screen axis — clamps to the correct visual end with no extra branch. Clamping the output instead would need to sort `to` first.

Note that the clamp cannot rescue a `NaN`: `Math.max(NaN, 0)` is `NaN`, so a `NaN` value or bound stays `NaN` through the clamp. It *does* resolve an infinite `value`, which becomes an infinite `t` and then exactly `0` or `1`.

**The interpolation form is deliberate.** `(1 - t) * to[0] + t * to[1]` rather than the algebraically identical `to[0] + t * (to[1] - to[0])`. Two properties follow from it:

- **Exact endpoints.** When `value === from[1]`, `t` is exactly `1` — `x / x` is `1` for any finite non-zero `x` — and `(1 - 1) * to[0] + 1 * to[1]` is `to[1]` bit for bit. Likewise at `t === 0`. The other form rounds twice and lands near the endpoint instead of on it.
- **Bounded output.** For `t` in `0..1` the result never escapes the `to` endpoints, so `clamp: true` is a real guarantee rather than an approximate one.

The cost is that this form is not guaranteed monotonic in `t`, and *interior* points still carry ordinary float drift — `mapRange({ value: 2, from: [10, 0], to: [100, 0] })` is `19.999999999999996`, not `20`. Only the endpoints are exact. Compare interior results with a tolerance, not `===`.

**Extrapolation is the default** because clamping is lossy and you cannot undo it, so the opt-in direction is the safe one. Unclamped, the function is a plain affine map and stays invertible: swapping `from` and `to` recovers the input.

The one real trap with an infinite `value`: unclamped, `t` is infinite and `(1 - ∞) * to[0] + ∞ * to[1]` is `NaN` for any `to`. Pass `clamp: true` whenever `value` can be infinite.

**Complexity.** Constant time, no allocation, no mutation of the options object or its tuples.

## API

### `mapRange`

```ts
function mapRange(options: MapRangeOptions): number;
```

- `options.value` — the input number. Need not lie inside `from`.
- `options.from` — input range as `[start, end]`, in either direction. The entries must differ.
- `options.to` — output range as `[start, end]`, in either direction. May be zero-width.
- `options.clamp` — confine the result to the `to` endpoints instead of extrapolating. Defaults to `false`.

Returns `value` rescaled so that `from[0]` maps to `to[0]` and `from[1]` maps to `to[1]`, both exactly.

**Throws** `RangeError` when `from[0] === from[1]`.

### Types

```ts
type MapRangeOptions = {
  value: number;
  from: readonly [number, number];
  to: readonly [number, number];
  clamp?: boolean;
};
```

The tuples are `readonly`, so a literal, a mutable tuple, or a `readonly` tuple all work — but a `number[]` does not. Type the variable as a tuple if you build it separately.

The `clamp` option shares its name with this library's [`clamp`](../clamp/README.md) function. They do not interact; if you import both and also want a local `clamp` variable, destructure carefully.

## Usage

```ts
import { mapRange } from "@isel-jao/ts-lib";

mapRange({ value: 0.5, from: [0, 1], to: [0, 100] }); // 50
mapRange({ value: 98.6, from: [32, 212], to: [0, 100] }); // 37 — °F to °C

mapRange({ value: 2, from: [0, 1], to: [0, 100] }); // 200 — extrapolated
mapRange({ value: 2, from: [0, 1], to: [0, 100], clamp: true }); // 100

mapRange({ value: 1, from: [5, 5], to: [0, 1] }); // RangeError
```

Either range may run backwards, which is how a flipped axis is expressed — screen `y` grows downward while data grows upward:

```ts
import { mapRange } from "@isel-jao/ts-lib";

const toScreenY = (temperature: number) =>
  mapRange({ value: temperature, from: [-10, 40], to: [480, 0], clamp: true });

toScreenY(-10); // 480 — coldest at the bottom
toScreenY(15); // 240
toScreenY(40); // 0   — hottest at the top
toScreenY(60); // 0   — clamped, so out-of-range data stays on the canvas
```

Driving an animation from a scroll offset — one range in, one range out, clamped at both ends:

```ts
import { mapRange } from "@isel-jao/ts-lib";

const headerOpacity = (scrollTop: number) =>
  mapRange({ value: scrollTop, from: [0, 120], to: [1, 0], clamp: true });

headerOpacity(0); // 1    — fully visible
headerOpacity(60); // 0.5
headerOpacity(500); // 0    — faded out and staying there
```

Because the unclamped mapping is invertible, the same call inverted turns a UI coordinate back into a data value:

```ts
import { mapRange } from "@isel-jao/ts-lib";

const DATA: readonly [number, number] = [-10, 40];
const AXIS: readonly [number, number] = [480, 0];

const toPixels = (t: number) => mapRange({ value: t, from: DATA, to: AXIS });
const toData = (y: number) => mapRange({ value: y, from: AXIS, to: DATA });

toData(toPixels(21.5)); // 21.5 — up to interior float drift
```

## Edge cases

| Input | Result |
| --- | --- |
| `value` equal to `from[0]` or `from[1]` | `to[0]` / `to[1]`, exactly |
| `value` inside `from` | interpolated, with ordinary float drift |
| `value` outside `from` | extrapolated past `to` |
| Same, with `clamp: true` | the nearer `to` endpoint |
| Descending `from` | mapping inverted |
| Descending `to` | mapping inverted; clamps to the correct visual end |
| Both descending | the inversions cancel |
| `from` zero width (`[5, 5]`, `[0, -0]`) | `RangeError` |
| `to` zero width | allowed — that constant, for any input |
| `from` identical to `to` | the identity |
| `value` is `NaN` | `NaN`, clamped or not |
| `from` bound is `NaN` | `NaN` — the zero-width guard does not fire |
| `value` is `±Infinity`, unclamped | `NaN` |
| `value` is `±Infinity`, clamped | the matching `to` endpoint |
| `from` infinitely wide | `t` is `0`, so every finite value maps to `to[0]` |
| `clamp: true` result | always between the `to` entries |
| Options object and tuples | never mutated |
