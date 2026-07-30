# HTTP Error

An `Error` subclass that carries an HTTP status, plus 20 ready-made subclasses for the common 4xx/5xx statuses and a `createHttpError(status)` factory that maps a status code back to its class. Instances hold a `details` payload, response `headers`, and a native `cause`, and serialize to a sane JSON body instead of `{}`. Reach for it when you want to throw at the point where a failure is detected and decide the HTTP response in one place — a route handler, a service layer, or a `fetch` wrapper that turns non-2xx responses into throwables.

## Why

The naive version is an ad-hoc property on a plain `Error`:

```ts
const err = new Error("User not found");
(err as any).status = 404;
throw err;
```

Four things go wrong with that, and none of them are fixed by a 5-line helper that only builds the object.

**1. The catch block gives you `unknown`, not your error.** Under `strict` (`useUnknownInCatchVariables`), `catch (err)` binds `unknown`. You cannot read `err.status` without a cast, and you cannot call a method on it either — so the identity check has to come from *outside* the value. Everyone therefore hand-rolls the same guard, and a good share of them are subtly wrong:

```ts
// null is "object"; `in` throws on a primitive; a look-alike `{status: 404}` passes
if (typeof err === "object" && err !== null && "status" in err) { /* ... */ }
```

**2. `res.json(err)` sends an empty body.** `Error`'s `name`, `message` and `stack` are non-enumerable own properties, so `JSON.stringify(new Error("x"))` is `"{}"`. The status line says 404 and the body says nothing. Spreading is no better: `{...err}` also drops `message`. Every project ends up writing a bespoke `{ message: err.message, status: err.status }` literal in the error middleware, and a second one in the RPC layer, and a third one in the job runner.

**3. Retry and log policy need the 4xx/5xx split, and it gets rewritten per call site.** `status >= 500` inline in the fetch client, again in the middleware, again in the queue consumer — each with its own opinion about whether 429 counts.

**4. `Retry-After` and `Allow` have nowhere to live.** They belong to the failure, but the failure is raised deep in a service where no response object exists, so they get smuggled back out-of-band or dropped.

On top of that, 20 classes each with a status code and the matching reason phrase is precisely the sort of thing that gets copy-pasted between projects with a typo in "Unprocessable Entity" and a missing 402.

What is actually needed: one shared class so `instanceof` is a reliable identity check on `unknown`, a serialization contract that `JSON.stringify` picks up on its own wherever the error ends up nested, and a stable set of `name`s so log aggregation groups by `NotFoundError` rather than by message text.

## How it works

### The base class

```ts
constructor(status: number, message = "Http Error", options: HttpErrorOptions = {}) {
  super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
  this.name = "HttpError";
  ...
}
```

The conditional second argument to `super` is deliberate. `new Error(msg, { cause: undefined })` still creates an own `cause` property holding `undefined`, which structured loggers emit as `cause: null` and which makes `"cause" in err` a lie. Passing `undefined` instead of `{ cause: undefined }` leaves the property off entirely — pinned by a test asserting `"cause" in new HttpError(500) === false`.

`this.name` is assigned in every constructor: the base sets `"HttpError"`, then each subclass overwrites it with its own class name after `super()` returns. This makes `name` an own *enumerable* property shadowing the non-enumerable `Error.prototype.name`, and it is what `toJSON` reports. V8 formats the stack header lazily, so the assignment lands in time: `new NotFoundError("nope").stack` starts with `NotFoundError: nope`.

Fields:

| Field | Type | Why it exists |
| --- | --- | --- |
| `status` | `number` | Not constrained to known codes — any integer, including 418 or a vendor status. |
| `details` | `unknown` | Machine-readable payload (validation issues, resource id). `unknown` rather than a shape, so consumers must narrow instead of trusting it. |
| `headers` | `Record<string, string> \| undefined` | Response headers that belong to the failure. Kept separate from `details` because these go on the response, `details` goes in the body. |
| `cause` | `unknown` (from ES2022 `Error`) | The underlying error. Internal — never serialized. |

All three declared fields are `readonly`, which is a compile-time guarantee only; nothing freezes the instance.

### `isClientError` / `isServerError`

Two getters over half-open ranges, `400–499` and `500–599`. Note that neither is the negation of the other: `new HttpError(200)` reports `false` for both, which is correct — a negation-based implementation would classify 200 and 301 as server errors.

The split is not decoration; three decisions hang off it:

- **Log severity.** A 4xx is the caller's fault and is expected traffic — `info`/`warn`, no alert. A 5xx is yours — `error`, with the `cause` and `stack` attached, and it should move an alerting metric.
- **Retry policy.** A 4xx will fail identically on replay (the body is still malformed, the row still doesn't exist), so retrying just multiplies load. 5xx and 429 are the retryable set.
- **Message exposure.** 4xx messages are authored for the caller and can be forwarded verbatim. 5xx messages usually are not authored at all — they are whatever the driver produced: `connect ECONNREFUSED 10.0.3.7:5432`, an `ER_DUP_ENTRY` with a table name, a stack containing `/srv/app/node_modules/...`. That leaks internal hostnames, schema, and paths to whoever triggered the failure. A boundary that treats all errors alike either leaks on 5xx or swallows useful 4xx text; the split lets it log the real 5xx message and send a constant.

### `toJSON`

`JSON.stringify` consults a `toJSON` method on any value it is serializing, at any depth. Defining one means `res.json(err)`, `JSON.stringify({ error: err })`, and an error nested three levels inside a batch response all produce the same body with nothing at the call site knowing about it. Without it, all three produce `{}` for the reasons above.

It is a whitelist, not a dump:

```ts
{ name, status, message }        // always
{ ..., details }                 // only when details !== undefined
```

`headers` is excluded because it is transport, not body. `cause` and `stack` are excluded because they are internal and are precisely what you do not want on the wire. The `details` key is omitted rather than set to `undefined` so that `"details" in body` is a meaningful check for the client — note this tests `!== undefined` specifically, so `details: null` *is* serialized.

### `isHttpError` is static, and a type predicate

```ts
static isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}
```

Static because of the catch-block problem above: the value you are interrogating is `unknown`, so there is nothing you may call on it. An instance method would also be circular — asking the suspect whether it is trustworthy. The check must be applied from outside, exactly like `Array.isArray(value)` rather than `value.isArray()`.

The `value is HttpError` return type is a type predicate. In the true branch of `if (HttpError.isHttpError(err))`, the compiler narrows the `unknown` binding to `HttpError`, so `err.status`, `err.isServerError`, `err.details` and `err.cause` all typecheck with no cast. That narrowing is the whole point; a `boolean` return would leave you casting anyway.

Two consequences worth knowing:

- Statics are inherited, so `NotFoundError.isHttpError(x)` compiles and runs — but it still checks `instanceof HttpError`, so `NotFoundError.isHttpError(new ConflictError())` is `true`. For a specific class use `err instanceof NotFoundError`.
- `instanceof` is identity-based. Two copies of the package in the tree (a version dupe, or one bundled and one from `node_modules`) are two distinct `HttpError` classes and the check returns `false` across them. The same applies across realms (`vm` contexts, workers, iframes) — though an error that crossed a `postMessage` boundary is a structured clone, not an `Error`, so it was never going to pass.

### The factory

```ts
type HttpErrorConstructor = new (message?: string, options?: HttpErrorOptions) => HttpError;
const httpErrorsByStatus = new Map<number, HttpErrorConstructor>([...]);
```

The subclasses all share the `(message?, options?)` signature, which is what makes a `Map<number, Constructor>` possible at all. `HttpError` itself does *not* fit that signature — its first parameter is `status` — which is exactly why the unmapped-status fallback is a separate `new HttpError(status, message, options)` line rather than a 21st map entry.

`createHttpError` returns `HttpError` for every input. There are no per-status overloads, so `createHttpError(404)` is statically an `HttpError` even though it is a `NotFoundError` at runtime. Passing `undefined` as the message (rather than a computed empty string) lets the matched class supply its own default: `createHttpError(404).message === "Not Found"`.

**To add a status:** add the class (constructor calls `super(code, message, options)` and sets `this.name`), add the `[code, Class]` map entry, and add a row to the `cases` table in `index.test.ts` — the `describe.each` over that table covers the default status, the default message, the static, the name, options passthrough, the instanceof chain, and the factory mapping automatically.

## API

### `HttpErrorOptions`

```ts
type HttpErrorOptions = {
  cause?: unknown;
  details?: unknown;
  headers?: Record<string, string>;
};
```

| Option | Effect |
| --- | --- |
| `cause` | Forwarded to the native `Error` constructor. Omitted entirely when `undefined`, so no `cause` property is created. |
| `details` | Stored on `.details`. Included in `toJSON()` when not `undefined`. |
| `headers` | Stored on `.headers`. Never serialized; apply it to the response yourself. |

### `HttpError`

```ts
class HttpError extends Error {
  constructor(status: number, message?: string, options?: HttpErrorOptions);

  readonly status: number;
  readonly details: unknown;
  readonly headers: Record<string, string> | undefined;

  get isClientError(): boolean;
  get isServerError(): boolean;

  toJSON(): { name: string; status: number; message: string; details?: unknown };

  static isHttpError(value: unknown): value is HttpError;
}
```

- **`constructor(status, message = "Http Error", options = {})`** — `status` is any number, unvalidated. Throws nothing.
- **`isClientError`** — `status >= 400 && status < 500`.
- **`isServerError`** — `status >= 500 && status < 600`.
- **`toJSON()`** — returns a fresh object each call, keys in the order `name`, `status`, `message`, `details`. Called automatically by `JSON.stringify`.
- **`static isHttpError(value)`** — `true` for `HttpError` and any subclass; `false` for plain `Error`, `null`, `undefined`, and look-alike objects. Narrows `unknown` to `HttpError`.

The base class carries no `static status`; only the subclasses do.

### Status subclasses

Each takes `(message?: string, options?: HttpErrorOptions)`, sets `this.name` to its own class name, exposes the code as a `static readonly status` (typed as the literal, e.g. `400`), and is an instance of `HttpError` and `Error`.

| Class | Status | Default message |
| --- | --- | --- |
| `BadRequestError` | 400 | `Bad Request` |
| `UnauthorizedError` | 401 | `Unauthorized` |
| `PaymentRequiredError` | 402 | `Payment Required` |
| `ForbiddenError` | 403 | `Forbidden` |
| `NotFoundError` | 404 | `Not Found` |
| `MethodNotAllowedError` | 405 | `Method Not Allowed` |
| `NotAcceptableError` | 406 | `Not Acceptable` |
| `RequestTimeoutError` | 408 | `Request Timeout` |
| `ConflictError` | 409 | `Conflict` |
| `GoneError` | 410 | `Gone` |
| `PreconditionFailedError` | 412 | `Precondition Failed` |
| `PayloadTooLargeError` | 413 | `Payload Too Large` |
| `UnsupportedMediaTypeError` | 415 | `Unsupported Media Type` |
| `UnprocessableEntityError` | 422 | `Unprocessable Entity` |
| `TooManyRequestsError` | 429 | `Too Many Requests` |
| `InternalServerError` | 500 | `Internal Server Error` |
| `NotImplementedError` | 501 | `Not Implemented` |
| `BadGatewayError` | 502 | `Bad Gateway` |
| `ServiceUnavailableError` | 503 | `Service Unavailable` |
| `GatewayTimeoutError` | 504 | `Gateway Timeout` |

Not covered: 407, 411, 414, 416, 417, 418, 421, 423–428, 431, 451, 505 and above. Use `new HttpError(code, ...)` or `createHttpError(code, ...)` for those.

### `createHttpError`

```ts
function createHttpError(
  status: number,
  message?: string,
  options?: HttpErrorOptions
): HttpError;
```

- `status` — looked up in the class table. A hit constructs that subclass; a miss constructs a base `HttpError` carrying the status as given.
- `message` — passed through. `undefined` selects the matched class's default message (or `"Http Error"` on the fallback path).
- `options` — passed through unchanged.
- Returns an `HttpError` (statically; the runtime class is the mapped subclass). Throws nothing.

## Usage

### Throwing where the failure is detected

```ts
import { ConflictError, NotFoundError, UnprocessableEntityError } from "@isel-jao/ts-lib";

async function getUser(id: string) {
  const user = await db.user.findById(id);
  if (!user) throw new NotFoundError(`User ${id} not found`, { details: { id } });
  return user;
}

async function createUser(input: { email: string }) {
  if (await db.user.findByEmail(input.email)) {
    throw new ConflictError("Email already registered", {
      details: { field: "email", value: input.email },
    });
  }
  return db.user.insert(input);
}

function assertValid(issues: { field: string; message: string }[]) {
  if (issues.length > 0) {
    throw new UnprocessableEntityError("Invalid body", { details: issues });
  }
}
```

### Express-style central error handler

One place decides status, headers, log level, and what the caller is allowed to see.

```ts
import type { NextFunction, Request, Response } from "express";
import { HttpError, InternalServerError } from "@isel-jao/ts-lib";

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  // anything unrecognised is a bug in our code: 500, with the original kept as cause
  const error = HttpError.isHttpError(err)
    ? err
    : new InternalServerError("Internal Server Error", { cause: err });

  if (error.headers) res.set(error.headers);

  if (error.isServerError) {
    logger.error(
      { name: error.name, status: error.status, cause: error.cause, stack: error.stack },
      error.message
    );
    // do not forward the message: it may be a driver string with a host, table, or path
    res.status(error.status).json({
      name: error.name,
      status: error.status,
      message: "Internal Server Error",
    });
    return;
  }

  logger.warn({ name: error.name, status: error.status }, error.message);
  res.status(error.status).json(error); // toJSON trims it to name/status/message/details
}
```

### fetch client with retry

```ts
import { HttpError, ServiceUnavailableError, createHttpError } from "@isel-jao/ts-lib";

const RETRYABLE = new Set([408, 425, 429]);
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(error: HttpError): number | undefined {
  const seconds = Number(error.headers?.["Retry-After"]);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export async function request(url: string, init?: RequestInit, attempts = 3): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return await res.json();

      const retryAfter = res.headers.get("retry-after");
      // `undefined` message => the matched class's default, e.g. "Not Found"
      throw createHttpError(res.status, res.statusText || undefined, {
        details: await res.text(),
        headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
      });
    } catch (err) {
      // fetch rejects on DNS/socket failures: wrap, keeping the original as cause
      const error = HttpError.isHttpError(err)
        ? err
        : new ServiceUnavailableError("Network request failed", { cause: err });

      // 5xx and a short list of 4xx are worth replaying; the rest will fail identically
      const retryable = error.isServerError || RETRYABLE.has(error.status);
      if (!retryable || attempt >= attempts) throw error;

      await delay(retryAfterMs(error) ?? 2 ** attempt * 100);
    }
  }
}
```

### Reading `details` back

`details` is `unknown` by design, so narrow it at the point of use:

```ts
import { HttpError } from "@isel-jao/ts-lib";

type FieldIssue = { field: string; message: string };

function issuesOf(error: HttpError): FieldIssue[] {
  return Array.isArray(error.details) ? (error.details as FieldIssue[]) : [];
}
```

## Edge cases

| Case | Behavior |
| --- | --- |
| `new HttpError(418)` | `message` falls back to `"Http Error"`. Any status is accepted; nothing validates the range. |
| `new HttpError(200)` | Both `isClientError` and `isServerError` are `false`. |
| Status outside 400–599 (`0`, `-1`, `600`) | Both getters `false`. Fractional statuses follow the same comparisons (`499.5` counts as a client error). |
| No `cause` given | The property is not created at all — `"cause" in err` is `false`, not `undefined`-valued. |
| No `details` / `headers` given | Both are `undefined`, but they *are* own enumerable properties, so they show up in `Object.keys(err)`. |
| `details: null` | Serialized — `toJSON` drops the key only for `undefined`. |
| `JSON.stringify(err)` | Goes through `toJSON`: `{"name":"ForbiddenError","status":403,"message":"Forbidden"}`. Works nested (`JSON.stringify({ error: err })`) and inside arrays. |
| `{...err}` | Yields `status`, `details`, `headers`, `name` — **not** `message` or `stack`, which are own but non-enumerable. Use `toJSON()`. |
| `HttpError.isHttpError({ status: 404 })` | `false`. Look-alikes and duck types do not pass; only real instances do. |
| `HttpError.isHttpError(null / undefined / new Error("boom"))` | `false`. |
| `NotFoundError.isHttpError(new ConflictError())` | `true` — the inherited static still checks against `HttpError`. |
| `createHttpError(418, "I'm a teapot")` | `err.constructor === HttpError`; status and message preserved. Unmapped statuses never throw. |
| `createHttpError(404)` | Statically typed `HttpError`, runtime `NotFoundError`, message `"Not Found"`. |
| `err.stack` | Contains the class name (`NotFoundError: nope`), because `this.name` is set before the stack string is first formatted. |
| `constructor.name` in the published bundle | The build emits `var HttpError = class _HttpError extends Error`, so `HttpError.name` is `"_HttpError"` in `dist`. Instance `.name` is unaffected. Compare classes by identity (`err.constructor === HttpError`) or read `err.name` / `err.status` — never `err.constructor.name`. |
| Duplicate copies of the package | `instanceof` is per-class-object: two installed copies mean `isHttpError` returns `false` across the boundary. Dedupe the dependency. |
