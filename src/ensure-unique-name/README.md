# ensureUniqueName

Returns `name` if it is free, otherwise appends or increments a numeric suffix until it finds one that is not taken. `ensureUniqueName("Layer", ["Layer", "Layer1"])` gives `"Layer2"`.

Reach for it wherever a human-readable label has to stay unique: duplicated records, uploaded filenames, layer names, sheet tabs.

## Why

The inline version everyone writes first:

```ts
let candidate = name;
let i = 1;
while (taken.has(candidate)) candidate = `${name}${i++}`;
```

It is correct exactly once. Duplicating `"Layer"` gives `"Layer1"`, but duplicating *that* gives `"Layer11"`, then `"Layer111"` — the loop treats the whole input as the base, including the counter it appended last time. Users duplicate duplicates, so the names degrade fast.

Fixing it means peeling the trailing digits off the input first, which means deciding what "trailing digits" means for `"v2.0"`, `"report2024"`, `"3"` and `""`. That decision is the whole function.

## How it works

1. **Normalize the collection.** A `Set` is used as-is; an array is copied into a fresh one. That copy is O(n) *per call*, so build the `Set` yourself if you are calling in a loop.
2. **Fast path.** If `name` is free it is returned verbatim — one hash lookup, no regex, no allocation.
3. **Split the base from the counter** with `/^(.*?)(\d+)$/`. The lazy prefix and the `$` anchor make `(\d+)` capture the entire trailing digit run, so `"foo123"` splits into base `"foo"` and a counter starting at `124`. A name with no trailing digits does not match, so the base is the whole name and the counter starts at 1. Parsing the counter *out of* the input rather than appending to it is what stops suffixes from stacking.
4. **Probe upward**, one `Set` lookup per step, returning the first free slot at or above the start. Given `{foo, foo1, foo3}` that is `"foo2"` — it fills the gap rather than taking `max + 1`, which keeps numbering dense after deletions but means a name can be reused once its previous holder is gone.

Two things to know:

- **It does not mutate `existingNames`.** The returned name is not registered for you, so in a loop you must `add` it yourself or every iteration hands back the same name. This is the most common way to misuse the function.
- **The split is purely positional**, with no notion of file extensions: `"report.pdf"` becomes `"report.pdf1"` and `"v2.0"` becomes `"v2.1"`. Split the extension off yourself if you need `"report1.pdf"`.

**Complexity.** O(1) on the fast path, otherwise O(k) lookups where k is the run of consecutive taken names from the starting counter — not O(n) in the collection size. Adding each result back to the set keeps k at 1 amortized.

## API

### `ensureUniqueName`

```ts
function ensureUniqueName(name: string, existingNames: Set<string> | string[]): string;
```

- `name` — the desired name. Trailing digits are treated as a counter to continue from, not as part of the base.
- `existingNames` — names already taken. A `Set` is used directly; an array is copied per call. Never mutated.

Returns `name` unchanged if it is free, otherwise `base + counter` for the smallest free counter at or above the starting value. Never throws.

## Usage

```ts
import { ensureUniqueName } from "@isel-jao/ts-lib";

ensureUniqueName("foo", new Set(["bar"]));        // "foo"  — free, returned as-is
ensureUniqueName("foo", new Set(["foo"]));        // "foo1"
ensureUniqueName("foo1", new Set(["foo1"]));      // "foo2" — continues, does not stack
ensureUniqueName("foo", ["foo", "foo1", "foo3"]); // "foo2" — fills the gap
```

In a loop, keep the set current as you go:

```ts
import { ensureUniqueName } from "@isel-jao/ts-lib";

function importAll(incoming: string[], existing: string[]): string[] {
  const taken = new Set(existing);
  return incoming.map((name) => {
    const unique = ensureUniqueName(name, taken);
    taken.add(unique); // required — ensureUniqueName does not register the result
    return unique;
  });
}

importAll(["logo", "logo", "logo", "icon"], ["logo"]); // ["logo1", "logo2", "logo3", "icon"]
```

## Edge cases

| Input | Result |
| --- | --- |
| Name free, or empty collection | returned unchanged |
| `"foo"` taken | `"foo1"` |
| `"foo1"` taken | `"foo2"` — continues, does not stack |
| `foo`, `foo1`, `foo3` taken | `"foo2"` — first gap, not `max + 1` |
| `"foo01"` taken | `"foo2"` — leading zeros are not preserved |
| `"foo0"` taken | `"foo1"` |
| `"123"` taken | `"124"` — empty base |
| `"v2.0"` taken | `"v2.1"` |
| `"report.pdf"` taken | `"report.pdf1"` — no extension awareness |
| `""` taken | `"1"` |
| `existingNames` after the call | unchanged — the result is not registered for you |
