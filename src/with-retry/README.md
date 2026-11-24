# with-retry

Wraps a function so that failed calls are retried, waiting between attempts according to a pluggable backoff strategy. `withRetry({ callback: fetchUser })` returns a function with `fetchUser`'s parameters that tries up to 5 times with jittered exponential delays.

Use it for anything that fails transiently and is safe to call again: network requests, a database that is still starting, a rate-limited API, a file lock held by another process.

## Why

A retry loop is a few lines, and that is the problem. It gets written inline at every call site, slightly differently each time, with the delay policy tangled into the loop:

```ts
for (let i = 0; i < 5; i++) {
  try {
    return await fetchUser(id);
  } catch {
    await sleep(500 * 2 ** i);
  }
}
```

That version has three common bugs. It swallows the final error and returns `undefined`. It hides every failure it absorbs, so nobody notices the service is flaky until it fails outright. And every client that failed at the same moment retries at the same moment too, so a struggling server gets hit by synchronized waves.

This module splits the loop into three parts:

- **The retry loop**, written once. It calls, catches, waits, reports each retry to an optional `onRetry` hook, and rethrows the last error when it runs out of attempts.
- **The delay policy**, a `BackoffStrategy`: any object with a `delay(attempt)` method. Swapping the policy never touches the loop. The built-in strategies check their options when constructed, and a custom one is an object literal.
- **The wrapper.** `withRetry` takes the function and returns a retrying version with the same parameters. You choose the policy once, where the function is defined, and call sites just call it.

The default policy is exponential backoff with full jitter, which is the safe choice when you do not know who else is retrying against the same service.

## How it works

```ts
return async (...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Promise.try(callback, ...args);
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      const delay = strategy.delay(attempt);
      onRetry?.({ attempt, delay, error });
      await sleep(delay);
    }
  }
};
```

**Options are read once.** `withRetry` reads its options when you call it, not each time the wrapper runs. Changing the options object afterwards has no effect on a wrapper that already exists.

**Each call gets its own attempts.** The wrapper starts again at attempt 1 every time you call it, and concurrent calls retry independently. The only thing they share is the strategy object.

**Arguments are passed through unchanged.** Every attempt calls `callback` with the arguments the wrapper received. The callback is called without a `this`, so pass methods bound or wrapped in an arrow function.

**`attempt` is the number of the attempt that just failed.** The strategy is asked for a delay only after a failure, so `delay(1)` is the wait before the second call, `delay(2)` the wait before the third, and so on. With `maxAttempts: 5`, the strategy is called at most 4 times.

**`onRetry` runs between the failure and the wait.** It receives the failed attempt's number, the delay about to be waited, and the error. It is not called after the final failure, because no retry follows; that error goes to your caller instead. If `onRetry` or the strategy throws, the wrapper rejects with that error and stops retrying.

**The last error is rethrown unchanged.** It is not wrapped, aggregated, or converted to an `Error`, so a rejection with `{ code: 503 }` comes out as that same object. Earlier errors are discarded, so use `onRetry` if you need them.

**Sync and async callbacks behave the same.** `Promise.try` turns a synchronous throw into a rejection and a plain return value into a resolved promise. A sync callback is retried like an async one, and the wrapper always returns a promise.

**`maxAttempts` is a total, not a retry count.** `maxAttempts: 1` means one call and no retries. Values below 1 behave like 1, because the callback is always called at least once. `Infinity` retries until the callback succeeds, and so does `NaN`, because `attempt >= NaN` is never true.

**Every error is retried.** There is no way yet to stop early on an error that will never succeed, like a 404. If you need that, handle it inside the callback and return a value your caller checks, or keep `maxAttempts` low.

**Delays come from `setTimeout`.** A delay of `0` or less still yields to the event loop once before the next attempt. Delays above 2³¹ − 1 ms (about 24.8 days) overflow `setTimeout` and fire almost immediately. Node prints a `TimeoutNegativeWarning` or `TimeoutOverflowWarning` in those cases. An `ExponentialBackoff` with `base: 100` and no `max` crosses the overflow line at attempt 26, so set `max` whenever `maxAttempts` is large.

### Strategies

Each strategy is a class: construct it with its settings and pass the instance as `strategy`.

| Strategy | Delay before retry `n` | `100` as `ms`/`step`/`base`, retries 1–5 |
| --- | --- | --- |
| `new FixedBackoff(ms)` | `ms` | 100, 100, 100, 100, 100 |
| `new LinearBackoff({ step, max })` | `min(step * n, max)` | 100, 200, 300, 400, 500 |
| `new ExponentialBackoff({ base, max })` | `min(base * 2^(n-1), max)` | 100, 200, 400, 800, 1600 |
| `new ExponentialBackoff({ base, max, jitter: true })` | `random() * min(base * 2^(n-1), max)` | a random value in each of `[0, 100)`, `[0, 200)`, … |

`max` is optional for both `LinearBackoff` and `ExponentialBackoff`; without it, delays grow without limit. With `jitter`, the cap is applied first and the randomness second, so a jittered delay is always below `max`.

`LinearBackoff` and `ExponentialBackoff` validate their options in the constructor and throw an `Error` straight away, rather than producing nonsense delays later:

| Constructor | Throws when | Message |
| --- | --- | --- |
| `LinearBackoff` | `step <= 0` | `Step must be greater than 0` |
| `LinearBackoff` | `max <= 0` | `Max must be greater than 0` |
| `LinearBackoff` | `max < step` | `Max must be greater than or equal to step` |
| `ExponentialBackoff` | `base <= 0` | `Base must be greater than 0` |
| `ExponentialBackoff` | `max <= 0` | `Max must be greater than 0` |
| `ExponentialBackoff` | `max < base` | `Max must be greater than or equal to base` |

`FixedBackoff` does no validation. A negative `ms` waits as if it were `0`, but `onRetry` still reports the negative value.

Strategies hold no state between calls, so one instance can be shared by any number of wrappers. `DEFAULT_STRATEGY` is exactly that: a single shared `ExponentialBackoff`.

## API

### `withRetry`

```ts
function withRetry<Args extends unknown[], Result>(
  options: WithRetryOptions<Args, Result>
): (...args: Args) => Promise<Awaited<Result>>;
```

- `options.callback` is the function to retry. It can be sync or async, and its parameters become the wrapper's parameters.
- `options.maxAttempts` is the total number of calls per invocation of the wrapper, including the first. Defaults to `DEFAULT_MAX_ATTEMPTS` (5).
- `options.strategy` is the delay policy. Defaults to `DEFAULT_STRATEGY`.
- `options.onRetry` is called after each failure that will be retried, with `{ attempt, delay, error }`.

Returns a function that takes the same arguments as `callback` and passes them on to every attempt. It resolves with the first successful result (unwrapped, if `callback` returned a promise) and rejects with the error from the last attempt.

### Strategy classes

```ts
class FixedBackoff implements BackoffStrategy {
  constructor(ms: number);
}

class LinearBackoff implements BackoffStrategy {
  constructor(options: LinearBackoffOptions);
}

class ExponentialBackoff implements BackoffStrategy {
  constructor(options: ExponentialBackoffOptions);
}
```

### Constants

```ts
const DEFAULT_MAX_ATTEMPTS = 5;

// new ExponentialBackoff({ base: 100, max: 5_000, jitter: true })
const DEFAULT_STRATEGY: BackoffStrategy;
```

### Types

```ts
interface BackoffStrategy {
  delay(attempt: number): number;
}

interface LinearBackoffOptions {
  step: number;
  max?: number;
}

interface ExponentialBackoffOptions {
  base: number;
  max?: number;
  jitter?: boolean;
}

interface WithRetryOptions<Args extends unknown[], Result> {
  callback: (...args: Args) => Result;
  maxAttempts?: number;
  strategy?: BackoffStrategy;
  onRetry?: (options: { attempt: number; delay: number; error: unknown }) => void;
}
```

## Usage

```ts
import { withRetry } from "@isel-jao/ts-lib";

// Defaults: 5 attempts, jittered exponential backoff from 100ms, capped at 5s
const getUser = withRetry({
  callback: async (id: string) => {
    const res = await fetch(`/api/users/${id}`);
    // fetch only rejects on network failures; throw for the statuses worth retrying
    if (res.status >= 500) throw new Error(`server error ${res.status}`);
    return res.json();
  },
});

const user = await getUser("42");
```

Picking a strategy per function:

```ts
import { ExponentialBackoff, FixedBackoff, withRetry } from "@isel-jao/ts-lib";

// A local service that is just starting up: poll at a steady pace
const waitForDb = withRetry({
  callback: () => db.ping(),
  strategy: new FixedBackoff(250),
  maxAttempts: 20,
});
await waitForDb();

// A shared, rate-limited API: back off hard and spread clients out
const getReport = withRetry({
  callback: (month: string) => api.getReport(month),
  strategy: new ExponentialBackoff({ base: 1000, max: 10_000, jitter: true }),
  maxAttempts: 3,
});
const report = await getReport("2026-10");
```

Logging the failures that retries absorb:

```ts
const sendWebhook = withRetry({
  callback: postWebhook,
  onRetry: ({ attempt, delay, error }) => {
    logger.warn(`webhook attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`, error);
  },
});
```

One policy shared across many functions:

```ts
import { ExponentialBackoff, withRetry } from "@isel-jao/ts-lib";

const apiPolicy = {
  strategy: new ExponentialBackoff({ base: 500, max: 8_000, jitter: true }),
  maxAttempts: 3,
};

const getUser = withRetry({ ...apiPolicy, callback: fetchUser });
const getOrders = withRetry({ ...apiPolicy, callback: fetchOrders });
```

Methods need their `this` bound:

```ts
const save = withRetry({ callback: repo.save.bind(repo) });
const load = withRetry({ callback: (id: string) => repo.load(id) });
```

A custom strategy is any object with a `delay` method:

```ts
import { type BackoffStrategy, withRetry } from "@isel-jao/ts-lib";

// Fibonacci delays: 100, 100, 200, 300, 500, …
const fibonacciBackoff = (unit: number): BackoffStrategy => ({
  delay(attempt) {
    let [a, b] = [1, 1];
    for (let i = 1; i < attempt; i++) [a, b] = [b, a + b];
    return unit * a;
  },
});

const send = withRetry({ callback: sendWebhook, strategy: fibonacciBackoff(100) });
```

## Migrating from `backoff`

`with-retry` replaces the `backoff` module in the package exports. The retry loop works the same way; the API shape is different: `withRetry` now wraps a function instead of running a thunk, and strategies are classes instead of factory functions.

| `backoff` | `with-retry` |
| --- | --- |
| `await withRetry(() => fetchUser(id), { maxAttempts: 3 })` | `await withRetry({ callback: fetchUser, maxAttempts: 3 })(id)` |
| `{ backoff: fixedBackoff(ms) }` | `{ strategy: new FixedBackoff(ms) }` |
| `{ backoff: linearBackoff(step) }` | `{ strategy: new LinearBackoff({ step }) }` |
| `{ backoff: exponentialBackoff(base, max) }` | `{ strategy: new ExponentialBackoff({ base, max }) }` |
| `{ backoff: exponentialJitterBackoff(base, max) }` | `{ strategy: new ExponentialBackoff({ base, max, jitter: true }) }` |
| custom `(attempt) => ms` | `{ delay: (attempt) => ms }` |

Two defaults changed. The default strategy starts at 100ms and caps at 5s, where `backoff` started at 200ms and capped at 30s. And `ExponentialBackoff` has no `max` unless you pass one, where `backoff`'s exponential strategies defaulted to 30s.

## Edge cases

| Input | Result |
| --- | --- |
| callback succeeds on the first call | resolves immediately; strategy and `onRetry` never called |
| callback never succeeds | rejects with the last attempt's error after `maxAttempts` calls |
| callback throws synchronously | retried like a rejection |
| callback returns a plain value | wrapper resolves with that value |
| callback rejects with a non-`Error` value | that exact value is rethrown |
| callback is an unbound method | called with `this` undefined; bind it first |
| `maxAttempts: 1` | one call, no retries, `onRetry` never called |
| `maxAttempts` of `0` or negative | treated as `1` |
| `maxAttempts` of `Infinity` or `NaN` | retries until the callback succeeds |
| `onRetry` throws | wrapper rejects with that error; no further attempts |
| strategy's `delay` throws | wrapper rejects with that error; `onRetry` not called |
| delay of `0` or negative | next attempt after one event-loop turn |
| delay above 2³¹ − 1 ms | overflows `setTimeout`; next attempt almost immediately |
| options object changed after `withRetry` | no effect on that wrapper |
| strategy's options object changed after construction | the strategy keeps a reference, so delays change and the new values skip validation |
| `step`, `base` or `max` out of range | constructor throws (see [Strategies](#strategies)) |
| `max` equal to `step` or `base` | allowed; every delay is `max` (before jitter) |
