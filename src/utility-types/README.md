# Utility Types

Two type-level helpers, `Templated<T>` and `TemplatedRecord<T>`, that derive the *authored* shape of a value from its *resolved* shape: every node — leaf, nested object, array, or the root itself — may additionally be a `string` holding a `{{ ... }}` template. They exist for config written with placeholders and passed through `evaluateTemplate` before use. Type-only exports; nothing is emitted at runtime.

## Why

You already have the type you care about — the config after resolution. Then somebody authors one with placeholders and it does not compile:

```ts
type RequestConfig = {
  url: string;
  timeoutMs: number;
  retry: { attempts: number; backoffMs: number };
};

const config: RequestConfig = {
  url: "{{ env.API_URL }}/users/{{ user.id }}",
  timeoutMs: "{{ env.TIMEOUT_MS }}", // string is not assignable to number
  retry: "{{ defaults.retry }}",     // string is not assignable to an object
};
```

Widening the authored form to `Record<string, unknown>` throws away every key name and kills autocomplete exactly where a human is hand-writing the file. Hand-duplicating the type as `{ timeoutMs: number | string; retry: {...} | string }` means the same shape written twice, drifting the moment a field is added — and the `| string` on `retry` itself is the part people forget, which is the part that matters most.

So the requirement is a mechanical, one-directional derivation from the resolved type: recursive, modifier-preserving, and permitting a string at every node including the root. That is a type-level transform, not something a helper function can express.

## How it works

The entire module:

```ts
type ArrayOrObject = readonly unknown[] | Record<string, unknown>;

export type Templated<T> =
  | (T extends ArrayOrObject ? { [K in keyof T]: Templated<T[K]> } : T)
  | string;

export type TemplatedRecord<T extends Record<string, unknown>> = {
  [K in keyof T]: Templated<T[K]>;
};
```

Four mechanisms are stacked in those five lines.

**1. The conditional is distributive.** `T` is naked on the left of `extends`, so it distributes over unions: `Templated<{ a: number } | number>` becomes `{ a: number | string } | number | string`, classifying each member independently rather than testing the union as a whole. Distribution also explains the degenerate inputs — `Templated<never>` is `string`, while `unknown` and `any` absorb the `| string` and come back unchanged.

**2. The mapped type is homomorphic.** `{ [K in keyof T]: ... }` over a bare type parameter makes TypeScript preserve the structure of `T` rather than flattening it to a plain object. Arrays stay arrays, tuples stay tuples element-wise, and `readonly`, `?`, and symbol keys all survive.

**3. `| string` sits at every level, including the root.** This is the non-obvious one. `evaluateTemplate` returns the raw evaluated value for a whole-string document — object identity included — so a template string legitimately stands in for an entire subtree, not just a leaf:

```ts
const a: Templated<RequestConfig> = { retry: "{{ defaults.retry }}", /* ... */ };
const b: Templated<RequestConfig> = "{{ presets.production }}";
```

**4. `ArrayOrObject` is the recurse-or-stop gate.** `Record<string, unknown>` matches object type literals (TypeScript grants them an implicit index signature) and `readonly unknown[]` matches arrays and tuples. It deliberately does *not* match `Date`, `Map`, `Set`, class instances, or functions, so those stay leaves — mapping over `keyof Date` would build a nonsense type from its method names.

### The interface trap

**Interfaces do not match `Record<string, unknown>`.** TypeScript grants implicit index signatures to type *aliases* but not to interfaces, since an interface is open to declaration merging and its key set is never final. The failure is silent:

```ts
interface Config { timeoutMs: number }

type T = Templated<Config>; // => Config | string, and nothing more

const ok: T = "{{ whole }}";             // the root may still be a template
const bad: T = { timeoutMs: "{{ t }}" }; // error: string is not assignable to number
```

The type still compiles and still looks recursive; it just quietly stops at the first interface. Convert the config type to a `type` alias. `TemplatedRecord<SomeInterface>` at least fails loudly, as a constraint error.

### Two more invariants

- **It only widens.** A fully resolved value is always assignable to its templated type, so hard-coded defaults pass anywhere a templated config is expected. The reverse does not hold — resolution has to happen before the resolved type may be claimed.
- **It validates nothing.** The union is with plain `string`, not a template-literal type, so `Templated<{ mode: "GET" | "POST" }>` accepts `{ mode: "nonsense" }`. The stricter `` `${string}{{${string}}}${string}` `` would reject any runtime-computed string and any leaf already typed `string`. Read it as "may be authored as a template", not as a checker.

### `TemplatedRecord` vs `Templated`

`TemplatedRecord<T>` is the same mapped type with the root `| string` removed, an exact relationship:

```ts
Templated<X> === TemplatedRecord<X> | string   // for any X extends Record<string, unknown>
```

Reach for it when the root must stay an object — a config file's top level, or a parameter you intend to iterate with `Object.entries`. Accepting a bare string there would force every consumer to handle "the entire config is one template" before touching a single key.

## API

Both exports are types. `ArrayOrObject` is internal and not exported.

### `Templated<T>`

```ts
type Templated<T> =
  | (T extends ArrayOrObject ? { [K in keyof T]: Templated<T[K]> } : T)
  | string;
```

The authored form of `T`. Recurses through object type literals, arrays, and tuples; leaves every other type intact. Adds `string` at each level, root included. No constraint on `T`.

### `TemplatedRecord<T>`

```ts
type TemplatedRecord<T extends Record<string, unknown>> = {
  [K in keyof T]: Templated<T[K]>;
};
```

The authored form of an object type whose root must stay an object. Property modifiers (`?`, `readonly`) are preserved. The constraint admits object type aliases but rejects arrays, primitives, and interfaces.

## Usage

```ts
import type { Templated } from "@isel-jao/ts-lib";

type RequestConfig = {
  url: string;
  timeoutMs: number;
  retry: { attempts: number; backoffMs: number };
  tags: string[];
};

const authored: Templated<RequestConfig> = {
  url: "{{ env.API_URL }}/users/{{ user.id }}", // template inside a larger string
  timeoutMs: "{{ env.TIMEOUT_MS }}",            // string standing in for a number
  retry: "{{ defaults.retry }}",                // string standing in for a subtree
  tags: ["users", "{{ env.STAGE }}"],           // per-element templates
};
```

Resolving it back is ordinary code — `evaluateTemplate` handles one string at a time, so recurse and evaluate each string node:

```ts
import { evaluateTemplate } from "@isel-jao/ts-lib";
import type { Templated } from "@isel-jao/ts-lib";

function walk(node: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof node === "string") return evaluateTemplate(node, ctx);
  if (Array.isArray(node)) return node.map((item) => walk(item, ctx));
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, ctx)]));
  }
  return node;
}

// the cast is the whole contract: nothing checks that every template produced
// a value of the right type, so keep it in one place and validate after.
export function resolveConfig<T>(config: Templated<T>, ctx: Record<string, unknown>): T {
  return walk(config, ctx) as T;
}
```

Two behaviors of that walker matter before shipping it: `retry` comes back as the *same object reference* held in `ctx.defaults.retry`, and every string node goes through `evaluateTemplate`, which also parses bare literals — so a template-free `"true"` resolves to the boolean `true` and `"42"` to the number `42`.

## Edge cases

| Input | Result |
| --- | --- |
| `Templated<never>` | `string` — the conditional distributes to `never`, leaving the `\| string` arm. |
| `Templated<unknown>` / `Templated<any>` | `unknown` / `any` — the `\| string` is absorbed. |
| `Templated<Iface>` where `Iface` is an `interface` | `Iface \| string`. Members are **not** templatable. Use a `type` alias. |
| `TemplatedRecord<Iface>` | Compile error — no implicit index signature. |
| `TemplatedRecord<number[]>` | Compile error. Use `Templated` for arrays. |
| `Templated<Date>` / `Map` / `Set` / class instances | `T \| string` — treated as a leaf, never mapped over. |
| `Templated<[number, boolean?]>` | `[number \| string, (boolean \| string)?] \| string` — length and optional slots preserved. |
| `Templated<readonly number[]>` | `readonly (number \| string)[] \| string`. |
| `Templated<{ a?: number; readonly b: string }>` | Modifiers preserved. |
| `Templated<{ mode: "GET" \| "POST" }>` | `{ mode: string } \| string` — the literal union is erased. |
| `Templated<string>` | `string` — a resolved string leaf and a template are indistinguishable. |
| Recursive `T` (`type Tree = { value: number; children: Tree[] }`) | Expands lazily; no depth error. |
