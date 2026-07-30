# HTTP Error

An `Error` subclass carrying an HTTP status, plus 20 ready-made subclasses for the common 4xx/5xx statuses and a `createHttpError(status)` factory mapping a status code back to its class. Instances hold a `details` payload, response `headers`, and a native `cause`, and serialize to a sane JSON body instead of `{}`. Reach for it when you want to throw where a failure is detected and decide the HTTP response in one place — a route handler, a service layer, or a `fetch` wrapper turning non-2xx responses into throwables.

## Why

The naive version is an ad-hoc property on a plain `Error` (`(err as any).status = 404`). Four things go wrong, and none are fixed by a helper that only builds the object.

**The catch block gives you `unknown`, not your error.** Under `strict` (`useUnknownInCatchVariables`), `catch (err)` binds `unknown`: you cannot read `err.status` without a cast, and you cannot call a method on it either, so the identity check must come from *outside* the value. Everyone hand-rolls the same guard and a good share are subtly wrong — `typeof err === "object" && err !== null && "status" in err` still admits a look-alike `{status: 404}`, and `in` throws on a primitive.

**`res.json(err)` sends an empty body.** `Error`'s `name`, `message` and `stack` are non-enumerable own properties, so `JSON.stringify(new Error("x"))` is `"{}"` — the status line says 404 and the body says nothing. Spreading is no better: `{...err}` also drops `message`. Every project ends up writing a bespoke `{ message, status }` literal in the error middleware, another in the RPC layer, a third in the job runner.

**Retry and log policy need the 4xx/5xx split**, and it gets rewritten per call site — `status >= 500` inline in the fetch client, again in the middleware, again in the queue consumer, each with its own opinion about whether 429 counts.

**`Retry-After` and `Allow` have nowhere to live.** They belong to the failure, but the failure is raised deep in a service where no response object exists, so they get smuggled out-of-band or dropped.

On top of that, 20 classes each with a status and matching reason phrase is exactly what gets copy-pasted between projects with a typo in "Unprocessable Entity" and a missing 402. What is needed: one shared class so `instanceof` is a reliable identity check on `unknown`, a serialization contract `JSON.stringify` picks up on its own wherever the error ends up nested, and stable `name`s so log aggregation groups by `NotFoundError` rather than message text.

## How it works

### The base class

```ts
constructor(status: number, message = "Http Error", options: HttpErrorOptions = {}) {
  super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
  this.name = "HttpError";
  ...
}
```

The conditional second argument to `super` is deliberate: `new Error(msg, { cause: undefined })` still creates an own `cause` property holding `undefined`, which structured loggers emit as `cause: null` and which makes `"cause" in err` a lie. Passing `undefined` instead leaves the property off entirely — pinned by a test asserting `"cause" in new HttpError(500) === false`.

`this.name` is assigned in every constructor: the base sets `"HttpError"`, then each subclass overwrites it with its own class name after `super()` returns. That makes `name` an own *enumerable* property shadowing the non-enumerable `Error.prototype.name`, and it is what `toJSON` reports. V8 formats the stack header lazily, so the assignment lands in time — `new NotFoundError("nope").stack` starts with `NotFoundError: nope`.

| Field | Type | Why it exists |
| --- | --- | --- |
| `status` | `number` | Not constrained to known codes — any integer, including 418 or a vendor status. |
| `details` | `unknown` | Machine-readable payload (validation issues, resource id). `unknown` rather than a shape, so consumers must narrow instead of trusting it. |
| `headers` | `Record<string, string> \| undefined` | Response headers belonging to the failure. Separate from `details` because these go on the response, `details` goes in the body. |
| `cause` | `unknown` (ES2022 `Error`) | The underlying error. Internal — never serialized. |

All three declared fields are `readonly`, a compile-time guarantee only; nothing freezes the instance.

### `isClientError` / `isServerError`

Two getters over half-open ranges, `400–499` and `500–599`. Neither is the negation of the other — `new HttpError(200)` reports `false` for both, which is correct, since a negation-based implementation would classify 200 and 301 as server errors.

Three decisions hang off the split. **Log severity**: a 4xx is the caller's fault and expected traffic (`info`/`warn`, no alert), a 5xx is yours (`error`, with `cause` and `stack`, moving an alerting metric). **Retry policy**: a 4xx fails identically on replay — the body is still malformed, the row still does not exist — so 5xx and 429 are the retryable set. **Message exposure**: 4xx messages are authored for the caller and forward verbatim, while 5xx messages usually are not authored at all — they are whatever the driver produced (`connect ECONNREFUSED 10.0.3.7:5432`, an `ER_DUP_ENTRY` naming a table, a stack containing `/srv/app/node_modules/...`), leaking internal hostnames, schema, and paths to whoever triggered the failure. A boundary treating all errors alike either leaks on 5xx or swallows useful 4xx text.

### `toJSON`

`JSON.stringify` consults a `toJSON` method on any value it serializes, at any depth. Defining one means `res.json(err)`, `JSON.stringify({ error: err })`, and an error nested three levels inside a batch response all produce the same body with nothing at the call site knowing about it. Without it, all three produce `{}`.

It is a whitelist, not a dump — `{ name, status, message }` always, plus `details` only when it is not `undefined`. `headers` is excluded because it is transport, not body; `cause` and `stack` are excluded as internal and precisely what you do not want on the wire. The `details` key is omitted rather than set to `undefined`, so `"details" in body` is meaningful for the client — and since the test is `!== undefined`, `details: null` *is* serialized.

### `isHttpError` is static, and a type predicate

```ts
static isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}
```

Static because of the catch-block problem: the value is `unknown`, so there is nothing you may call on it. An instance method would also be circular — asking the suspect whether it is trustworthy. The check applies from outside, exactly like `Array.isArray(value)` rather than `value.isArray()`.

The `value is HttpError` return type is a type predicate: in the true branch of `if (HttpError.isHttpError(err))` the compiler narrows the `unknown` binding to `HttpError`, so `err.status`, `err.isServerError`, `err.details` and `err.cause` all typecheck with no cast. That narrowing is the point — a `boolean` return would leave you casting anyway.

Two consequences: statics are inherited, so `NotFoundError.isHttpError(x)` compiles and runs but still checks `instanceof HttpError`, making `NotFoundError.isHttpError(new ConflictError())` `true` (use `err instanceof NotFoundError` for a specific class). And `instanceof` is identity-based — two copies of the package in the tree are two distinct `HttpError` classes and the check returns `false` across them. The same applies across realms (`vm` contexts, workers, iframes), though an error crossing a `postMessage` boundary is a structured clone, not an `Error`, so it was never going to pass.

### The factory

```ts
type HttpErrorConstructor = new (message?: string, options?: HttpErrorOptions) => HttpError;
const httpErrorsByStatus = new Map<number, HttpErrorConstructor>([...]);
```

The subclasses share the `(message?, options?)` signature, which is what makes a `Map<number, Constructor>` possible. `HttpError` itself does *not* fit it — its first parameter is `status` — which is why the unmapped-status fallback is a separate `new HttpError(status, message, options)` line rather than a 21st map entry.

`createHttpError` returns `HttpError` for every input; there are no per-status overloads, so `createHttpError(404)` is statically an `HttpError` even though it is a `NotFoundError` at runtime. Passing `undefined` as the message (rather than a computed empty string) lets the matched class supply its own default.

**To add a status:** add the class (constructor calls `super(code, message, options)` and sets `this.name`), add the `[code, Class]` map entry, and add a row to the `cases` table in `index.test.ts` — the `describe.each` over that table automatically covers the default status and message, the static, the name, options passthrough, the instanceof chain, and the factory mapping.

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

  get isClientError(): boolean;  // status >= 400 && status < 500
  get isServerError(): boolean;  // status >= 500 && status < 600

  toJSON(): { name: string; status: number; message: string; details?: unknown };

  static isHttpError(value: unknown): value is HttpError;
}
```

`status` is any number, unvalidated, and the constructor throws nothing. `toJSON()` returns a fresh object each call with keys ordered `name`, `status`, `message`, `details`, and is called automatically by `JSON.stringify`. `static isHttpError` is `true` for `HttpError` and any subclass, `false` for plain `Error`, `null`, `undefined`, and look-alike objects. The base class carries no `static status`; only the subclasses do.

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

`status` is looked up in the class table — a hit constructs that subclass, a miss constructs a base `HttpError` carrying the status as given. `message` passes through, and `undefined` selects the matched class's default (or `"Http Error"` on the fallback path). `options` passes through unchanged. Returns an `HttpError` statically; the runtime class is the mapped subclass. Throws nothing.

## Usage

Throw where the failure is detected:

```ts
import { ConflictError, NotFoundError } from "@isel-jao/ts-lib";

async function getUser(id: string) {
  const user = await db.user.findById(id);
  if (!user) throw new NotFoundError(`User ${id} not found`, { details: { id } });
  return user;
}

if (await db.user.findByEmail(input.email)) {
  throw new ConflictError("Email already registered", {
    details: { field: "email", value: input.email },
  });
}
```

An Express-style central handler, where one place decides status, headers, log level, and what the caller may see:

```ts
import { HttpError, InternalServerError } from "@isel-jao/ts-lib";

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);

  // anything unrecognised is a bug in our code: 500, with the original kept as cause
  const error = HttpError.isHttpError(err)
    ? err
    : new InternalServerError("Internal Server Error", { cause: err });

  if (error.headers) res.set(error.headers);

  if (error.isServerError) {
    logger.error({ name: error.name, cause: error.cause, stack: error.stack }, error.message);
    // do not forward the message: it may be a driver string with a host, table, or path
    res.status(error.status).json({ name: error.name, status: error.status, message: "Internal Server Error" });
    return;
  }

  logger.warn({ name: error.name, status: error.status }, error.message);
  res.status(error.status).json(error); // toJSON trims it to name/status/message/details
}
```

A fetch client with retry:

```ts
import { HttpError, ServiceUnavailableError, createHttpError } from "@isel-jao/ts-lib";

const RETRYABLE = new Set([408, 425, 429]);

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

      // 5xx and a short list of 4xx are worth replaying; the rest fail identically
      if (!(error.isServerError || RETRYABLE.has(error.status)) || attempt >= attempts) throw error;

      const seconds = Number(error.headers?.["Retry-After"]);
      await new Promise((r) => setTimeout(r, Number.isFinite(seconds) ? seconds * 1000 : 2 ** attempt * 100));
    }
  }
}
```

`details` is `unknown` by design, so narrow it at the point of use — `Array.isArray(error.details) ? (error.details as FieldIssue[]) : []`.

## Edge cases

| Case | Behavior |
| --- | --- |
| `new HttpError(418)` | `message` falls back to `"Http Error"`. Any status is accepted; nothing validates the range. |
| `new HttpError(200)` | Both `isClientError` and `isServerError` are `false`. |
| Status outside 400–599 (`0`, `-1`, `600`) | Both getters `false`. Fractional statuses follow the same comparisons (`499.5` counts as a client error). |
| No `cause` given | The property is not created at all — `"cause" in err` is `false`, not `undefined`-valued. |
| No `details` / `headers` given | Both are `undefined`, but they *are* own enumerable properties, so they appear in `Object.keys(err)`. |
| `details: null` | Serialized — `toJSON` drops the key only for `undefined`. |
| `JSON.stringify(err)` | Goes through `toJSON`: `{"name":"ForbiddenError","status":403,"message":"Forbidden"}`. Works nested and inside arrays. |
| `{...err}` | Yields `status`, `details`, `headers`, `name` — **not** `message` or `stack`, which are own but non-enumerable. Use `toJSON()`. |
| `HttpError.isHttpError({ status: 404 })` | `false`. Look-alikes and duck types do not pass; only real instances do. |
| `HttpError.isHttpError(null / undefined / new Error("boom"))` | `false`. |
| `NotFoundError.isHttpError(new ConflictError())` | `true` — the inherited static still checks against `HttpError`. |
| `createHttpError(418, "I'm a teapot")` | `err.constructor === HttpError`; status and message preserved. Unmapped statuses never throw. |
| `createHttpError(404)` | Statically typed `HttpError`, runtime `NotFoundError`, message `"Not Found"`. |
| `err.stack` | Contains the class name (`NotFoundError: nope`), because `this.name` is set before the stack string is first formatted. |
| `constructor.name` in the published bundle | The build emits `var HttpError = class _HttpError extends Error`, so `HttpError.name` is `"_HttpError"` in `dist`. Instance `.name` is unaffected. Compare by identity (`err.constructor === HttpError`) or read `err.name` / `err.status` — never `err.constructor.name`. |
| Duplicate copies of the package | `instanceof` is per-class-object: two installed copies mean `isHttpError` returns `false` across the boundary. Dedupe the dependency. |
