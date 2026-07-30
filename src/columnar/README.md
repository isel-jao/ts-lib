# Columnar

Converts between row-oriented data (`{ a, b }[]`) and column-oriented data (`{ a: [], b: [] }`), in both directions. Two forward functions differ only in where the column set comes from: `toColumnarByFirstKeys` takes the schema from the first row (one pass per column), `toColumnarByAllKeys` takes the union of every key seen (one extra pass). `fromColumnar` zips columns back into rows. Useful when a consumer wants parallel arrays rather than objects — charting libraries, CSV/TSV writers, bulk SQL inserts with array parameters, wire formats, or any per-field aggregation that should not walk objects.

## Why

For two known fields, the hand-written version is a fair fight:

```ts
const xs = rows.map((r) => r.timestamp);
const ys = rows.map((r) => r.value);
```

It stops being a fair fight as soon as any of the following is true.

**The column set is not known at author time.** Query results, CSV headers, user-configured field lists, and event payloads all decide their keys at runtime. The inline version becomes a loop over `Object.keys` with an index signature and a cast, which is exactly the code in this module — written once here instead of once per call site.

**Rows are not uniformly shaped, and you have to pick a policy.** Given `[{ a: 1 }, { b: 2 }]`, do you want columns `{a}` (first row is the schema) or `{a, b}` (union)? Both are defensible and they are different functions with different costs. Inline code tends to pick one implicitly and get it wrong on the first ragged input. Here the choice is in the function name, and the cheap policy is the one you reach for by default.

**Alignment is a correctness property, not a nicety.** The entire point of columnar layout is that index `i` means the same row in every column. Both forward functions guarantee `column.length === objs.length` for every column, because a missing key contributes `undefined` rather than being skipped. The natural hand-written mistake —

```ts
const bs = rows.filter((r) => r.b !== undefined).map((r) => r.b); // silently shorter
```

— produces a column that no longer lines up with its siblings, and nothing throws. The bug shows up later as a chart with the wrong point labels.

**The inverse direction is a nested loop nobody wants to write twice.** Going back from columns to rows requires deciding the row count from ragged columns and filling the gaps; `fromColumnar` fixes that (longest column wins, gaps are `undefined`) so the round trip is one function call each way.

There is also a plain performance reason to hold data columnar in the first place: summing one field over 100k records touches one contiguous array of numbers instead of dereferencing 100k object shapes, and serializing a column of primitives is far cheaper than serializing 100k objects that each repeat their keys.

## How it works

All three functions are shallow, allocation-heavy-but-simple transforms. None of them clone values: everything is copied by reference, so nested objects are shared between the row and column representations. Mutating `columns.user[0].name` mutates the original row's object.

### `toColumnarByFirstKeys` — schema from row 0

```ts
const [first] = objs;
if (first === undefined) return columns;      // empty input -> {}

for (const key of Object.keys(first)) {
  columns[key] = objs.map((obj) => obj[key]); // one full pass per column
}
```

The schema is read exactly once, from `objs[0]`. Then each column is materialized with an independent `map` over the whole input. For `n` rows and `k` columns that is `k` passes, `O(n·k)` time and `O(n·k)` space in `k` arrays.

Two consequences follow directly from that shape:

- **Keys absent from the first object are dropped.** `[{ a: 1 }, { a: 2, b: 3 }]` yields `{ a: [1, 2] }` — `b` never becomes a column because nothing ever looks at row 1's key set.
- **Keys missing from *later* rows are not dropped, they are filled.** The lookup is `obj[key]`, a plain property access, not an `in` check, so a row without the key contributes `undefined` and the column keeps its length. `[{ a: 1, b: 2 }, { a: 3 }]` yields `{ a: [1, 3], b: [2, undefined] }`.

Reading the schema once is the whole point of this variant: for the common case of uniformly-shaped rows (a DB result set, a parsed CSV), scanning every row's keys would be pure waste.

### `toColumnarByAllKeys` — schema from the union

```ts
const keys = new Set<keyof T>();
for (const obj of objs) for (const key of Object.keys(obj)) keys.add(key);
for (const key of keys) columns[key] = objs.map((obj) => obj[key]);
```

Identical except for a pre-pass that collects the union of keys into a `Set`. `Set` preserves insertion order, so **columns are ordered by first appearance across the input**: `[{ b: 1 }, { a: 2, c: 3 }]` produces keys `["b", "a", "c"]`. The extra cost is one full traversal of every row's own keys plus the `Set` — still `O(n·k)`, but with a materially larger constant on wide inputs. Use it only when rows may genuinely differ.

### Key collection semantics (both forward functions)

`Object.keys` collects **own, enumerable, string** keys. Inherited and symbol keys never become columns. But the *value* lookup is `obj[key]`, which does traverse the prototype chain — so if the first row makes `b` a column and a later row inherits `b` from its prototype, the inherited value lands in the column. Mixing prototype-bearing objects (class instances) with plain records is therefore asymmetric: prototype properties can never create a column but can populate one.

Neither function distinguishes a missing key from an explicit `undefined` value. `[{ a: undefined }, { a: 1 }]` and `[{}, { a: 1 }]` both yield `{ a: [undefined, 1] }` under `toColumnarByAllKeys`; the first case just also guarantees the column exists.

Column key order is preserved *as JavaScript preserves object key order*: integer-like string keys ("0", "1", "42") are always enumerated first, in ascending numeric order, ahead of the insertion-ordered string keys. If your field names are numeric strings, do not rely on declaration order surviving.

### `fromColumnar` — the inverse

```ts
const entries = Object.entries(columns);

let rowCount = 0;
for (const [, column] of entries) rowCount = Math.max(rowCount, column.length);

for (let i = 0; i < rowCount; i++) {
  const row = {};
  for (const [key, column] of entries) row[key] = column[i];
  rows.push(row);
}
```

Three decisions worth knowing:

- **Row count is the longest column, not the shortest and not the first.** Ragged input is padded, never truncated: `{ a: [1, 2], b: [3] }` gives `[{ a: 1, b: 3 }, { a: 2, b: undefined }]`. Nothing is silently discarded.
- **Every row carries every key**, in the column object's key order, so all output rows have identical shape and identical key ordering. Downstream code (and V8's hidden classes) benefit from that uniformity.
- `Object.entries` is computed once, outside the row loop, so the inner loop is a straight indexed read. Complexity is `O(rows·cols)` time, one object allocation per row.

The round trip is exact for uniformly-shaped rows — `fromColumnar(toColumnarByFirstKeys(rows))` deep-equals `rows`. It is *not* exact for ragged rows: a key that was absent on a row comes back as an own property with value `undefined`, so `"b" in row` flips from `false` to `true` even though `row.b` is still `undefined`. If own-key presence is load-bearing in your code, the round trip is lossy in that one respect.

### Types

Both forward functions are declared as:

```ts
<T extends Record<string, unknown>>(objs: readonly T[]) => { [K in keyof T]: T[K][] }
```

which is precise for uniformly-shaped rows and approximate otherwise. Two things to know before trusting the inferred type:

1. **Heterogeneous array literals infer `T` as a union**, and the mapped type distributes over it. `toColumnarByAllKeys([{ a: 1 }, { b: 2 }])` infers `{ a: number[]; b?: undefined[] } | { b: number[]; a?: undefined[] }` — a union of column shapes, not the actual `{ a: [1, undefined], b: [undefined, 2] }`. Annotate the type parameter explicitly when rows differ: `toColumnarByAllKeys<{ a?: number; b?: number }>([...])` produces the sane `{ a?: (number | undefined)[]; b?: (number | undefined)[] }`.
2. **The type never adds the `undefined` that gap-filling introduces.** `toColumnarByFirstKeys([{ a: 1, b: 2 }, { a: 3 }])` is typed with `b: number[]` while the runtime value is `[2, undefined]`. Model optional fields as optional in the row type (`{ a: number; b?: number }`) if you want the compiler to reflect reality.

`fromColumnar` mirrors this: it takes `{ [K in keyof T]: readonly T[K][] }` and returns `T[]`, which assumes rectangular columns. Ragged input still works at runtime, but the `undefined` padding is not visible in the type.

### Complexity summary

| Function | Time | Passes over input | Allocations |
| --- | --- | --- | --- |
| `toColumnarByFirstKeys` | O(n·k) | `k` (one per column) | `k` arrays |
| `toColumnarByAllKeys` | O(n·k) | `k + 1` (union pre-pass) | `k` arrays + one `Set` |
| `fromColumnar` | O(rows·cols) | one `Object.entries`, then rows × cols | one object per row |

## API

### `toColumnarByFirstKeys`

```ts
function toColumnarByFirstKeys<T extends Record<string, unknown>>(
  objs: readonly T[]
): { [K in keyof T]: T[K][] };
```

Converts rows to columns using the **first object's own enumerable keys** as the column set.

- `objs` — the rows. Not mutated. May be empty.
- **Returns** an object whose keys are `Object.keys(objs[0])` in that order, each mapped to an array of that key's value from every row, in row order. Every column has length `objs.length`. Rows missing a key contribute `undefined`. Keys appearing only on later rows are ignored. Returns `{}` for an empty input.

Never throws.

### `toColumnarByAllKeys`

```ts
function toColumnarByAllKeys<T extends Record<string, unknown>>(
  objs: readonly T[]
): { [K in keyof T]: T[K][] };
```

Same as above, but the column set is the **union of every own enumerable key on any row**, ordered by first appearance. Costs one extra pass over the input.

- `objs` — the rows. Not mutated. May be empty.
- **Returns** an object with one column per distinct key; every column has length `objs.length`, with `undefined` where a row lacked the key. Returns `{}` for an empty input.

Never throws.

### `fromColumnar`

```ts
function fromColumnar<T extends Record<string, unknown>>(
  columns: { [K in keyof T]: readonly T[K][] }
): T[];
```

The inverse: zips columns back into row objects.

- `columns` — an object of arrays. Not mutated. Columns may be of differing lengths.
- **Returns** an array of rows whose length is the **longest** column's length. Each row carries every key of `columns`, in the same key order, with `undefined` where a column was shorter. Returns `[]` for `{}` and for an object whose columns are all empty.

Never throws.

## Usage

Feeding a plotting API that wants parallel series:

```ts
import { toColumnarByFirstKeys } from "@isel-jao/ts-lib";

const samples = [
  { t: 0, cpu: 12, mem: 340 },
  { t: 1, cpu: 18, mem: 352 },
  { t: 2, cpu: 15, mem: 351 },
];

const { t, cpu, mem } = toColumnarByFirstKeys(samples);
// t   -> [0, 1, 2]
// cpu -> [12, 18, 15]
// mem -> [340, 352, 351]

chart.plot({ x: t, series: [cpu, mem] });
```

Ragged records — union semantics keep every field and keep every column aligned to the row index:

```ts
import { toColumnarByAllKeys } from "@isel-jao/ts-lib";

type LogRow = { level: string; msg?: string; err?: string };

const events: LogRow[] = [
  { level: "info", msg: "started" },
  { level: "error", err: "ECONNREFUSED" },
];

toColumnarByAllKeys(events);
// { level: ["info", "error"], msg: ["started", undefined], err: [undefined, "ECONNREFUSED"] }
```

Bulk insert with array parameters — the non-trivial case. One statement, one round trip, and the alignment guarantee is what makes the unnest correct:

```ts
import { toColumnarByFirstKeys } from "@isel-jao/ts-lib";

const users = [
  { id: 1, name: "ana", email: "ana@example.com" },
  { id: 2, name: "bo", email: "bo@example.com" },
];

const { id, name, email } = toColumnarByFirstKeys(users);

await db.query(
  `INSERT INTO users (id, name, email)
   SELECT * FROM unnest($1::int[], $2::text[], $3::text[])`,
  [id, name, email]
);
```

Column-wise work, then back to rows:

```ts
import { fromColumnar, toColumnarByFirstKeys } from "@isel-jao/ts-lib";

const rows = [
  { name: "ana", score: 3 },
  { name: "bo", score: 7 },
];

const cols = toColumnarByFirstKeys(rows);
const total = cols.score.reduce((a, b) => a + b, 0); // 10

const normalized = fromColumnar({
  ...cols,
  score: cols.score.map((s) => s / total),
});
// [{ name: "ana", score: 0.3 }, { name: "bo", score: 0.7 }]
```

Round-tripping uniform rows is identity-preserving:

```ts
import { fromColumnar, toColumnarByFirstKeys } from "@isel-jao/ts-lib";

const rows = [
  { a: 1, b: 2 },
  { a: 3, b: 4 },
];

fromColumnar(toColumnarByFirstKeys(rows)); // deep-equals rows
```

## Edge cases

| Input | Result |
| --- | --- |
| `toColumnarByFirstKeys([])` / `toColumnarByAllKeys([])` | `{}` |
| `fromColumnar({})` | `[]` |
| `toColumnarByFirstKeys([{ a: 1, b: "x" }])` (single row) | `{ a: [1], b: ["x"] }` |
| `toColumnarByFirstKeys([{ b: 1, a: 2 }, ...])` | Column order follows the first object: `["b", "a"]` |
| `toColumnarByAllKeys([{ b: 1 }, { a: 2, c: 3 }])` | Column order follows first appearance: `["b", "a", "c"]` |
| `toColumnarByFirstKeys([{ a: 1, b: 2 }, { a: 3 }])` | `{ a: [1, 3], b: [2, undefined] }` — columns stay aligned |
| `toColumnarByFirstKeys([{ a: 1 }, { a: 2, b: 3 }])` | `{ a: [1, 2] }` — `b` is ignored entirely |
| `toColumnarByAllKeys([{ a: 1 }, { a: 2, b: 3 }])` | `{ a: [1, 2], b: [undefined, 3] }` |
| Explicit `undefined` value (`[{ a: undefined }, { a: 1 }]`) | `{ a: [undefined, 1] }` — indistinguishable from a missing key |
| `fromColumnar({ a: [1, 2], b: [3] })` | `[{ a: 1, b: 3 }, { a: 2, b: undefined }]` — longest column wins |
| `fromColumnar({ b: [1], a: [2] })` | Each row's key order matches the column object: `["b", "a"]` |
| Symbol keys on rows | Ignored — `Object.keys` / `Object.entries` are string-only |
| Inherited (prototype) properties | Never create a column, but do populate a column created by an own key on another row |
| Integer-like key names (`"0"`, `"12"`) | Enumerated first in ascending numeric order by JS itself; declaration order is not preserved |
| Object/array values | Shared by reference, not cloned — columns and rows alias the same nested objects |
| Round trip of ragged rows | Values match, but absent keys return as own properties with value `undefined` (`"b" in row` becomes `true`) |
