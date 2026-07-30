# Registry

A generic named-value store: `Registry<V>` wraps a `Map<string, V>` and splits the two operations a `Map` conflates. Writing splits into `register` (throws if the name is taken) and `upsert` (overwrites). Reading splits into `get` (returns `undefined`) and `require` (throws). Reach for it when you have a plugin table, a handler lookup, a codec list, or anything else populated at module-load time by code that does not know what else is being registered.

## Why

The naive version is a plain object:

```ts
const handlers: Record<string, Handler> = {};

export function registerHandler(name: string, fn: Handler) {
  handlers[name] = fn;
}

export function runHandler(name: string, req: Request) {
  handlers[name](req);
}
```

Four things go wrong with this, and they go wrong quietly.

**1. Duplicate registration silently clobbers.** Two modules both call `registerHandler("json", …)`. The second one wins. There is no error, no warning, and nothing in the type system that notices. Because registration usually happens as an import side effect, *which* one wins depends on module evaluation order — so the bug reproduces on one machine and not another, and moving an unrelated import fixes or breaks it. This is the failure mode that costs an afternoon, and it is the one thing a plain `Map` still does not fix: `map.set(k, v)` clobbers exactly as silently as `obj[k] = v`.

**2. Missing lookups fail at the wrong place.** `handlers[name](req)` on an unregistered name throws `TypeError: handlers[name] is not a function` — a message that names neither the registry nor the key you asked for. So every call site grows the same guard:

```ts
const fn = handlers[name];
if (!fn) throw new Error(`No handler for ${name}`);
fn(req);
```

Three lines, repeated at every read, with the error text drifting between copies.

**3. A plain object inherits `Object.prototype`.** `handlers["toString"]` returns a function that was never registered. `handlers["__proto__"] = fn` does not create an entry at all. If names ever come from user input, config files, or a filesystem scan, these are real cases. `Map` fixes this, which is why the class wraps one rather than a `Record`.

**4. The types lie unless you have opted in.** Without `noUncheckedIndexedAccess`, `handlers[name]` is typed `Handler`, not `Handler | undefined` — the compiler actively tells you the guard is unnecessary. (This repo does enable that flag, but consumers may not.)

So: why is a 34-line class better than the 5-line inline helper?

The answer is item 1, not the rest. Prototype safety and honest optional types come free from `Map`. What `Map` does not have — and what you cannot get by "just being careful" — is a write that *refuses* to overwrite. Making that the default and forcing the deliberate case to spell itself `upsert` converts the worst class of bug here (a load-order-dependent silent overwrite) into an exception thrown at startup with the offending name in the message. Everything else in the class is convenience; `register`'s duplicate check is the whole point.

The `get`/`require` split is the same move applied to reads. Both behaviors are legitimate — an optional formatter should fall back, a required codec should not boot — but which one you want is a property of the call site, not the registry. Encoding both once means neither has to be re-implemented, and `require`'s message is uniform everywhere it fires.

## How it works

The implementation is one class over one `Map`:

```ts
export class Registry<V> {
  private readonly entries = new Map<string, V>();
  // …
}
```

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

`register` guards with `.has()` — not with a truthiness check on `.get()` — so a registered `0`, `""`, `false`, or `null` still blocks a duplicate. The throw happens *before* the `set`, so a rejected registration leaves the existing value untouched; `index.test.ts` pins this explicitly ("does not overwrite the existing value when it throws").

**When each is correct:**

- **`register`** for anything populated once at startup by independent modules — plugins, protocol handlers, named strategies, DI providers. A collision here means two components have claimed the same name, which is a bug in the *composition* of the program, not a runtime condition. You want it loud, at boot, before any request is served.
- **`upsert`** for anything legitimately re-assignable — a test that swaps in a fake, a hot-reload path re-installing a module's exports, a cache, a config layer where a later source is meant to win. Reaching for `upsert` should feel like a decision, which is exactly why it does not share a name with `register`.

The asymmetry is deliberate: the safe operation gets the short, obvious name and the destructive one has to be asked for. If `register` overwrote and `upsert` threw, every collision would be silent by default. Note that `upsert` never throws, so there is no path by which a value is rejected — if you need "overwrite, but only if it already exists", compose it from `has` yourself.

### The read split

```ts
get(name: string): V | undefined {
  return this.entries.get(name);
}

require(name: string): V {
  const val = this.entries.get(name);
  if (!val) throw new Error(`Not registered: ${name}`);
  return val;
}
```

`get` is a pass-through, so the caller handles absence — `??`, optional chaining, an `if`. `require` narrows `V | undefined` to `V` and throws otherwise, which is what makes it worth having: it collapses the guard-then-use pattern into one call while keeping a message that names the key. The distinction maps directly onto the call site's contract — *"use the custom serializer if one is registered"* is `get`, *"the `postgres` driver must be installed"* is `require`.

**`require` uses a truthiness check, and that is a real trap.** `if (!val)` is not `if (val === undefined)`. A registry whose value type includes falsy members will have `require` throw `Not registered` for names that *are* registered:

```ts
const flags = new Registry<number>();
flags.register("retries", 0);
flags.has("retries");     // true
flags.get("retries");     // 0
flags.require("retries"); // throws Error("Not registered: retries")
```

The same applies to `Registry<string>` holding `""`, `Registry<boolean>` holding `false`, and any `V` admitting `null`, `NaN`, or `0n`. The existing tests only exercise `require` with a truthy `string`, so they do not catch it. Until the check is tightened to `=== undefined`, treat `require` as safe only for object- or function-valued registries — which is the overwhelmingly common case, and probably why it has survived. `get` and `has` are unaffected and report such entries correctly.

### The remaining methods

`unregister`, `has`, and `list` are thin:

```ts
unregister(name: string): boolean { return this.entries.delete(name); }
has(name: string): boolean        { return this.entries.has(name); }
list(): string[]                  { return Array.from(this.entries.keys()); }
```

`unregister` returns `Map.delete`'s boolean directly, so the return value distinguishes "removed" from "was not there". `list` materializes a **new array** on every call rather than returning the live `MapIterator`, which means callers can `sort`, `push`, or `splice` the result without touching the registry — at the cost of an allocation per call.

### Invariants and consequences

- **Insertion order is preserved.** `Map` iteration order is insertion order, so `list()` returns names in registration order. `upsert` on an existing key updates the value *in place* and does not move it. `unregister` followed by `register` does move it — the key goes to the end. The tests cover the basic ordering (`["a", "b"]`) and the post-`unregister` case.
- **Keys are `string`, not generic.** The class is generic in `V` only. Symbol and numeric keys are not supported; numbers must be stringified by the caller.
- **Values are stored by reference.** No cloning, no freezing. Mutating a registered object mutates what every subsequent `get` observes.
- **`entries` is TypeScript-private, not runtime-private.** It is `private readonly`, not `#entries`, so `(reg as any).entries` reaches the underlying `Map` at runtime and `JSON.stringify` / `console.log` will surface it. `readonly` prevents rebinding the field, not mutating the `Map`. If encapsulation matters more than the ergonomics of debugging, `#entries` is the change.
- **No iteration surface.** There is no `values()`, `entries()`, `size`, `clear()`, or `[Symbol.iterator]`. `list().map((n) => reg.require(n))` is the idiom for walking values, and `list().length` for the count. Adding these is straightforward, but note that exposing the `Map` directly would hand callers a `set` that bypasses `register`'s duplicate check — the reason the field is private in the first place.
- **No instance state beyond the `Map`.** Every `new Registry()` is independent; there is no shared or global registry. Module-level singletons are the caller's job.

## API

### `class Registry<V>`

Constructed with no arguments. `V` is the value type.

```ts
const registry = new Registry<Handler>();
```

#### `register(name: string, value: V): void`

Adds a new entry.

- `name` — the key. Any string, including `""` and `"__proto__"`.
- `value` — the value to store.
- **Returns** `void`.
- **Throws** `Error("Already registered: ${name}")` if `name` is already present. The existing value is left unchanged.

#### `upsert(name: string, value: V): void`

Adds a new entry or overwrites an existing one.

- `name` — the key.
- `value` — the value to store.
- **Returns** `void`.
- **Throws** nothing.

#### `unregister(name: string): boolean`

Removes an entry.

- `name` — the key to remove.
- **Returns** `true` if an entry was removed, `false` if `name` was not present.
- **Throws** nothing.

#### `get(name: string): V | undefined`

Looks up a value.

- `name` — the key to look up.
- **Returns** the stored value, or `undefined` if `name` is not registered.
- **Throws** nothing.

#### `require(name: string): V`

Looks up a value that must exist.

- `name` — the key to look up.
- **Returns** the stored value, narrowed to `V`.
- **Throws** `Error("Not registered: ${name}")` if the stored value is falsy — which includes the not-registered case but **also** a registered `0`, `""`, `false`, `null`, `NaN`, or `0n`. See [Edge cases](#edge-cases).

#### `has(name: string): boolean`

- `name` — the key to test.
- **Returns** `true` if `name` is registered, regardless of the value's truthiness.
- **Throws** nothing.

#### `list(): string[]`

- **Returns** a new array of all registered names in insertion order. Empty array when nothing is registered. Mutating the result does not affect the registry.
- **Throws** nothing.

## Usage

### A plugin table populated by independent modules

```ts
import { Registry } from "@isel-jao/ts-lib";

type Formatter = (value: unknown) => string;

export const formatters = new Registry<Formatter>();

// json.ts
formatters.register("json", (v) => JSON.stringify(v, null, 2));

// csv.ts
formatters.register("csv", (v) => toCsv(v));

// If a third module also claims "json", the process fails at import time with
// Error: Already registered: json — instead of one formatter silently winning.
```

### `get` for optional, `require` for required

```ts
import { Registry } from "@isel-jao/ts-lib";

const formatters = new Registry<Formatter>();

// Optional: fall back when nothing is registered.
function preview(value: unknown, format: string): string {
  const fn = formatters.get(format) ?? String;
  return fn(value);
}

// Required: the user explicitly asked for this format, so a missing one is an error.
function writeOutput(value: unknown, format: string): string {
  return formatters.require(format)(value);
  // throws Error("Not registered: yaml") if `yaml` was never registered
}
```

### Swapping an implementation in a test

This is the case `upsert` exists for: production code registers once, the test deliberately overwrites and restores.

```ts
import { Registry } from "@isel-jao/ts-lib";
import { afterEach, expect, it } from "vitest";

const clients = new Registry<HttpClient>();
clients.register("api", realClient);

const original = clients.require("api");
afterEach(() => clients.upsert("api", original));

it("retries on 503", async () => {
  clients.upsert("api", fakeClientReturning(503));
  await expect(fetchUser("u1")).resolves.toBeNull();
});
```

Using `register` here would throw on the second call; using `upsert` in production registration would lose the collision check. Both operations are needed, which is why both exist.

### Ordered startup with validation

A non-trivial case combining `list`, `has`, and `require` — resolving a registry of tasks against declared dependencies, using `list()`'s insertion order as the tie-break.

```ts
import { Registry } from "@isel-jao/ts-lib";

interface Task {
  deps: string[];
  run(): Promise<void>;
}

const tasks = new Registry<Task>();
tasks.register("db", { deps: [], run: connectDb });
tasks.register("cache", { deps: ["db"], run: warmCache });
tasks.register("server", { deps: ["db", "cache"], run: listen });

/** Fail fast on a dependency that nobody registered, before running anything. */
function validate(): void {
  const missing = tasks
    .list()
    .flatMap((name) => tasks.require(name).deps.map((d) => [name, d] as const))
    .filter(([, dep]) => !tasks.has(dep));

  if (missing.length > 0) {
    const detail = missing.map(([from, dep]) => `${from} -> ${dep}`).join(", ");
    throw new Error(`Unresolved task dependencies: ${detail}`);
  }
}

async function boot(): Promise<void> {
  validate();
  const done = new Set<string>();
  // list() is insertion-ordered, so a topologically-sorted registration order runs as declared.
  for (const name of tasks.list()) {
    const task = tasks.require(name);
    for (const dep of task.deps) {
      if (!done.has(dep)) throw new Error(`${name} requires ${dep}, which has not run`);
    }
    await task.run();
    done.add(name);
  }
}
```

Note the `has` in `validate` versus the `require` in `boot`: `has` is the right check when you only want to know about presence and have your own error to raise, and `require` is right when you already know the key came from `list()`.

### Removing entries

```ts
import { Registry } from "@isel-jao/ts-lib";

const listeners = new Registry<() => void>();
listeners.register("resize", onResize);

listeners.unregister("resize"); // true
listeners.unregister("resize"); // false — already gone, no throw
listeners.has("resize");        // false

// The name is free again after unregistering.
listeners.register("resize", onResizeV2); // ok
```

## Edge cases

| Case | Behavior |
| --- | --- |
| **`require` on a falsy registered value** | **Throws `Not registered`, incorrectly.** The check is `if (!val)`, not `val === undefined`. `Registry<number>` holding `0`, `Registry<string>` holding `""`, `Registry<boolean>` holding `false`, and any `null`/`NaN`/`0n` value all hit this. Verified against the implementation; not covered by the test suite. Use `get` plus your own `=== undefined` check for such registries. |
| **`register` on a falsy existing value** | Correct — the duplicate guard uses `.has()`, so `register("k", 0)` followed by `register("k", 1)` throws `Already registered: k` as intended. |
| **`register` on a duplicate** | Throws `Already registered: ${name}`; the existing value is preserved. Explicitly tested. |
| **`upsert` on a new name** | Behaves exactly like `register` on a new name — creates the entry. Explicitly tested. |
| **`upsert` on an existing name** | Overwrites and never throws. The key keeps its original position in `list()`. |
| **`unregister` on a missing name** | Returns `false`. No throw. Explicitly tested. |
| **`get` on a missing name** | Returns `undefined`. Explicitly tested. Indistinguishable from an entry explicitly registered with the value `undefined` — use `has` to tell them apart. |
| **`Registry<T \| undefined>`** | Legal but ambiguous: `get` returns `undefined` for both "absent" and "present but `undefined`", and `require` throws for the latter. `has` is the only reliable presence test. |
| **`list()` when empty** | Returns `[]`, not `undefined`. Explicitly tested. |
| **`list()` mutation** | The returned array is a fresh copy built by `Array.from`. Pushing to or sorting it has no effect on the registry. |
| **`list()` ordering** | Insertion order. `upsert` on an existing key does not move it; `unregister` then `register` moves the key to the end. |
| **Empty-string name** | `""` is a valid key — `register("", v)` works and `list()` includes `""`. Nothing rejects it. |
| **`__proto__` / `constructor` / `toString` as names** | Safe. Backed by a `Map`, so these are ordinary keys with no prototype interaction: `has("toString")` is `false` until you register it, and `register("__proto__", v)` creates a real entry. This is the concrete reason for `Map` over `Record<string, V>`. |
| **Key coercion** | The signature is `string`, so nothing is coerced at runtime. Callers with numeric IDs must call `String(id)` consistently on both write and read. |
| **Value identity** | Values are stored by reference and never cloned or frozen. Mutating a registered object is visible through every later `get`. |
| **Thrown error type** | Both failures throw plain `Error`, not a custom subclass, so they cannot be distinguished from other errors except by matching the message text. |
| **Concurrency** | Entirely synchronous with no locking. A race is only possible if you `await` between a `has` check and a `register`; the `register` call itself is atomic. |
| **Access to internals** | `private readonly entries` is erased at runtime. `(reg as any).entries` returns the live `Map` and can bypass every guard in the class. |
