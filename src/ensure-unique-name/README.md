# ensureUniqueName

Returns `name` if it is not already taken, otherwise appends or increments a numeric suffix until it finds one that is free. `ensureUniqueName("Layer", ["Layer", "Layer1"])` gives `"Layer2"`.

Reach for it wherever a human-readable label has to stay unique within a collection: duplicated records, uploaded filenames, layer and artboard names, copied dashboards, sheet tabs.

## Why

The inline version everyone writes first:

```ts
let candidate = name;
let i = 1;
while (taken.has(candidate)) candidate = `${name}${i++}`;
```

It is correct exactly once — the first time you duplicate something. Then:

- **Suffixes stack.** Duplicating `"Layer"` gives `"Layer1"`. Duplicating `"Layer1"` gives `"Layer11"`, then `"Layer111"`. The naive loop treats the whole existing name as the base, including the counter it added last time. Real users duplicate the duplicate, and the names degrade fast.
- **Splitting the base is where the bugs are.** The fix is to peel the trailing digits off the input first, which means a regex, which means deciding what "trailing digits" means for `"v2.0"`, `"report2024"`, `"3"`, `"file.txt"` and `""`. Each of those has a defensible answer and a wrong one, and the wrong one only shows up in production.
- **Scanning for the max is O(n) per call and still wrong.** The other common approach — find the highest existing suffix and add one — walks the whole collection each time and never reuses a freed number, so after deleting `"Layer1"` and `"Layer2"` you get `"Layer4"`.

`ensureUniqueName` is one function that peels the suffix, probes upward from the right starting point, reuses gaps, and does its lookups against a `Set`.

## How it works

Four steps, all in eighteen lines.

**1. Normalise the collection.**

```ts
const set = existingNames instanceof Set ? existingNames : new Set(existingNames);
```

A `Set` is used as-is (no copy, no mutation); an array is copied into a fresh `Set`. That copy is O(n) and happens *per call*, so calling this in a loop over an array is O(n²). Build the `Set` once and pass that — see [Usage](#usage).

**2. Fast path.** If `name` is not in the set, it is returned verbatim. No regex, no allocation, no suffix. This is the common case and it costs one hash lookup.

**3. Split the base from the trailing counter.**

```ts
const [, base, digits] = name.match(/^(.*?)(\d+)$/) ?? [];
const baseName = base ?? name;
let counter = digits ? Number.parseInt(digits, 10) + 1 : 1;
```

The regex is anchored at both ends with a lazy prefix, so `(\d+)$` grabs the **entire** run of trailing digits and `(.*?)` gets everything before it. `"foo123"` splits into `"foo"` + `"123"`. `"foo"` does not match at all (no trailing digits), so `base` is `undefined`, `baseName` falls back to the whole name, and the counter starts at 1.

This is what stops suffixes from stacking: the counter is parsed out of the input rather than appended to it, so `"Layer1"` continues from 2 instead of becoming `"Layer11"`.

Two consequences worth knowing:

- **Leading zeros are lost.** `"foo01"` parses as base `"foo"`, counter `1`, so the next name is `"foo2"` — not `"foo02"`. The digits are re-emitted through `Number.prototype.toString`, not preserved as text.
- **The split is purely positional.** It knows nothing about file extensions or version strings. `"report.pdf"` has no trailing digits, so it becomes `"report.pdf1"`. `"v2.0"` ends in a digit, so it becomes `"v2.1"`. If you need `"report1.pdf"`, split the extension off yourself before calling.

**4. Probe upward.**

```ts
let candidateName = baseName + counter;
while (set.has(candidateName)) {
  counter++;
  candidateName = baseName + counter;
}
```

Linear probing from the starting counter, one `Set` lookup per step. It returns the **first free slot at or above the start**, not `max + 1` — so given `{foo, foo1, foo3}` the answer is `"foo2"`, filling the gap. That is usually what you want (numbers stay dense after deletions), but it does mean a name can be reused after the previous holder is removed, which matters if the name is a stable identifier somewhere else.

**Complexity.** O(1) for the fast path with a `Set`. Otherwise O(k) lookups, where k is the length of the consecutive run of taken names starting at the counter — not O(n) in the collection size. Add O(n) once if you pass an array. Adding a suffixed name to the set on each iteration keeps k at 1 amortised, so building a whole batch is linear.

**It does not mutate `existingNames`.** Whether you pass a `Set` or an array, the collection comes back untouched — the returned name is *not* registered. This is deliberate (the function stays pure and works on a `ReadonlySet`-shaped input), but it means that in a loop **you must add the result yourself** or every iteration will return the same name. That is the single most common way to misuse this function.

## API

### `ensureUniqueName`

```ts
function ensureUniqueName(name: string, existingNames: Set<string> | string[]): string;
```

- `name` — the desired name. If it ends in digits, they are treated as a counter to continue from rather than as part of the base.
- `existingNames` — names already taken. A `Set` is used directly; an array is copied into a `Set` (O(n) per call). Never mutated.

Returns `name` unchanged if it is free, otherwise `base + counter` for the smallest free counter at or above the starting value. Never throws.

## Usage

```ts
import { ensureUniqueName } from "@isel-jao/ts-lib";

ensureUniqueName("foo", new Set(["bar"])); // "foo"    — free, returned as-is
ensureUniqueName("foo", new Set(["foo"])); // "foo1"
ensureUniqueName("foo1", new Set(["foo1"])); // "foo2" — continues the counter
ensureUniqueName("foo", ["foo", "foo1", "foo2"]); // "foo3"
ensureUniqueName("foo", ["foo", "foo1", "foo3"]); // "foo2" — fills the gap
```

Duplicating a record. Note the explicit `add` — the function will not do it for you:

```ts
import { ensureUniqueName } from "@isel-jao/ts-lib";

interface Layer {
  name: string;
}

function duplicate(layers: Layer[], index: number): Layer[] {
  const taken = new Set(layers.map((l) => l.name));
  const copy = { ...layers[index], name: ensureUniqueName(layers[index].name, taken) };
  return [...layers, copy];
}
```

Importing a batch — build the `Set` once, then keep it current as you go. Passing the array instead would be O(n²) and would hand back the same name every time:

```ts
import { ensureUniqueName } from "@isel-jao/ts-lib";

function importAll(incoming: string[], existing: string[]): string[] {
  const taken = new Set(existing);
  const result: string[] = [];

  for (const name of incoming) {
    const unique = ensureUniqueName(name, taken);
    taken.add(unique); // required — ensureUniqueName does not register the result
    result.push(unique);
  }

  return result;
}

importAll(["logo", "logo", "logo", "icon"], ["logo"]);
// ["logo1", "logo2", "logo3", "icon"]
```

Filenames need the extension handled separately, since the suffix always lands at the very end:

```ts
import { ensureUniqueName } from "@isel-jao/ts-lib";

function uniqueFilename(filename: string, taken: Set<string>): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return ensureUniqueName(filename, taken);

  const stem = filename.slice(0, dot);
  const ext = filename.slice(dot);
  const stems = new Set([...taken].filter((n) => n.endsWith(ext)).map((n) => n.slice(0, -ext.length)));
  return ensureUniqueName(stem, stems) + ext;
}

uniqueFilename("report.pdf", new Set(["report.pdf"])); // "report1.pdf"
// without this wrapper: ensureUniqueName("report.pdf", ...) === "report.pdf1"
```

## Edge cases

| Input | Result | Source |
| --- | --- | --- |
| Name not taken | returned unchanged | test |
| Empty collection | returned unchanged | test |
| Name taken, no trailing digits (`"foo"`) | `"foo1"` | test |
| Name taken, ends in digits (`"foo1"`) | `"foo2"` — continues, does not stack | test |
| Consecutive suffixes taken (`foo`, `foo1`, `foo2`) | `"foo3"` | test |
| Gap in the sequence (`foo`, `foo1`, `foo3`) | `"foo2"` — fills the first gap, not `max + 1` | test |
| Array instead of a `Set` | accepted; copied into a `Set` each call (O(n)) | test |
| `existingNames` after the call | unchanged — the result is not registered for you | code |
| Leading-zero suffix (`"foo01"` taken) | `"foo2"` — zeros are not preserved | code |
| Zero suffix (`"foo0"` taken) | `"foo1"` | code |
| All-digit name (`"123"` taken) | `"124"` — base is empty, counter continues | code |
| Trailing digits after a dot (`"v2.0"` taken) | `"v2.1"` | code |
| Filename with an extension (`"report.pdf"` taken) | `"report.pdf1"` — no extension awareness | code |
| Empty string (`""` taken) | `"1"` | code |
