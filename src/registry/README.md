# Registry

A generic named-value store: `Registry<V>` wraps a `Map<string, V>` and splits the two operations a `Map` conflates. Writing splits into `register` (throws if the name is taken) and `upsert` (overwrites). Reading splits into `get` (returns `undefined`) and `require` (throws). Reach for it when you have a plugin table, a handler lookup, or anything else populated at module-load time by code that does not know what else is being registered.

## Why

The naive version is a plain object, and it fails quietly in two ways.

**Duplicate registration silently clobbers.** Two modules both call `register("json", …)` and the second wins — no error, no warning, nothing the type system notices. Because registration usually happens as an import side effect, *which* one wins depends on module evaluation order, so the bug reproduces on one machine and not another and moving an unrelated import fixes or breaks it. This is the one thing a plain `Map` does not fix either: `map.set(k, v)` clobbers exactly as silently as `obj[k] = v`.

**Missing lookups fail at the wrong place.** `handlers[name](req)` throws `TypeError: handlers[name] is not a function`, naming neither the registry nor the key. So every call site grows the same three-line guard, with the error text drifting between copies.

Prototype safety (`handlers["toString"]` returning a function nobody registered) and honest `V | undefined` types come free from `Map`, which is why the class wraps one. But a write that *refuses* to overwrite is not something you can get by being careful. Making refusal the default and forcing the deliberate case to spell itself `upsert` converts a load-order-dependent silent overwrite into an exception at startup with the offending name in the message. That is the whole point; everything else is convenience.

The `get`/`require` split is the same move applied to reads. Both behaviors are legitimate — an optional formatter should fall back, a required codec should not boot — but which one you want is a property of the call site, not the registry.

## How it works

One class over one private `Map<string, V>`.

### The write split

```ts
register(name: string, value: V): void {
  if (this.entries.has(name)) throw new Error(`Already registered: ${name}`);
  this.entries.set(name, value);
}

upsert(name: string, value: V): void {
  this.entries.set(name, value);
}
```

`register` guards with `.has()` rather than a truthiness check on `.get()`, so a registered `0`, `""`, `false`, or `null` still blocks a duplicate. The throw happens *before* the `set`, so a rejected registration leaves the existing value untouched — pinned by a test.

Use `register` for anything populated once at startup by independent modules; a collision there means two components claimed the same name, which is a composition bug you want loud and at boot. Use `upsert` for anything legitimately re-assignable — a test swapping in a fake, a hot-reload path, a config layer where a later source wins. The asymmetry is deliberate: the safe operation gets the obvious name and the destructive one has to be asked for.

### The read split, and a real trap

```ts
require(name: string): V {
  const val = this.entries.get(name);
  if (!val) throw new Error(`Not registered: ${name}`);
  return val;
}
```

`get` is a pass-through; `require` narrows `V | undefined` to `V`, collapsing guard-then-use into one call while keeping a message that names the key.

**But `if (!val)` is not `if (val === undefined)`.** A registry whose value type includes falsy members will have `require` throw for names that *are* registered:

```ts
const flags = new Registry<number>();
flags.register("retries", 0);
flags.has("retries");     // true
flags.get("retries");     // 0
flags.require("retries"); // throws Error("Not registered: retries")
```

The same applies to `""`, `false`, `null`, `NaN`, and `0n`. The tests only exercise `require` with a truthy string, so they miss it. Until the check is tightened to `=== undefined`, treat `require` as safe only for object- or function-valued registries — the common case, and probably why it has survived. `get` and `has` report such entries correctly.

### Invariants worth knowing

- **Insertion order is preserved.** `list()` returns names in registration order. `upsert` updates in place and does not move a key; `unregister` then `register` moves it to the end.
- **`list()` returns a fresh array** built by `Array.from`, so callers can sort or splice it freely, at the cost of an allocation per call.
- **Values are stored by reference** — no cloning, no freezing. Mutating a registered object is visible through every later `get`.
- **`entries` is TypeScript-private, not runtime-private.** It is `private readonly`, not `#entries`, so `(reg as any).entries` reaches the live `Map` and bypasses every guard. `readonly` prevents rebinding the field, not mutating the `Map`.
- **No iteration surface** — no `values()`, `size`, `clear()`, or `[Symbol.iterator]`. Use `list().map((n) => reg.require(n))`. Exposing the `Map` directly would hand callers a `set` that skips `register`'s duplicate check.

## API

`class Registry<V>`, constructed with no arguments.

| Method | Returns | Throws |
| --- | --- | --- |
| `register(name: string, value: V)` | `void` | `Error("Already registered: ${name}")` if present; existing value preserved |
| `upsert(name: string, value: V)` | `void` | never |
| `unregister(name: string)` | `true` if removed, `false` if absent | never |
| `get(name: string)` | `V \| undefined` | never |
| `require(name: string)` | `V` | `Error("Not registered: ${name}")` if the stored value is **falsy** — see the trap above |
| `has(name: string)` | `boolean`, regardless of value truthiness | never |
| `list()` | fresh `string[]` in insertion order | never |

Keys are `string` only; the class is generic in `V` alone. Numeric IDs must be stringified consistently on both write and read.

## Usage

A plugin table populated by independent modules:

```ts
import { Registry } from "@isel-jao/ts-lib";

type Formatter = (value: unknown) => string;
export const formatters = new Registry<Formatter>();

// json.ts
formatters.register("json", (v) => JSON.stringify(v, null, 2));

// csv.ts
formatters.register("csv", (v) => toCsv(v));

// A third module claiming "json" fails at import time with
// Error: Already registered: json — instead of one formatter silently winning.
```

`get` for optional, `require` for required:

```ts
const fn = formatters.get(format) ?? String; // fall back when nothing is registered
return formatters.require(format)(value);    // the user asked for it; missing is an error
```

`upsert` exists for the deliberate overwrite — production registers once, a test swaps and restores:

```ts
const clients = new Registry<HttpClient>();
clients.register("api", realClient);

const original = clients.require("api");
afterEach(() => clients.upsert("api", original));

it("retries on 503", async () => {
  clients.upsert("api", fakeClientReturning(503));
  await expect(fetchUser("u1")).resolves.toBeNull();
});
```

Using `register` here would throw on the second call; using `upsert` for production registration would lose the collision check.

## Edge cases

| Case | Behavior |
| --- | --- |
| **`require` on a falsy registered value** | **Throws `Not registered`, incorrectly** — the check is `if (!val)`. Not covered by the test suite. Use `get` plus your own `=== undefined` check. |
| `register` on a falsy existing value | Correct — the duplicate guard uses `.has()`, so it throws `Already registered` as intended. |
| `get` on a missing name | `undefined`, indistinguishable from an entry registered *as* `undefined`. Use `has` to tell them apart. |
| `Registry<T \| undefined>` | Legal but ambiguous — `has` is the only reliable presence test. |
| `unregister` on a missing name | `false`, no throw. The name is free to `register` again afterwards. |
| Empty-string name | `""` is a valid key; nothing rejects it. |
| `__proto__` / `toString` as names | Safe — backed by a `Map`, so these are ordinary keys with no prototype interaction. This is the concrete reason for `Map` over `Record`. |
| Thrown error type | Plain `Error`, not a subclass, so failures are distinguishable only by message text. |
| Access to internals | `(reg as any).entries` returns the live `Map` and bypasses every guard. |
