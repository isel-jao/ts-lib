# createSyncFunction / createAsyncFunction

Compiles a JavaScript source string into a callable function, with a named-value context injected as parameters and a caller-declared parameter list. `createSyncFunction` returns a plain function; `createAsyncFunction` returns one that supports `await` in the body and always resolves to a promise.

This is `new Function` — the `eval` family — with ergonomics on top. It executes arbitrary JavaScript with the full authority of the surrounding process. **Never pass a source string you did not author or fully validate.** See [Security](#security).

Reach for it when the code genuinely is not known until runtime: user-authored formulas in an admin UI, rules stored in a database, plugin bodies from a config file — and only where you control the authors.

## Why

Convenience, not safety.

`eval(expr)` recompiles on every call, sees your local scope — so a body can quietly depend on a variable that a rename or a minifier will move out from under it — and gives you no good way to hand it a value. Your only channels are globals or string interpolation, and interpolation means writing data out as source text: fiddly to quote correctly, and impossible for a closure, a `Date`, a `Map`, or a callback, which have no source form at all.

`new Function` fixes the first two — compile once, global scope only. These helpers fix the third: `context` keys become real parameter names and their values are passed by reference, so a live reference arrives intact. `params` are the names the caller's arguments bind to, so the body reads like ordinary code — `return price * quantity;` — instead of indexing a positional array. And `createAsyncFunction` reaches for the un-exposed `AsyncFunction` constructor on your behalf, since a plain `new Function` body cannot use `await`.

## How it works

Both factories compile once at creation time, then wrap the result in a closure that supplies the context on every call.

```ts
const syncFunction = new Function(...Object.keys(context), params.join(","), doc);
```

`new Function(...paramNames, body)` treats the final argument as the body and the rest as parameter-list *source text*, joined with commas. So `createSyncFunction({ doc: "return a + x;", context: { a: 10 }, params: ["x"] })` compiles literally to `function anonymous(a, x) { return a + x; }`.

Two consequences follow from those parameters being source text rather than identifiers:

- Every key of `context`, and every entry of `params`, must parse as a parameter. `{ "my-key": 1 }` throws `SyntaxError: Arg string terminates parameters early` — at creation time, from the factory call. Which names qualify is subtler than "valid identifier", and checking them is on you: see [Validating names is the caller's responsibility](#validating-names-is-the-callers-responsibility).
- Conversely, a `params` entry is free to be any legal *parameter* syntax, not just a bare name: `"...rest"`, `"a = 7"`, and `"{ x }"` all compile and behave as they would in a hand-written function.

An empty `params` array joins to `""`, which lands as a trailing comma in the parameter list (`function anonymous(a,\n)`). Trailing commas in parameter lists are legal, so this is a no-op.

At invocation, context values are spread first, positionally aligned with the `Object.keys(context)` used as parameter names, then the caller's arguments fill `params` in order. The alignment is safe because `Object.keys` and `Object.values` walk the same object in the same order — and since every usable key must be a valid identifier, no key can be integer-like and get hoisted to the front by JS property-ordering rules.

`context` is read fresh on every call, so mutating a context *value* between calls is visible to the body. Adding a *key* after creation is not — the parameter list was baked in at compile time.

**Compile once, fail fast.** All `new Function` work happens eagerly, before the factory returns. A syntax error in `doc` throws synchronously out of the factory — it does not surface as a rejected promise from the async variant, and it does not wait for the first call.

### `params` shadow `context`

Both lists become one flat parameter list — context keys first, then `params` — so a `params` entry that matches a `context` key produces a duplicate parameter. JavaScript's sloppy-mode rules apply: the **later** binding wins. `params` come later, so **a param always shadows the context value of the same name**, silently, with no error.

```ts
const fn = createSyncFunction({ doc: "return a;", context: { a: 1 }, params: ["a"] });
fn(2); // 2 — the param shadowed the context value
fn(); // undefined — the param still shadows it, now with no argument to bind
```

Note the second line: the shadow is structural, not conditional on the caller passing anything. Once a name is in `params`, the context value under that name is unreachable from the body.

Starting the body with `"use strict";` turns the collision into a `SyntaxError: Duplicate parameter name not allowed in this context` at creation time, which is usually what you want. A non-simple `params` entry — a default, rest, or destructuring form — makes duplicates an error regardless of strictness.

### Validating names is the caller's responsibility

Neither factory inspects `context` keys or `params` entries. Both are spliced into the parameter list as **verbatim source text**, and the only thing that ever rejects them is the JS parser inside `new Function`. There is no allowlist, no identifier check, no de-duplication, and no collision check between the two lists.

What that leaves to you:

- **Valid parameter source.** Every context key and every `params` entry must parse as a parameter. `"my-param"`, `"2x"`, and `"class"` throw from the factory, each with a different `SyntaxError` message depending on where the parser gives up. An empty string is the one benign case: as the only entry it vanishes into the trailing comma, but `["", "b"]` joins to `",b"` and throws.
- **Reserved words, with a catch.** Always-reserved words (`"class"`, `"return"`, `"function"`) throw everywhere. The *contextually* reserved ones do not, and where they fail depends on the body: `"let"`, `"yield"`, `"static"`, `"arguments"` and `"eval"` compile fine in a sloppy body and throw only under `"use strict";`, while `"await"` is the mirror image — legal in `createSyncFunction`, a `SyntaxError` in `createAsyncFunction`. A name that works today can break when someone adds `"use strict";` to the body.
- **Distinct names**, both within `params` and against `context` keys — see the shadowing rule above, which is silent unless the body is strict.
- **Never caller-supplied.** `params` is compiled as code, so an attacker-controlled entry is an injection vector on the same footing as `doc` itself. See [Security](#security).

If you accept names from a config file or a database, check them yourself before handing them over — a `/^[A-Za-z_$][\w$]*$/` test plus a reserved-word set plus a duplicate check covers the plain-identifier case. Doing it at startup gets you a useful error message instead of a parser one on whichever request happens to compile the rule.

### Scope and semantics of the body

- **No closure capture.** The body closes over the global scope only. Referencing a local from the calling module throws `ReferenceError` at call time. `context` and `params` are the only channels in.
- **Full global access.** The body reaches anything on `globalThis` — `fetch`, `process`, `console`, timers. There is no sandbox.
- **Sloppy mode.** The body is non-strict unless it starts with `"use strict";`, so an undeclared assignment silently creates a global. Prepend it if you want a body that fails loudly.
- **Arity is not enforced.** The returned function accepts `unknown[]`; extra arguments are dropped, and params with no matching argument are `undefined`.
- **Return type is `unknown`.** Neither factory is generic; cast or validate at the call site.

### Security

These functions are `eval` under a different name. Treat every `doc` string as executable code with your process's full privileges. `params` entries are compiled as source text too, so they are not a safe place for untrusted input either.

- **Never pass untrusted input.** A body from a user request, a webhook payload, an LLM response, or a third-party config can read `process.env`, make network calls, read and write files, and exfiltrate anything reachable. There is no allowlist, no timeout, no memory cap, no scope isolation. `context` restricts what is passed *in*; it restricts nothing about what the body reaches on its own.
- **Not a sandbox.** If you need isolation, use one — `node:vm` with a locked-down context (still not a security boundary against determined code), an unprivileged worker, or a real interpreter for a restricted expression language. Do not reach for a regex "validator" over the source; you will not win that fight.
- **CSP.** In browsers `new Function` requires `script-src 'unsafe-eval'`. Under a normal CSP the call throws `EvalError: call to Function() blocked by CSP` — at runtime, not build time.
- **Restricted runtimes.** Cloudflare Workers and several other edge runtimes disable code generation from strings outright, as does Node under `--disallow-code-generation-from-strings`.
- **Opaque to your toolchain.** The body is not type-checked, linted, minified, tree-shaken, or covered by source maps.
- An infinite loop in `doc` hangs the thread, with no way to interrupt it from the calling code.

## API

Both factories take a single options object:

```ts
type CreateFunctionOptions = {
  doc: string;
  context?: Record<string, unknown>;
  params?: string[];
};
```

- `doc` — the **function body** source, not an expression. Use an explicit `return`; a body without one evaluates to `undefined`. Inside it, every key of `context` and every entry of `params` is in scope by name.
- `context` — values exposed to the body by name, supplied by the host on every call. Keys must be valid JS identifiers. Defaults to `{}`. Passed by reference, so functions, class instances, and mutable objects all work.
- `params` — the parameter names the body binds to the *caller's* arguments, in order. Each entry is parameter source text, so defaults, rest, and destructuring are allowed. Defaults to `[]`. Entries are **not validated** — they are spliced in verbatim, and an entry matching a `context` key shadows that value silently. Both are the caller's responsibility; see [`params` shadow `context`](#params-shadow-context) and [Validating names is the caller's responsibility](#validating-names-is-the-callers-responsibility).

### `createSyncFunction`

```ts
function createSyncFunction(
  options: CreateFunctionOptions
): (...args: unknown[]) => unknown;
```

Errors thrown by the body propagate synchronously. Throws `SyntaxError` **at creation time** if `doc` does not parse or if any context key or `params` entry is not valid parameter source; throws `EvalError` at creation time when blocked by CSP.

### `createAsyncFunction`

```ts
function createAsyncFunction(
  options: CreateFunctionOptions
): (...args: unknown[]) => Promise<unknown>;
```

Same options and same compile-time errors. The compiled function is an `AsyncFunction`, so `await` is legal in `doc`, the returned function always returns a `Promise` even without an `await`, and a synchronous `throw` in the body becomes a **rejection** — use `try { await fn() }`, never a bare `try { fn() }`.

## Usage

```ts
import { createSyncFunction } from "@isel-jao/ts-lib";

const double = createSyncFunction({ doc: "return n * 2;", params: ["n"] });
double(2); // 4 — compiled once, called many times
```

Injecting values and helpers by name, alongside a per-call param:

```ts
const fn = createSyncFunction({
  doc: "return round(base * (1 + rate)) + extra;",
  context: { base: 100, rate: 0.2, round: Math.round },
  params: ["extra"],
});

fn(5); // 125
```

Params are ordinary parameter syntax, so defaults and destructuring work:

```ts
const fn = createSyncFunction({
  doc: "return items.length * factor;",
  params: ["{ items }", "factor = 1"],
});

fn({ items: [1, 2, 3] }); // 3
fn({ items: [1, 2, 3] }, 2); // 6
```

An async body with an injected dependency — the helper is passed by reference and never serialized:

```ts
import { createAsyncFunction } from "@isel-jao/ts-lib";

const rule = createAsyncFunction({
  doc: `
    const user = await getUser(userId);
    return user.plan === "pro" && user.seats > minSeats;
  `,
  context: { getUser, minSeats: 5 },
  params: ["userId"],
});

const allowed = (await rule("u_123")) as boolean;
```

Because compilation is eager, compiling a set of stored rules at startup catches a bad one during boot rather than on whichever request happens to hit it. Prepending `"use strict";` to each body is worth the two seconds it costs — it also upgrades a `context`/`params` name collision from a silent shadow to a startup error.

## Edge cases

| Case | Behavior |
| --- | --- |
| Body with no `return` | returns `undefined` |
| No `context` / no `params` | default to `{}` and `[]` |
| More arguments than `params` | extras are dropped |
| Fewer arguments than `params` | unmatched params are `undefined` |
| `params` entry with a default, rest, or destructuring | works — entries are parameter source text |
| Body throws, sync / async | propagates to the caller / rejects the promise |
| Async body with no `await` | still returns a `Promise` |
| Repeated calls | reuse the same compiled function; arguments are per call |
| Mutating a `context` *value* between calls | visible to the body; adding a *key* is not |
| Invalid `doc` syntax | `SyntaxError` from the factory, before any call |
| Context key or `params` entry that is not valid parameter source | `SyntaxError` from the factory — names are never validated by the helpers |
| `params` entry equal to a `context` key | param silently shadows the context value, called with an argument or not |
| Same collision with a `"use strict";` body | `SyntaxError` (duplicate parameter) from the factory |
| Duplicate entries within `params` | last one wins, silently — `SyntaxError` only under a strict body |
| `"await"` as a `params` entry | fine in `createSyncFunction`; `SyntaxError` in `createAsyncFunction` |
| `"let"` / `"yield"` / `"arguments"` as a `params` entry | fine in a sloppy body; `SyntaxError` under `"use strict";` |
| Body references a local from the calling scope | `ReferenceError` at call time — no closure capture |
| Undeclared assignment in the body | creates a global unless `doc` starts with `"use strict";` |
| Browser with strict CSP | `EvalError` — requires `unsafe-eval` |
| Infinite loop in the body | blocks the thread; not interruptible |
