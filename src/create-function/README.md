# createSyncFunction / createAsyncFunction

Compiles a JavaScript source string into a callable function, with a named-value context injected as parameters. `createSyncFunction` returns a plain function; `createAsyncFunction` returns one that supports `await` in the body and always resolves to a promise.

This is `new Function` — the `eval` family — with ergonomics on top. It executes arbitrary JavaScript with the full authority of the surrounding process. **Never pass a source string you did not author or fully validate.** See [Security](#security).

Reach for it when the code genuinely is not known until runtime: user-authored formulas in an admin UI, rules stored in a database, plugin bodies from a config file — and only where you control the authors.

## Why

The naive way to run a stored expression is `eval(expr)`. Three things go wrong immediately:

1. **`eval` sees your local scope.** It can read and clobber every variable in the enclosing function, which makes minification unsafe and turns a data bug into a control-flow bug. It also defeats every optimisation in the surrounding function.
2. **Recompilation on every call.** `eval(expr)` in a loop parses the string once per iteration. Compilation is the expensive part; the call itself is cheap.
3. **Passing data in is unsolved.** With bare `eval` your only channels are globals or string interpolation. Interpolating values into the source (`` eval(`return ${JSON.stringify(x)} + 1`) ``) means the data is re-parsed as code — a value containing the wrong characters becomes an injection, and closures, `Date`s, `Map`s and functions cannot be serialised at all.

`new Function` fixes (1) and (2): the created function closes over *only* the global scope, not your locals, and you compile once and call many times. It leaves (3), which is what these helpers add: a `context` object whose keys become real parameter names and whose values are passed by reference at call time — so you can hand the body a live `Map`, a class instance, or a callback and it arrives intact, never stringified.

`createAsyncFunction` additionally solves a problem `new Function` does not: `new Function` produces a *sync* function, so `await` in the body is a syntax error. Getting an async one requires reaching for the un-exposed `AsyncFunction` constructor via `Object.getPrototypeOf(async () => {}).constructor`, which is exactly what the helper does for you.

## How it works

Both functions do the same two things: compile once at creation time, then wrap the compiled function in a closure that supplies the context values on every call.

### Compilation

```ts
const syncFunction = new Function(...Object.keys(context), "...args", doc);
```

`new Function(...paramNames, body)` treats the final argument as the function body and all preceding ones as parameter-list source. So `createSyncFunction("return a + args[0];", { a: 10 })` compiles, literally:

```ts
function anonymous(a, ...args) {
  return a + args[0];
}
```

Two consequences follow from the parameters being *source text*, not identifiers:

- Every key of `context` must be a valid, non-reserved JS identifier. `{ "my-key": 1 }` throws `SyntaxError: Arg string terminates parameters early` — at creation time, from the factory call, not later.
- The rest parameter `"...args"` is passed as its own parameter string, so `args` is a reserved name in the context. A context key literally named `args` throws `SyntaxError: Duplicate parameter name not allowed in this context`.

For the async variant, the constructor is fetched off the prototype chain of an async arrow, since `AsyncFunction` is not a global:

```ts
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const asyncFunction = new AsyncFunction(...Object.keys(context), "...args", doc);
```

The compiled function is `async`, so `await` works in the body and the return value is always a promise.

### Invocation

```ts
return (...args: unknown[]): unknown => {
  return syncFunction(...Object.values(context), ...args);
};
```

Context values are spread first, positionally aligned with the `Object.keys(context)` used as parameter names, then the caller's arguments land in `args`. The alignment is safe because `Object.keys` and `Object.values` walk the same object in the same order — and since every usable key must be a valid identifier, no key can be integer-like, so no key gets hoisted to the front by JS property ordering rules.

`context` is read fresh from the closed-over object on every call, so mutating a context *value* between calls is visible to the body. Adding a *key* after creation is not — the parameter list was baked in at compile time.

**Compile once, call many.** Both factories do all `new Function` work eagerly, before returning. A syntax error in `doc` throws synchronously out of `createSyncFunction` / `createAsyncFunction` — it does not surface as a rejected promise from the async variant, and it does not wait for the first call. Fail fast at registration time.

### Scope and semantics of the body

- **No closure capture.** Functions built this way close over the global scope only. A body referencing a local variable from the calling module throws `ReferenceError: outer is not defined` at call time. `context` is the only channel in.
- **Full global access.** The body can reach anything on `globalThis`: `fetch`, `process`, `console`, timers, and in Node whatever else is global. There is no sandbox.
- **Sloppy mode.** The body is non-strict unless it starts with `"use strict";`. That means an undeclared assignment (`leaked = 1`) silently creates a global, and `this` inside a plain nested function is `globalThis`. Prepend `"use strict";` to `doc` if you want a body that fails loudly instead.
- **`this`** in the outer body is `globalThis` (the wrapper calls the compiled function unbound).
- **Return type is `unknown`.** Neither factory is generic. Cast or validate at the call site; the compiler cannot know what the string produces.

### Security

These functions are `eval` under a different name. Treat every `doc` string as executable code with your process's full privileges:

- **Never pass untrusted input.** A body from a user request, a webhook payload, an LLM response or a third-party config can read `process.env`, make network calls, read and write files (Node), and exfiltrate anything reachable. There is no allowlist, no timeout, no memory cap, no scope isolation. `context` restricts what is passed *in*; it restricts nothing about what the body can reach on its own.
- **Not a sandbox.** If you need isolation, use one — `node:vm` with a locked-down context (still not a security boundary against determined code), a worker with no privileges, or a real interpreter for a restricted expression language. Do not reach for a regex "validator" over the source; you will not win that fight.
- **CSP.** In browsers, `new Function` requires `script-src 'unsafe-eval'`. Under a normal CSP the call throws `EvalError: call to Function() blocked by CSP`. Shipping this into a page hardened with a strict CSP will break at runtime, not at build time.
- **Restricted runtimes.** Some environments disable code generation from strings outright: Cloudflare Workers and several other edge runtimes, Node started with `--disallow-code-generation-from-strings`, and `vm` contexts created with `codeGeneration: { strings: false }`.
- **Bundlers and minifiers.** The body is opaque to your toolchain. It is not type-checked, not linted, not minified, not tree-shaken, not covered by source maps, and identifiers it references in `context` cannot be renamed safely if you ever build the context from something a minifier can touch.

An infinite loop in `doc` hangs the thread. There is no way to interrupt it from the calling code.

## API

### `createSyncFunction`

```ts
function createSyncFunction(
  doc: string,
  context?: Record<string, unknown>
): (...args: unknown[]) => unknown;
```

- `doc` — the **function body** source, not an expression. Use an explicit `return`; a body without one evaluates to `undefined`. Inside it, `args` is the array of call arguments, and each key of `context` is in scope by name.
- `context` — values to expose to the body by name. Keys must be valid JS identifiers and must not be `args`. Defaults to `{}`. Values are passed by reference on each call, so functions, class instances and mutable objects all work.

Returns a function that runs the body and returns its value. Errors thrown by the body propagate synchronously to the caller.

Throws `SyntaxError` **at creation time** if `doc` does not parse, if a context key is not a valid identifier, or if a context key is `args`. Throws `EvalError` at creation time when blocked by CSP.

### `createAsyncFunction`

```ts
function createAsyncFunction(
  doc: string,
  context?: Record<string, unknown>
): (...args: unknown[]) => Promise<unknown>;
```

Same parameters and same compile-time errors as `createSyncFunction`. The difference is the compiled function is an `AsyncFunction`, so:

- `await` is legal in `doc`.
- The returned function always returns a `Promise`, even for a body with no `await`.
- A synchronous `throw` in the body becomes a **rejection**, not a synchronous throw. Use `.catch` / `try { await fn() }`, never a bare `try { fn() }`.

## Usage

Compile once, call many:

```ts
import { createSyncFunction } from "@isel-jao/ts-lib";

const double = createSyncFunction("return args[0] * 2;");
double(2); // 4
double(5); // 10
```

Injecting values and helpers by name:

```ts
import { createSyncFunction } from "@isel-jao/ts-lib";

const fn = createSyncFunction("return round(base * (1 + rate)) + args[0];", {
  base: 100,
  rate: 0.2,
  round: Math.round,
});

fn(5); // 125
```

Async bodies with an injected dependency — note the helper never has to be serialised, it is passed by reference:

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

A non-trivial case: a small rule registry compiled at startup, so a bad rule is caught during boot rather than on the request that happens to hit it. The source here comes from a config file the operator controls — the trust boundary is doing real work in this example:

```ts
import { createSyncFunction } from "@isel-jao/ts-lib";

type Rule = (input: unknown) => unknown;

function compileRules(sources: Record<string, string>): Map<string, Rule> {
  const compiled = new Map<string, Rule>();
  for (const [name, source] of Object.entries(sources)) {
    try {
      const fn = createSyncFunction(`"use strict";\n${source}`, {
        now: () => Date.now(),
        log: console.log,
      });
      compiled.set(name, (input) => fn(input));
    } catch (error) {
      throw new Error(`rule "${name}" failed to compile: ${(error as Error).message}`);
    }
  }
  return compiled;
}

const rules = compileRules({
  isStale: "return now() - args[0].updatedAt > 86_400_000;",
  isLarge: "return args[0].size > 1024;",
});

rules.get("isLarge")?.({ size: 2048 }); // true
```

## Edge cases

| Case | Behaviour | Source |
| --- | --- | --- |
| Body with no `return` | returns `undefined` | test |
| No `context` argument | defaults to `{}`; `args` still available | test |
| Body throws (sync) | error propagates to the caller | test |
| Body throws (async) | returned promise rejects | test |
| Awaited promise rejects (async) | returned promise rejects | test |
| Async body with no `await` | still returns a `Promise` | test |
| Function passed in `context` | callable by name from the body | test |
| Repeated calls | reuse the same compiled function; arguments are per call | test |
| Context value + call arguments together | context first by name, call arguments in `args` | test |
| Invalid `doc` syntax | `SyntaxError` thrown from the factory, before any call | code |
| Context key that is not a valid identifier | `SyntaxError` from the factory | code |
| Context key named `args` | `SyntaxError` (duplicate parameter) from the factory | code |
| Body references a local from the calling scope | `ReferenceError` at call time — no closure capture | code |
| Undeclared assignment in the body | creates a global (sloppy mode) unless `doc` starts with `"use strict";` | code |
| Browser with strict CSP | `EvalError` — `new Function` requires `unsafe-eval` | code |
| Infinite loop in the body | blocks the thread; not interruptible | code |
