# evaluate-template

`evaluateTemplate` turns a string document into a **value**. It resolves `{{ ... }}` expressions against a context object, and parses what is left as a JavaScript data literal — so `"10"` becomes the number `10`, `"{x: 1}"` becomes an object, and `"{{user}}"` returns the very object you put in the context, not a copy of it. Reach for it when a config file, a workflow node, a form binding, or a rule engine stores user-authored strings that need to come back out as typed values.

It never throws on a bad expression: the expression evaluates to `undefined` and an optional `onError` callback observes the failure.

## Why

The naive version is two lines, and everyone writes it first:

```ts
const render = (doc: string, ctx: Record<string, unknown>) =>
  doc.replace(/\{\{(.*?)\}\}/g, (_, key) => String(ctx[key.trim()] ?? ""));
```

It works until the first real requirement lands.

**1. Everything comes back a string.** `render("{{count}}", { count: 10 })` is `"10"`. A config field that stores `retries: "{{maxRetries}}"` now feeds a string into arithmetic. So you add `Number(...)` at the call site — but the same field also has to accept `"true"`, `"null"`, and `"{x: 1}"`, and now the type coercion is the caller's problem in every consumer.

**2. `ctx[key]` is not an expression language.** `{{user.name}}` needs a path walker. Then someone writes `{{items.length}}`, `{{a || b}}`, `{{items.filter(x => x.ok)}}`, `{{n > 3 ? "hi" : "lo"}}`. Every one of those is a new feature in your path walker, and the end state is a worse JavaScript.

**3. Structure is lost.** `{obj: {{obj}}}` should yield an object whose `obj` property **is** the context object — same reference, so a `Date` stays a `Date`, a function stays callable, and a circular graph survives. String interpolation gives `"{obj: [object Object]}"`. Interpolating and then `JSON.parse`-ing loses reference identity and cannot represent `undefined`, `NaN`, `Infinity`, `Date`, functions, or cycles at all.

**4. The no-template case still needs parsing.** A document with no `{{ }}` in it is not automatically a string: `10`, `true`, `[1, 2]` and `{x: 1}` are values. `JSON.parse` rejects unquoted keys, single quotes, trailing commas, comments, hex/binary/underscore numbers, and `undefined`/`NaN`/`Infinity` — all of which a human hand-writing a config will type. `eval` accepts them, but it also accepts `fs.rmSync(...)`, and it turns `{x: 1}` into a labelled statement rather than an object.

**5. One bad key must not sink the document.** `{{missing.value}}` throws a `ReferenceError`. In a document with twenty fields, that has to degrade to `undefined` for that one field, while still being *reportable* so a UI can underline the broken binding.

This module is the whole of that: a hand-written recursive-descent literal parser (no dependencies, nothing executed), a two-pass splicing strategy that preserves reference identity inside structures, and a per-expression error channel.

## How it works

`evaluateTemplate` is a pipeline with four possible exits. Understanding which exit a document takes explains essentially all of its behavior.

```
doc.trim()
  │
  ├─ 0 matches ─────────────────► parseLiteral(source), else source        (exit A)
  │
  ├─ 1 match spanning the whole ─► evaluate(expr), raw                     (exit B)
  │  trimmed source
  │
  └─ otherwise: evaluate every expression once, then
       ├─ pass 1 (structural): splice sentinels, parse, swap ─► value      (exit C)
       └─ pass 2 (textual):    splice serialized text, parse ─► value/text (exit D)
```

### Scanning

`TEMPLATE_RE` is `/\{\{([\s\S]*?)\}\}/g`. Lazy (`*?`) so `{{a}}}}` matches only `{{a}}`; `[\s\S]` so an expression may span newlines. Templates **do not nest** — `{{ {{a}} }}` scans as one match with the expression ` {{a`, which is a syntax error. All matches are collected up front with `matchAll`.

The regex is module-level and shared, but its `lastIndex` is always observably `0`: `matchAll` clones it, and `String.replace` with a `/g/` regex resets `lastIndex` on entry and exit. It is safe to export and reuse — just do not drive it with `.exec()`/`.test()` yourself and expect it to stay clean.

### Exit A — no templates

The trimmed source goes straight to `parseLiteral`. If it parses as a pure data literal, that value is returned; otherwise the trimmed source is returned as a string. This is why `"10"` is `10` and `"10d"` is `"10d"`.

### Exit B — the document *is* one template

If there is exactly one match, it starts at index `0`, and its length equals the whole trimmed source, the expression's result is returned **raw** — no serialization, no re-parsing, no trimming of the result. This is the only path that guarantees reference identity for a top-level value, and it is why `evaluateTemplate("{{s}}", { s: " a " })` is `" a "` with its spaces intact while every text-mode result is trimmed.

Note that the trim happens *before* the span check, so `"  {{user}}  "` still takes this exit.

### Evaluation

Every remaining path evaluates all matched expressions **exactly once**, in document order, before either splicing pass runs. Side effects therefore fire once regardless of which pass ends up producing the result.

`makeEvaluator` binds the context by compiling a function per expression:

```ts
new Function(...names, `"use strict"; return (${expr}\n);`);
```

- `names` is `Object.keys(ctx)` filtered by `isBindableName` — a key is bindable only if it matches `/^[A-Za-z_$][A-Za-z0-9_$]*$/` **and** survives a `new Function(name, '"use strict";')` probe. The regex rejects `"foo-bar"`; the probe rejects reserved words like `class` and strict-mode-reserved names like `yield`. Unbindable keys are silently dropped, and the remaining keys still bind — one bad key does not break the rest of the context.
- The `\n` before `)` matters: without it, an expression ending in a `//` comment would swallow the closing paren.
- The wrapping parens make `{{ {x: 1} }}` an object literal rather than a block.
- `try/catch` covers both compile-time failures (`{{(}}`, `{{}}`, `{{throw ...}}` — all `SyntaxError`) and runtime failures (`{{missing.value}}` — `ReferenceError`). Either way the result is `undefined` and `onError(error, expr)` fires.

**This is not a sandbox.** `new Function` is in the `eval` family. Expressions see every global (`Math`, `fetch`, `process`, `globalThis`) and can mutate them. Bindable context keys shadow globals, so `ctx.Math = 7` makes `{{Math}}` return `7`. Only evaluate templates you trust.

Cost: one `Function` compile per template occurrence per call, plus one throwaway compile per ASCII-identifier-shaped context key (the `isBindableName` probe). Nothing is cached across calls. For hot paths with many keys or many templates, this dominates everything else in the module.

### Pass 1 — the structural pass

The goal is to make `{x: {{1 + 2}}, y: {{obj}}}` parse as a literal while `y` ends up holding the *actual* context object. The trick is a sentinel:

1. For index `i`, build the sentinel string `"\u0000" + i + "\u0000"` and the token `JSON.stringify(sentinel)`. For index `0` that token is the 15-character source text `"\u00000\u0000"` — a quoted string whose body is the two six-character `\u0000` escape sequences around the digit.
2. Splice one token per template into the source. A quoted string is syntactically valid in **both** value position and key position, so the spliced document parses wherever the template stood.
3. `parseLiteral` the spliced document. Its own escape decoding turns those `\u0000` escapes back into real NUL characters, reproducing the sentinel exactly.
4. `resolveSentinels` walks the parsed value and rebuilds it, swapping each sentinel string for the raw evaluated value.

`resolveSentinels` has three rules:

- A string containing no NUL passes through unchanged (fast path — most strings).
- A string that is *exactly* a known sentinel becomes `values[index]`, with full identity.
- A string that contains a NUL but is not a known sentinel **fails the entire pass**. This is the case where the template sat inside quotes: `{x: "{{a}}"}` splices to `{x: ""\u00000\u0000""}`, and any variant that still parses yields a string with the sentinel embedded in it. Failure is not an error — it falls through to pass 2, which handles quoted templates textually and correctly produces `{ x: "1" }`.

Keys are handled separately: a key containing a NUL is looked up in the sentinel map and replaced by `serialize(values[index])`, so `{ {{k}}: 1 }` with `k = "name"` yields `{ name: 1 }`. Object properties are installed with `Object.defineProperty`, so a `__proto__` key becomes a plain own property instead of reassigning the prototype.

**Forgery guard:** if the raw source already contains a NUL character, pass 1 is skipped entirely — a document could otherwise spell a sentinel itself and steal a value. (An *escaped* `\0` in the source is not caught by that guard, but it fails harmlessly at step 4: the decoded NUL string is not a known sentinel, so the pass aborts and pass 2 takes over. The cost is that such a document loses reference identity — see Edge cases.)

### Pass 2 — the textual pass

Each value is passed through `serialize` (strings as-is, `null`/`undefined` as `""`, everything else via `String()`), spliced into the source as plain text, and the result is trimmed. That text goes through `parseLiteral` one more time: if it parses, the value is returned; otherwise the text itself is.

That final re-parse is deliberate — it makes `"{{x}}%"` a string but `"{{a}}{{b}}"` with `a = "1"`, `b = "0"` the number `10`. It is also the module's sharpest coercion edge; see Edge cases.

### The literal parser

`parseLiteral` is a recursive-descent parser over a `{ src, pos }` cursor. It accepts a strict superset of JSON and a strict subset of JavaScript expressions: **pure data only**. Nothing is executed, no identifier is resolved, and no host object is consulted, so parsing is always side-effect free (its only failure mode on hostile input is recursion depth — see below).

Accepted grammar:

| Construct | Accepted |
| --- | --- |
| Keywords | `true` `false` `null` `undefined` `NaN` `Infinity` |
| Numbers | decimal, `.5`, `10.`, exponents, `0x1f`, `0o17`, `0b1010`, `1_000` |
| Signs | `+3`, `-3.14`, `-Infinity`, `- -3` (recursive; `--`/`++` rejected) |
| Strings | `"..."` and `'...'` with the full JS escape set — `\n` `\t` `\xNN` `\uNNNN` `\u{...}` legacy octal `\101`, line continuations |
| Objects | unquoted keys (reserved words allowed), quoted keys, numeric keys, trailing comma |
| Arrays | trailing comma; holes and spread rejected |
| Comments | `//` and `/* */` anywhere whitespace is allowed |

Two design points do most of the rejecting work:

- **Trailing-junk check.** `parseLiteral` parses one value, skips trailing whitespace/comments, and requires `pos === src.length`. This is why `"(10)"`, `"1.2.3"` and `"[1] /* oops"` (unterminated comment, so the `/` is left in place) are strings rather than partially-parsed values.
- **Number/identifier boundary.** After a number, the next character must not be an identifier part. Without this, `"1n"` would parse as `1` and `"10d"` as `10`, silently truncating the source.

The cursor only moves forward and there is no backtracking: any sub-parser failure aborts the whole parse immediately. That makes `parseLiteral` **O(n)** in source length. Recursion depth equals nesting depth, and there is **no depth cap** — a literal nested a few thousand levels deep raises a `RangeError` out of `evaluateTemplate` (measured on Node 24: 3k levels parse fine, 5k overflows).

Overall: at most two `O(n)` parses plus one `O(size)` sentinel walk, dominated in practice by the `m + k` `Function` compilations for `m` templates and `k` context keys. Space is `O(n)` for the spliced copy plus `O(depth)` stack.

### Invariants worth preserving

- Every expression is evaluated once per call, before any splicing.
- A pass-1 failure is never surfaced; pass 2 always yields something.
- Pass 1 never runs on a source containing a raw NUL.
- Sentinel *values* are never re-scanned, only substituted — a context value that itself contains NUL characters survives intact.
- `serialize` is used for two different jobs: pass-2 text splicing and pass-1 key stringification. Changing it changes both.

## API

### `evaluateTemplate`

```ts
function evaluateTemplate(
  doc: string,
  ctx: Record<string, unknown>,
  onError?: TemplateErrorHandler
): unknown;
```

- **`doc`** — the document. Trimmed before anything else. `{{ ... }}` marks an expression.
- **`ctx`** — the evaluation context. Keys that are valid, non-reserved ASCII identifiers are bound as in-scope variables for every expression; other keys are ignored. Globals remain reachable and are shadowed by bindable context keys.
- **`onError`** — optional. Called once per expression that fails to compile or throws.

**Returns** `unknown`: the raw expression result (whole-document template), a parsed literal, or a string.

**Throws** — not for bad expressions, which become `undefined`. It can still propagate:
- a `RangeError` from parser recursion on pathologically nested literals;
- anything thrown by a value's `toString` during `serialize` in the textual pass;
- a `TypeError` if `doc` is not a string (`doc.trim()`).

### `serialize`

```ts
function serialize(data: unknown): string;
```

Stringification used by the textual pass and by template-in-key-position. Strings pass through unchanged; `null` and `undefined` become `""`; everything else goes through `String()` — so arrays join (`[1,2]` → `"1,2"`), plain objects become `"[object Object]"`, functions become their source text, symbols become `"Symbol(s)"`, and bigints drop the `n`.

Throws whatever a custom `toString`/`Symbol.toPrimitive` throws.

### `TEMPLATE_RE`

```ts
const TEMPLATE_RE: RegExp; // /\{\{([\s\S]*?)\}\}/g
```

The scanner regex, exported so callers can find or highlight templates with the exact same rules the evaluator uses (for example, collecting the dependencies of a document before evaluating it). Capture group 1 is the raw expression text, including surrounding whitespace.

### `TemplateErrorHandler`

```ts
type TemplateErrorHandler = (error: unknown, expr: string) => void;
```

- **`error`** — the thrown value: `SyntaxError` for an expression that does not compile, or whatever the expression threw at runtime.
- **`expr`** — the raw capture, *not* trimmed. Trim it before displaying.

The handler's return value is ignored, and the failing expression still resolves to `undefined`. Its own exceptions are not caught.

## Usage

```ts
import { evaluateTemplate } from "@isel-jao/ts-lib";

// Bare literals — no template needed
evaluateTemplate("10", {});          // 10
evaluateTemplate("true", {});        // true
evaluateTemplate('"true"', {});      // "true"  (quoting forces a string)
evaluateTemplate("{x: 1, y: [2]}", {}); // { x: 1, y: [2] }
evaluateTemplate("hello world", {}); // "hello world"

// Whole-document template — raw value, full identity
evaluateTemplate("{{num}}", { num: 10 });            // 10
evaluateTemplate("{{10 + 20}}", {});                 // 30
evaluateTemplate("{{Math.max(1, 2)}}", {});          // 2
evaluateTemplate("{{items.filter((x) => x > 1)}}", { items: [1, 2, 3] }); // [2, 3]

// Text interpolation
evaluateTemplate("hello {{name}}", { name: "world" }); // "hello world"
evaluateTemplate("{{x}}%", { x: 100 });                // "100%"
```

Structures keep references, so non-JSON values survive:

```ts
import { evaluateTemplate } from "@isel-jao/ts-lib";

const user = { id: 1, seen: new Date() };

const config = evaluateTemplate(
  `{
     // request built from ctx
     url: "/api/users",
     id: {{user.id}},
     user: {{user}},
     retries: {{limits.retries ?? 3}},
     onDone: {{done}},
   }`,
  { user, limits: {}, done: () => console.log("ok") }
) as { url: string; id: number; user: typeof user; retries: number; onDone: () => void };

config.user === user;             // true — same object, not a clone
config.user.seen instanceof Date; // true
typeof config.onDone;             // "function"
config.retries;                   // 3 — `limits.retries ?? 3`, evaluated as JS
config.url;                       // "/api/users" — plain literal, untouched
```

Collecting binding errors instead of failing the render:

```ts
import { evaluateTemplate, type TemplateErrorHandler } from "@isel-jao/ts-lib";

const problems: string[] = [];
const onError: TemplateErrorHandler = (error, expr) => {
  problems.push(`${expr.trim()}: ${(error as Error).message}`);
};

const result = evaluateTemplate("{a: {{boom.x}}, b: {{ok}}}", { ok: 5 }, onError);
// result   -> { a: undefined, b: 5 }
// problems -> ["boom.x: boom is not defined"]
```

Static analysis of a document before evaluating it:

```ts
import { TEMPLATE_RE } from "@isel-jao/ts-lib";

const doc = "{from: {{a}}, to: {{b.c}}}";
const exprs = [...doc.matchAll(TEMPLATE_RE)].map((m) => m[1].trim());
// ["a", "b.c"]
```

## Edge cases

All verified against `index.test.ts` or against the built module.

### Input shape

| Input | `ctx` | Result |
| --- | --- | --- |
| `""` | `{}` | `""` |
| `"   "` | `{}` | `""` (trimmed first) |
| `"  hello  "` | `{}` | `"hello"` |
| `"{{}}"` | `{}` | `undefined` (empty expression is a `SyntaxError`) |
| `"{{a"` | `{ a: 1 }` | `"{{a"` — no match, not a literal, so a plain string |
| `"{{a}}}}"` | `{ a: 1 }` | `"1}}"` — lazy match leaves the extra braces as text |
| `"{{ {{a}} }}"` | `{ a: 1 }` | `"}}"` — templates do not nest |

### Literals vs strings

| Input | Result | Why |
| --- | --- | --- |
| `"truee"`, `"10d"`, `"1n"`, `"0x"`, `"1.2.3"`, `"--1"` | the string itself | trailing junk / number-identifier boundary |
| `"(10)"`, `"n = 5"`, `"{x: 10 + 20}"`, `"[1, foo()]"` | the string itself | operators and calls are not data |
| `"{x}"`, `"{[k]: 1}"`, `"{...a}"`, `"{get x() {}}"`, `"[1,,2]"`, `` "`tpl`" `` | the string itself | shorthand, computed keys, spread, accessors, holes, template literals all rejected |
| `'"unterminated'`, `'"\\u00zz"'`, `"'a\nb'"` | the string itself | malformed string literals (a raw newline never terminates a string) |
| `"[1] /* oops"` | the string itself | an unterminated block comment is not a comment |
| `"0x1f"` / `"0o17"` / `"0b1010"` / `"1_000"` / `"10."` / `".5"` | `31` / `15` / `10` / `1000` / `10` / `0.5` | full JS numeric grammar |
| `"- -3"` / `"-0"` | `3` / `-0` | signs are recursive and preserve `-0` |
| `"{x: 1,}"`, `"{a: 1 /* two */, b: 2}"`, `"[1] // done"` | `{x:1}`, `{a:1,b:2}`, `[1]` | trailing commas and comments allowed |
| `"{class: 1, 2: 'b', 'c d': 3}"` | `{ 2: "b", class: 1, "c d": 3 }` | reserved-word, numeric, and quoted keys all legal (numeric keys sort first, per JS) |
| `"{__proto__: 1}"` | own property `__proto__`, prototype still `Object.prototype` | installed via `defineProperty` |
| `"'\\400'"` | `" 0"` | legacy octal caps at `\377`; the third digit falls out as text |

### Expressions

| Input | `ctx` | Result |
| --- | --- | --- |
| `"{{missing}}"` | `{}` | `undefined` |
| `"{{foo.bar.baz}}"` | `{ foo: {} }` | `undefined` (`TypeError` swallowed) |
| `"{{(}}"`, `"{{throw new Error('x')}}"`, `"{{await 1}}"` | `{}` | `undefined` (`SyntaxError` swallowed) |
| `"{{num}}"` | `{ "foo-bar": 1, num: 2 }` | `2` — an unbindable key does not break the others |
| `"{{class}}"` | `{ class: 1 }` | `undefined` — reserved words cannot be bound |
| `"{{café}}"` | `{ café: 1 }` | `undefined` — the bindable-name check is **ASCII-only**, even though the literal parser accepts full Unicode identifiers |
| `"{{typeof this}}"` | `{}` | `"undefined"` — strict-mode call, no receiver |
| `"{{arguments[0]}}"` | `{ a: 41 }` | `41` — `arguments` is not bindable, so it resolves to the wrapper function's own arguments object, which holds the bound context values positionally |
| `"{{eval}}"` | `{ eval: 1 }` | the global `eval` — same reason |
| `"{a: 1 /* {{f()}} */}"` | `{ f }` | `{ a: 1 }`, but `f` **is** called — scanning happens before parsing, so a template inside a comment still executes |

### Structural pass (pass 1)

| Input | `ctx` | Result |
| --- | --- | --- |
| `'{x: {{10 + 20}}, y: {{"a" + "b"}}}'` | `{}` | `{ x: 30, y: "ab" }` |
| `"{obj: {{obj}} }"` | `{ obj }` | `.obj === obj` — reference preserved |
| `"{items: [{{obj}}]}"` | `{ obj }` | preserved at any nesting depth |
| `"{d: {{d}}, f: {{f}}, c: {{c}}}"` | Date / function / circular | all preserved verbatim |
| `"{v: {{missing}}}"` | `{}` | `{ v: undefined }` — impossible via JSON |
| `"{n: {{0 / 0}}}"` / `"{n: {{1 / 0}}}"` | `{}` | `{ n: NaN }` / `{ n: Infinity }` |
| `"{ {{k}}: 1 }"` | `{ k: "name" }` | `{ name: 1 }` — template in key position |
| `"{ {{k}}: 1 }"` | `{ k: { a: 1 } }` | `{ "[object Object]": 1 }` — keys go through `serialize` |
| `"{ {{k}}: 1 }"` | `{}` | `{ "": 1 }` — `serialize(undefined)` is `""` |
| `'{x: "{{a}}"}'` | `{ a: 1 }` | `{ x: "1" }` — a quoted template aborts pass 1 and is filled textually |
| `"{x: {{a}}, y: '\u0000'}"` | `{ a: 1 }` | `{ x: 1, y: "\u0000" }` — a raw NUL in the doc skips pass 1; pass 2 still parses |
| `"{x: {{s}}, y: 2}"` | `{ s: "\u0000mid\u0000" }` | preserved — sentinel *values* are substituted, never re-scanned |
| `"{x: {{o}}, y: '\\0'}"` | `{ o: {} }` | `"{x: [object Object], y: '\\0'}"` — an **escaped** `\0` decodes to a NUL that is not a known sentinel, aborting pass 1 and losing identity. Rare, but the one case where an object silently degrades to text |

### Textual pass (pass 2)

| Input | `ctx` | Result |
| --- | --- | --- |
| `" {{num}} {{num}} "` | `{ num: 10 }` | `"10 10"` — the spliced result is trimmed |
| `"hello {{missing}}!"` | `{}` | `"hello !"` — `undefined` serializes to `""` |
| `"hello {{missing}}"` | `{}` | `"hello"` — the trailing empty splice is then trimmed away |
| `"v={{n}}"` / `"v={{b}}"` | `{ n: null }` / `{ b: false }` | `"v="` / `"v=false"` — only `null`/`undefined` blank out |
| `"x: {{c}}"` | circular object | `"x: [object Object]"` |
| `"id: {{fn}}"` | `{ fn }` | `"id: " + fn.toString()` |
| `"{{a}}{{b}}"` | `{ a: "1", b: "0" }` | `10` — **number**, because the spliced text is re-parsed as a literal |
| `"{{a}}{{b}}"` | `{ a: "tru", b: "e" }` | `true` — same rule, and the sharpest surprise in the module |
| `'"{{a}}"'` | `{ a: 1 }` | `"1"` — quotes survive splicing, then the re-parse unwraps them |
| `"{{x}}%"` | `{ x: 100 }` | `"100%"` — not a literal, so it stays a string |

### Whole-document template (exit B)

| Input | `ctx` | Result |
| --- | --- | --- |
| `"{{s}}"` | `{ s: " a " }` | `" a "` — raw value, **not** trimmed |
| `"{{s}}"` | `{ s: "10" }` | `"10"` — string, never re-parsed |
| `"  {{user}}  "` | `{ user }` | `user` — trimming happens before the span check |
| `"{{a}} "` | `{ a: 5 }` | `5` — still a whole-document template after trim |

### Failure modes that *do* throw

- Deeply nested literals (`"[".repeat(5000) + "]".repeat(5000)`) raise `RangeError: Maximum call stack size exceeded` from `parseValue`/`resolveSentinels`. There is no depth limit; do not feed untrusted documents of unbounded nesting depth.
- A context value whose `toString` throws will throw out of the textual pass.
- Expressions run with full ambient authority — `{{globalThis.x = 1}}` really does mutate the global object. `evaluateTemplate` is not a sandbox.
