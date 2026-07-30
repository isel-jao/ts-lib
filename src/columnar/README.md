# Columnar

Converts between row-oriented data (`{ a, b }[]`) and column-oriented data (`{ a: [], b: [] }`), in both directions. The two forward functions differ only in where the column set comes from: `toColumnarByFirstKeys` takes the schema from the first row, `toColumnarByAllKeys` takes the union of every key seen (one extra pass). `fromColumnar` zips columns back into rows. Useful when a consumer wants parallel arrays rather than objects — charting libraries, CSV/TSV writers, bulk SQL inserts with array parameters, wire formats, or per-field aggregation that should not walk objects.

## Why

For two known fields the hand-written version (`rows.map((r) => r.timestamp)`) is a fair fight. It stops being one as soon as any of the following holds.

**The column set is not known at author time.** Query results, CSV headers, user-configured field lists, and event payloads all decide their keys at runtime. The inline version becomes a loop over `Object.keys` with an index signature and a cast — exactly the code in this module, written once here instead of once per call site.

**Rows are not uniformly shaped, and you have to pick a policy.** Given `[{ a: 1 }, { b: 2 }]`, do you want columns `{a}` (first row is the schema) or `{a, b}` (union)? Both are defensible, and they are different functions with different costs. Inline code tends to pick one implicitly and get it wrong on the first ragged input; here the choice is in the function name, and the cheap policy is the default.

**Alignment is a correctness property, not a nicety.** The whole point of columnar layout is that index `i` means the same row in every column. Both forward functions guarantee `column.length === objs.length`, because a missing key contributes `undefined` rather than being skipped. The natural hand-written mistake — `rows.filter((r) => r.b !== undefined).map((r) => r.b)` — produces a silently shorter column that no longer lines up with its siblings, and nothing throws. The bug surfaces later as a chart with the wrong point labels.

**The inverse direction is a nested loop nobody wants to write twice.** Going back requires deciding the row count from ragged columns and filling the gaps; `fromColumnar` fixes that (longest column wins, gaps are `undefined`) so the round trip is one call each way.

There is also a plain performance reason to hold data columnar: summing one field over 100k records touches one contiguous array of numbers instead of dereferencing 100k object shapes, and serializing a column of primitives is far cheaper than serializing 100k objects that each repeat their keys.

## How it works

All three are shallow transforms. None clone values — everything is copied by reference, so nested objects are shared between the row and column representations, and mutating `columns.user[0].name` mutates the original row's object.

### `toColumnarByFirstKeys` — schema from row 0

```ts
const [first] = objs;
if (first === undefined) return columns;      // empty input -> {}

for (const key of Object.keys(first)) {
  columns[key] = objs.map((obj) => obj[key]); // one full pass per column
}
```

The schema is read exactly once, from `objs[0]`; each column is then materialized with an independent `map` over the whole input. For `n` rows and `k` columns that is `k` passes, O(n·k) time and O(n·k) space in `k` arrays. Two consequences follow directly:

- **Keys absent from the first object are dropped.** `[{ a: 1 }, { a: 2, b: 3 }]` yields `{ a: [1, 2] }` — nothing ever looks at row 1's key set.
- **Keys missing from *later* rows are filled, not dropped.** The lookup is `obj[key]`, a plain property access rather than an `in` check, so a row without the key contributes `undefined` and the column keeps its length: `[{ a: 1, b: 2 }, { a: 3 }]` yields `{ a: [1, 3], b: [2, undefined] }`.

Reading the schema once is the point of this variant — for uniformly-shaped rows (a DB result set, a parsed CSV), scanning every row's keys would be pure waste.

### `toColumnarByAllKeys` — schema from the union

```ts
const keys = new Set<keyof T>();
for (const obj of objs) for (const key of Object.keys(obj)) keys.add(key);
for (const key of keys) columns[key] = objs.map((obj) => obj[key]);
```

Identical except for a pre-pass collecting the union of keys into a `Set`. `Set` preserves insertion order, so **columns are ordered by first appearance across the input** — `[{ b: 1 }, { a: 2, c: 3 }]` produces `["b", "a", "c"]`. The extra cost is one full traversal of every row's own keys plus the `Set`: still O(n·k), but with a materially larger constant on wide inputs. Use it only when rows may genuinely differ.

### Key collection semantics (both forward functions)

`Object.keys` collects **own, enumerable, string** keys, so inherited and symbol keys never become columns. But the *value* lookup is `obj[key]`, which does traverse the prototype chain — so if the first row makes `b` a column and a later row inherits `b` from its prototype, the inherited value lands in the column. Mixing class instances with plain records is therefore asymmetric: prototype properties can never create a column but can populate one.

Neither function distinguishes a missing key from an explicit `undefined`. Under `toColumnarByAllKeys`, `[{ a: undefined }, { a: 1 }]` and `[{}, { a: 1 }]` both yield `{ a: [undefined, 1] }`; the first case just also guarantees the column exists.

Column key order is preserved *as JavaScript preserves object key order*: integer-like string keys (`"0"`, `"42"`) are always enumerated first in ascending numeric order, ahead of the insertion-ordered string keys. If your field names are numeric strings, do not rely on declaration order surviving.

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

Three decisions worth knowing. **Row count is the longest column**, not the shortest and not the first, so ragged input is padded and never truncated: `{ a: [1, 2], b: [3] }` gives `[{ a: 1, b: 3 }, { a: 2, b: undefined }]`, discarding nothing. **Every row carries every key**, in the column object's key order, so all output rows have identical shape and ordering — which downstream code and V8's hidden classes both benefit from. And `Object.entries` is computed once outside the row loop, making the inner loop a straight indexed read: O(rows·cols) time, one object allocation per row.

The round trip is exact for uniformly-shaped rows — `fromColumnar(toColumnarByFirstKeys(rows))` deep-equals `rows`. It is *not* exact for ragged rows: a key absent on a row comes back as an own property with value `undefined`, so `"b" in row` flips from `false` to `true` even though `row.b` is still `undefined`. If own-key presence is load-bearing, the round trip is lossy in that one respect.

### Types

Both forward functions are declared `<T extends Record<string, unknown>>(objs: readonly T[]) => { [K in keyof T]: T[K][] }`, which is precise for uniformly-shaped rows and approximate otherwise. Two things to know before trusting the inferred type:

1. **Heterogeneous array literals infer `T` as a union**, and the mapped type distributes over it. `toColumnarByAllKeys([{ a: 1 }, { b: 2 }])` infers `{ a: number[]; b?: undefined[] } | { b: number[]; a?: undefined[] }` — a union of column shapes, not the actual `{ a: [1, undefined], b: [undefined, 2] }`. Annotate the type parameter explicitly when rows differ: `toColumnarByAllKeys<{ a?: number; b?: number }>([...])` produces the sane `{ a?: (number | undefined)[]; b?: (number | undefined)[] }`.
2. **The type never adds the `undefined` that gap-filling introduces.** `toColumnarByFirstKeys([{ a: 1, b: 2 }, { a: 3 }])` is typed `b: number[]` while the runtime value is `[2, undefined]`. Model optional fields as optional in the row type (`{ a: number; b?: number }`) if you want the compiler to reflect reality.

`fromColumnar` mirrors this: it takes `{ [K in keyof T]: readonly T[K][] }` and returns `T[]`, assuming rectangular columns. Ragged input still works at runtime, but the `undefined` padding is invisible in the type.

| Function | Time | Passes over input | Allocations |
| --- | --- | --- | --- |
| `toColumnarByFirstKeys` | O(n·k) | `k` (one per column) | `k` arrays |
| `toColumnarByAllKeys` | O(n·k) | `k + 1` (union pre-pass) | `k` arrays + one `Set` |
| `fromColumnar` | O(rows·cols) | one `Object.entries`, then rows × cols | one object per row |

## API

None of the three mutates its input, and none ever throws.

### `toColumnarByFirstKeys`

```ts
function toColumnarByFirstKeys<T extends Record<string, unknown>>(
  objs: readonly T[]
): { [K in keyof T]: T[K][] };
```

Rows to columns, using the **first object's own enumerable keys** as the column set. Returns an object keyed by `Object.keys(objs[0])` in that order, each mapped to that key's value from every row in row order. Every column has length `objs.length`; rows missing a key contribute `undefined`; keys appearing only on later rows are ignored. `{}` for empty input.

### `toColumnarByAllKeys`

```ts
function toColumnarByAllKeys<T extends Record<string, unknown>>(
  objs: readonly T[]
): { [K in keyof T]: T[K][] };
```

Same, but the column set is the **union of every own enumerable key on any row**, ordered by first appearance, at the cost of one extra pass. Every column has length `objs.length`, with `undefined` where a row lacked the key. `{}` for empty input.

### `fromColumnar`

```ts
function fromColumnar<T extends Record<string, unknown>>(
  columns: { [K in keyof T]: readonly T[K][] }
): T[];
```

Zips columns back into rows. Columns may differ in length; the result's length is the **longest** column's. Each row carries every key of `columns` in the same key order, with `undefined` where a column was shorter. `[]` for `{}` and for an object whose columns are all empty.

## Usage

Feeding a plotting API that wants parallel series, and handling ragged records where union semantics keep every field aligned to the row index:

```ts
import { toColumnarByAllKeys, toColumnarByFirstKeys } from "@isel-jao/ts-lib";

const { t, cpu, mem } = toColumnarByFirstKeys([
  { t: 0, cpu: 12, mem: 340 },
  { t: 1, cpu: 18, mem: 352 },
]);
chart.plot({ x: t, series: [cpu, mem] }); // t -> [0, 1], cpu -> [12, 18]

toColumnarByAllKeys([
  { level: "info", msg: "started" },
  { level: "error", err: "ECONNREFUSED" },
]);
// { level: ["info", "error"], msg: ["started", undefined], err: [undefined, "ECONNREFUSED"] }
```

Bulk insert with array parameters — one statement, one round trip, and the alignment guarantee is what makes the unnest correct:

```ts
const { id, name, email } = toColumnarByFirstKeys(users);

await db.query(
  `INSERT INTO users (id, name, email)
   SELECT * FROM unnest($1::int[], $2::text[], $3::text[])`,
  [id, name, email]
);
```

Column-wise work, then back to rows. Round-tripping uniform rows is identity-preserving:

```ts
import { fromColumnar, toColumnarByFirstKeys } from "@isel-jao/ts-lib";

const cols = toColumnarByFirstKeys([
  { name: "ana", score: 3 },
  { name: "bo", score: 7 },
]);
const total = cols.score.reduce((a, b) => a + b, 0); // 10

fromColumnar({ ...cols, score: cols.score.map((s) => s / total) });
// [{ name: "ana", score: 0.3 }, { name: "bo", score: 0.7 }]

fromColumnar(toColumnarByFirstKeys(rows)); // deep-equals rows, for uniform rows
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
