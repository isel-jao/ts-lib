# createSyncFunction / createAsyncFunction

Compiles a JavaScript source string into a callable function, with a named-value context injected as parameters. `createSyncFunction` returns a plain function; `createAsyncFunction` returns one that supports `await` in the body and always resolves to a promise.

This is `new Function` — the `eval` family — with ergonomics on top. It executes arbitrary JavaScript with the full authority of the surrounding process. **Never pass a source string you did not author or fully validate.** See [Security](#security).

Reach for it when the code genuinely is not known until runtime: user-authored formulas in an admin UI, rules stored in a database, plugin bodies from a config file — and only where you control the authors.

## Why

The naive way to run a stored expression is `eval(expr)`, and three things go wrong immediately. `eval` sees your local scope, so it can read and clobber every variable in the enclosing function, which makes minification unsafe. It recompiles on every call, and compilation is the expensive part. And passing data in is unsolved: your only channels are globals or string interpolation, and interpolating means the data is re-parsed as code — a value containing the wrong characters becomes an injection, while closures, `Date`s, `Map`s and functions cannot be serialized at all.

`new Function` fixes the first two: the created function closes over *only* the global scope, and you compile once and call many times. It leaves the third, which is what these helpers add — a `context` object whose keys become real parameter names and whose values are passed by reference at call time, so a live `Map`, a class instance, or a callback arrives intact.

`createAsyncFunction` solves one more thing `new Function` cannot: it produces a *sync* function, so `await` in the body is a syntax error. Getting an async one means reaching for the un-exposed `AsyncFunction` constructor via `Object.getPrototypeOf(async () => {}).constructor`, which the helper does for you.

## How it works

Both factories compile once at creation time, then wrap the result in a closure that supplies the context on every call.

```ts
const syncFunction = new Function(...Object.keys(context), "...args", doc);
```

`new Function(...paramNames, body)` treats the final argument as the body and the rest as parameter-list *source text*. So `createSyncFunction("return a + args[0];", { a: 10 })` compiles literally to `function anonymous(a, ...args) { return a + args[0]; }`.

Two consequences follow from those parameters being source text rather than identifiers:

- Every key of `context` must be a valid, non-reserved JS identifier. `{ "my-key": 1 }` throws `SyntaxError: Arg string terminates parameters early` — at creation time, from the factory call.
- `"...args"` is passed as its own parameter string, so `args` is reserved. A context key named `args` throws `SyntaxError: Duplicate parameter name`.

At invocation, context values are spread first, positionally aligned with the `Object.keys(context)` used as parameter names, then the caller's arguments land in `args`. The alignment is safe because `Object.keys` and `Object.values` walk the same object in the same order — and since every usable key must be a valid identifier, no key can be integer-like and get hoisted to the front by JS property-ordering rules.

`context` is read fresh on every call, so mutating a context *value* between calls is visible to the body. Adding a *key* after creation is not — the parameter list was baked in at compile time.

**Compile once, fail fast.** All `new Function` work happens eagerly, before the factory returns. A syntax error in `doc` throws synchronously out of the factory — it does not surface as a rejected promise from the async variant, and it does not wait for the first call.

### Scope and semantics of the body

- **No closure capture.** The body closes over the global scope only. Referencing a local from the calling module throws `ReferenceError` at call time. `context` is the only channel in.
- **Full global access.** The body reaches anything on `globalThis` — `fetch`, `process`, `console`, timers. There is no sandbox.
- **Sloppy mode.** The body is non-strict unless it starts with `"use strict";`, so an undeclared assignment silently creates a global. Prepend it if you want a body that fails loudly.
- **Return type is `unknown`.** Neither factory is generic; cast or validate at the call site.

### Security

These functions are `eval` under a different name. Treat every `doc` string as executable code with your process's full privileges.

- **Never pass untrusted input.** A body from a user request, a webhook payload, an LLM response, or a third-party config can read `process.env`, make network calls, read and write files, and exfiltrate anything reachable. There is no allowlist, no timeout, no memory cap, no scope isolation. `context` restricts what is passed *in*; it restricts nothing about what the body reaches on its own.
- **Not a sandbox.** If you need isolation, use one — `node:vm` with a locked-down context (still not a security boundary against determined code), an unprivileged worker, or a real interpreter for a restricted expression language. Do not reach for a regex "validator" over the source; you will not win that fight.
- **CSP.** In browsers `new Function` requires `script-src 'unsafe-eval'`. Under a normal CSP the call throws `EvalError: call to Function() blocked by CSP` — at runtime, not build time.
- **Restricted runtimes.** Cloudflare Workers and several other edge runtimes disable code generation from strings outright, as does Node under `--disallow-code-generation-from-strings`.
- **Opaque to your toolchain.** The body is not type-checked, linted, minified, tree-shaken, or covered by source maps.
- An infinite loop in `doc` hangs the thread, with no way to interrupt it from the calling code.

## API

### `createSyncFunction`

```ts
function createSyncFunction(
  doc: string,
  context?: Record<string, unknown>
): (...args: unknown[]) => unknown;
```

- `doc` — the **function body** source, not an expression. Use an explicit `return`; a body without one evaluates to `undefined`. Inside it, `args` is the array of call arguments and each key of `context` is in scope by name.
- `context` — values exposed to the body by name. Keys must be valid JS identifiers and must not be `args`. Defaults to `{}`. Passed by reference on each call, so functions, class instances, and mutable objects all work.

Errors thrown by the body propagate synchronously. Throws `SyntaxError` **at creation time** if `doc` does not parse, if a context key is not a valid identifier, or if a key is `args`; throws `EvalError` at creation time when blocked by CSP.

### `createAsyncFunction`

```ts
function createAsyncFunction(
  doc: string,
  context?: Record<string, unknown>
): (...args: unknown[]) => Promise<unknown>;
```

Same parameters and same compile-time errors. The compiled function is an `AsyncFunction`, so `await` is legal in `doc`, the returned function always returns a `Promise` even without an `await`, and a synchronous `throw` in the body becomes a **rejection** — use `try { await fn() }`, never a bare `try { fn() }`.

## Usage

```ts
import { createSyncFunction } from "@isel-jao/ts-lib";

const double = createSyncFunction("return args[0] * 2;");
double(2); // 4 — compiled once, called many times
```

Injecting values and helpers by name:

```ts
const fn = createSyncFunction("return round(base * (1 + rate)) + args[0];", {
  base: 100,
  rate: 0.2,
  round: Math.round,
});

fn(5); // 125
```

An async body with an injected dependency — the helper is passed by reference and never serialized:

```ts
import { createAsyncFunction } from "@isel-jao/ts-lib";

const rule = createAsyncFunction(
  `
  const user = await getUser(args[0]);
  return user.plan === "pro" && user.seats > minSeats;
  `,
  { getUser, minSeats: 5 }
);

const allowed = (await rule("u_123")) as boolean;
```

Because compilation is eager, compiling a set of stored rules at startup catches a bad one during boot rather than on whichever request happens to hit it. Prepending `"use strict";` to each body is worth the two seconds it costs.

## Edge cases

| Case | Behavior |
| --- | --- |
| Body with no `return` | returns `undefined` |
| No `context` argument | defaults to `{}`; `args` still available |
| Body throws, sync / async | propagates to the caller / rejects the promise |
| Async body with no `await` | still returns a `Promise` |
| Repeated calls | reuse the same compiled function; arguments are per call |
| Invalid `doc` syntax | `SyntaxError` from the factory, before any call |
| Context key that is not a valid identifier | `SyntaxError` from the factory |
| Context key named `args` | `SyntaxError` (duplicate parameter) from the factory |
| Body references a local from the calling scope | `ReferenceError` at call time — no closure capture |
| Undeclared assignment in the body | creates a global unless `doc` starts with `"use strict";` |
| Browser with strict CSP | `EvalError` — requires `unsafe-eval` |
| Infinite loop in the body | blocks the thread; not interruptible |
