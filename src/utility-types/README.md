# Utility Types

Two type-level helpers, `Templated<T>` and `TemplatedRecord<T>`, that derive the *authored* shape of a value from its *resolved* shape: every node — leaf, nested object, array, or the root itself — may additionally be a `string` holding a `{{ ... }}` template. They exist for config that is written with placeholders and passed through `evaluateTemplate` before use. Type-only exports; nothing is emitted at runtime.

## Why

You already have the type you care about — the config after resolution:

```ts
type RequestConfig = {
  url: string;
  method: "GET" | "POST";
  timeoutMs: number;
  retry: { attempts: number; backoffMs: number };
};
```

Then somebody authors one with placeholders and it does not compile:

```ts
const config: RequestConfig = {
  url: "{{ env.API_URL }}/users/{{ user.id }}",
  method: "GET",
  timeoutMs: "{{ env.TIMEOUT_MS }}", // string is not assignable to number
  retry: "{{ defaults.retry }}",     // string is not assignable to an object
};
```

The three things people do next are all worse than a mapped type:

**Widen to `Record<string, unknown>` (or `any`) for the authored form.** Every key name, every nesting level, and every misspelling goes unchecked, and autocomplete stops working precisely where a human is hand-writing the file.

**Duplicate the type by hand.**

```ts
type RawRequestConfig = {
  url: string;
  method: "GET" | "POST" | string;
  timeoutMs: number | string;
  retry: { attempts: number | string; backoffMs: number | string } | string;
};
```

The same shape written twice, drifting the moment a field is added, and the mechanical widening is easy to get subtly wrong — the `| string` on `retry` itself is the part people forget, and it is the part that matters most.

**Type the authored form as all-strings (`Record<string, string>`).** Wrong in both directions: a template doc is not mandatory, so most fields are real numbers, booleans, and nested objects already; and `evaluateTemplate` does not return strings — a whole-string doc like `"{{ defaults.retry }}"` returns the value itself, object identity included.

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

### 1. The conditional is distributive

`T` appears naked on the left of `extends`, so the conditional distributes over unions. `Templated<{ a: number } | number>` expands to `{ a: number | string } | number | string`: each member is classified independently instead of the whole union being tested at once (which would fail the `extends` check and leave everything untouched).

Distribution also explains the three degenerate inputs. `Templated<never>` is `string` — distributing over `never` yields `never`, and `never | string` is `string`. `Templated<unknown>` is `unknown` and `Templated<any>` is `any`, because both absorb the `| string`.

### 2. The mapped type is homomorphic

`{ [K in keyof T]: ... }` maps over `keyof T` where `T` is a bare type parameter, which is what makes it *homomorphic*: TypeScript keeps the structure of `T` rather than producing a plain object type. Concretely, all of this is preserved (verified against `tsc`):

- **Arrays stay arrays.** `Templated<number[]>` is `(number | string)[] | string`, not an object with numeric keys, and array methods are not mapped over.
- **Tuples stay tuples,** element-wise: `Templated<[number, boolean]>` is `[number | string, boolean | string] | string`. Optional slots survive: `[number, boolean?]` keeps the `?`.
- **`readonly` is preserved,** both on arrays (`readonly number[]`) and on properties.
- **Optional properties stay optional.** `Templated<{ a?: number }>` is `{ a?: number | string } | string` — it does not become required, and it does not gain `undefined` under `exactOptionalPropertyTypes`.
- **Symbol keys survive.**

### 3. `| string` sits at every level, including the root

This is the non-obvious one, and it exists because of what `evaluateTemplate` actually does. A document that is a single whole-string template returns the raw evaluated value — an object, an array, a `Date`, a function — with identity intact. So a template string is a legal stand-in not only for a `number` leaf but for an entire subtree, and for the whole config:

```ts
const a: Templated<RequestConfig> = { retry: "{{ defaults.retry }}", /* ... */ };
const b: Templated<RequestConfig> = "{{ presets.production }}";
```

A version that only widened leaves would reject both.

### 4. `ArrayOrObject` is the recurse-or-stop gate

`Record<string, unknown>` matches object type literals — TypeScript grants those an implicit index signature — and `readonly unknown[]` matches arrays and tuples (being `readonly`, it also matches mutable ones). It deliberately does *not* match `Date`, `Map`, `Set`, class instances, or functions, so those are treated as leaves and come out as `T | string`. That is the right call: mapping over `keyof Date` would produce a nonsense type built from its method names.

### The interface trap

**Interfaces do not match `Record<string, unknown>`.** TypeScript grants implicit index signatures to type *aliases* of object literals but not to interfaces, because an interface is open to declaration merging and its key set is therefore never final. The consequence is silent and easy to miss:

```ts
interface Config { timeoutMs: number }

type T = Templated<Config>; // => Config | string, and nothing more

const ok: T = "{{ whole }}";        // the root may still be a template
const bad: T = { timeoutMs: "{{ t }}" }; // error: string is not assignable to number
```

The type still compiles and still looks recursive; it just quietly stops at the first interface. If a config type is declared as an `interface`, convert it to a `type` alias. The same rule makes `TemplatedRecord<SomeInterface>` a hard constraint error, which at least fails loudly.

### Other invariants

- **It only widens.** A fully resolved value is always assignable to its templated type, so hard-coded defaults can be passed anywhere a templated config is expected. The reverse is not true — a `Templated<T>` is not a `T` — which is exactly the intent: resolution has to happen before the resolved type may be claimed.
- **It validates nothing.** The union is with plain `string`, not with a template-literal type, so `Templated<{ mode: "GET" | "POST" }>` accepts `{ mode: "nonsense" }`; the literal union is erased. The stricter alternative, `` `${string}{{${string}}}${string}` ``, would reject any string computed at runtime (a plain `string` is not assignable to a template-literal type) and would also reject leaves whose resolved type is already `string`. The type trades precision for usability on purpose — read it as "may be authored as a template", not as a checker.
- **Recursive types are fine.** `type Tree = { value: number; children: Tree[] }` expands lazily; `Templated<Tree>` does not hit the instantiation-depth limit.
- **Roughly idempotent.** `Templated<Templated<{ a: number }>>` is identical to `Templated<{ a: number }>`.

### `TemplatedRecord` vs `Templated`

`TemplatedRecord<T>` is the same mapped type with the root `| string` removed. The relationship is exact, and holds as a type equality:

```ts
Templated<X> === TemplatedRecord<X> | string   // for any X extends Record<string, unknown>
```

Reach for `TemplatedRecord` when the root must remain an object: a config file's top level, or a function parameter you intend to iterate with `Object.entries` — accepting a bare string there would force every consumer to handle "the entire config is one template" before it can touch a single key. The `T extends Record<string, unknown>` constraint rejects arrays and interfaces at the call site.

## API

Both exports are types. `ArrayOrObject` is internal and not exported.

### `Templated<T>`

```ts
type Templated<T> =
  | (T extends ArrayOrObject ? { [K in keyof T]: Templated<T[K]> } : T)
  | string;
```

The authored form of `T`. Recurses through object type literals, arrays, and tuples; leaves every other type intact. Adds `string` at each level, root included. No constraint on `T` — any type is accepted, including `never`, `unknown`, and `any`.

### `TemplatedRecord<T>`

```ts
type TemplatedRecord<T extends Record<string, unknown>> = {
  [K in keyof T]: Templated<T[K]>;
};
```

The authored form of an object type whose root must stay an object. Each property becomes `Templated<T[K]>`; property modifiers (`?`, `readonly`) are preserved. `T` is constrained to `Record<string, unknown>`, which admits object type aliases but rejects arrays, primitives, and interfaces.

## Usage

### Typing an authored config

```ts
import type { Templated } from "@isel-jao/ts-lib";

type RequestConfig = {
  url: string;
  method: "GET" | "POST";
  timeoutMs: number;
  retry: { attempts: number; backoffMs: number };
  headers: Record<string, string>;
  tags: string[];
};

const authored: Templated<RequestConfig> = {
  url: "{{ env.API_URL }}/users/{{ user.id }}", // template inside a larger string
  method: "GET",                                // plain values still allowed
  timeoutMs: "{{ env.TIMEOUT_MS }}",             // string standing in for a number
  retry: "{{ defaults.retry }}",                 // string standing in for a subtree
  headers: { authorization: "Bearer {{ token }}" },
  tags: ["users", "{{ env.STAGE }}"],            // per-element templates
};

// a fully resolved config is still a valid authored config
const resolved: RequestConfig = {
  url: "https://api.example.com/users/1",
  method: "GET",
  timeoutMs: 5000,
  retry: { attempts: 3, backoffMs: 200 },
  headers: {},
  tags: [],
};
const alsoAuthored: Templated<RequestConfig> = resolved;
```

### Resolving `Templated<T>` back to `T`

The types describe the shape; walking it is ordinary code. `evaluateTemplate` handles one string at a time, so recurse and evaluate each string node:

```ts
import { evaluateTemplate } from "@isel-jao/ts-lib";
import type { Templated } from "@isel-jao/ts-lib";

function walk(node: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof node === "string") return evaluateTemplate(node, ctx);
  if (Array.isArray(node)) return node.map((item) => walk(item, ctx));
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, ctx)]));
  }
  return node;
}

// the cast is the whole contract: nothing checks that every template produced
// a value of the right type, so keep it in one place and validate after.
export function resolveConfig<T>(config: Templated<T>, ctx: Record<string, unknown>): T {
  return walk(config, ctx) as T;
}

const config = resolveConfig<RequestConfig>(authored, {
  env: { API_URL: "https://api.example.com", TIMEOUT_MS: 5000, STAGE: "prod" },
  user: { id: 1 },
  defaults: { retry: { attempts: 3, backoffMs: 200 } },
  token: "abc",
});
// => { url: "https://api.example.com/users/1", method: "GET", timeoutMs: 5000,
//      retry: { attempts: 3, backoffMs: 200 }, headers: { authorization: "Bearer abc" },
//      tags: ["users", "prod"] }
```

Two behaviors of that walker are worth knowing before shipping it: `retry` comes back as the *same object reference* held in `ctx.defaults.retry` (a whole-string template returns the value, not a copy), and every string node goes through `evaluateTemplate`, which also parses bare literals — so a template-free leaf `"true"` resolves to the boolean `true` and `"42"` to the number `42`.

### Keeping the root an object

```ts
import type { TemplatedRecord } from "@isel-jao/ts-lib";

// callers may template any field, but not replace the whole config with a string
export function defineConfig<T extends Record<string, unknown>>(
  config: TemplatedRecord<T>
): TemplatedRecord<T> {
  return config;
}

const declared = defineConfig<RequestConfig>({
  url: "{{ env.API_URL }}",
  method: "POST",
  timeoutMs: "{{ env.TIMEOUT_MS }}",
  retry: { attempts: "{{ env.ATTEMPTS }}", backoffMs: 200 },
  headers: "{{ defaults.headers }}",
  tags: [],
});
```

## Edge cases

| Input | Result |
| --- | --- |
| `Templated<never>` | `string` (the conditional distributes to `never`, leaving the `\| string` arm). |
| `Templated<unknown>` | `unknown` — the `\| string` is absorbed, so nothing is added. |
| `Templated<any>` | `any`. |
| `Templated<Iface>` where `Iface` is an `interface` | `Iface \| string`. Members are **not** templatable — interfaces get no implicit index signature. Use a `type` alias. |
| `TemplatedRecord<Iface>` | Compile error: the interface does not satisfy `Record<string, unknown>`. |
| `TemplatedRecord<number[]>` | Compile error: arrays do not satisfy the constraint. Use `Templated` for arrays. |
| `Templated<Date>` / `Map` / `Set` / class instances | `T \| string` — treated as a leaf, never mapped over. |
| `Templated<() => void>` | `(() => void) \| string`. A function-valued property inside an object is still a leaf, but the object around it is recursed into. |
| `Templated<[number, boolean?]>` | `[number \| string, (boolean \| string)?] \| string` — tuple length and optional slots preserved. |
| `Templated<readonly number[]>` | `readonly (number \| string)[] \| string`. |
| `Templated<{ a?: number; readonly b: string }>` | `{ a?: number \| string; readonly b: string } \| string` — modifiers preserved. |
| `Templated<{ mode: "GET" \| "POST" }>` | `{ mode: string } \| string`. The literal union is erased by the `\| string`; no template syntax is validated. |
| `Templated<string>` | `string` — a resolved `string` leaf and a template are indistinguishable by type. |
| `Templated<T>` where `T` is a union | Distributes member-wise: `Templated<{ a: number } \| number>` is `{ a: number \| string } \| number \| string`. |
| Recursive `T` (`type Tree = { value: number; children: Tree[] }`) | Expands lazily; no depth error. |
