# backoff

Retries an async operation, waiting between attempts according to a pluggable backoff strategy. `withRetry(() => fetch(url))` tries up to 5 times with jittered exponential delays.

Use it for anything that fails transiently and is safe to call again: network requests, a database that is still starting, a rate-limited API, a file lock held by another process.

## Why

A retry loop is a few lines, and that is the problem. It gets written inline, slightly differently each time, with the delay policy tangled into the loop:

```ts
for (let i = 0; i < 5; i++) {
  try {
    return await fetchUser();
  } catch {
    await sleep(500 * 2 ** i);
  }
}
```

That version has two common bugs. It swallows the final error and returns `undefined`, and every client that failed at the same moment retries at the same moment too, so a struggling server gets hit by synchronized waves.

This module splits the loop into two parts:

- **The retry loop**, `withRetry`, written once. It calls, catches, waits, and rethrows the last error when it runs out of attempts.
- **The delay policy**, a `BackoffStrategy`: a plain `(attempt) => ms` function. Swapping the policy never touches the loop, and a custom policy is one arrow function.

The default policy is exponential backoff with full jitter, which is the safe choice when you do not know who else is retrying against the same service.

## How it works

```ts
for (let attempt = 1; ; attempt++) {
  try {
    return await fn();
  } catch (err) {
    if (attempt >= maxAttempts) throw err;
    await sleep(backoff(attempt));
  }
}
```

**`attempt` counts retries, starting at 1.** The strategy is asked for a delay only after a failure, so `backoff(1)` is the wait before the second call, `backoff(2)` the wait before the third, and so on. With `maxAttempts: 5`, the strategy is called at most 4 times.

**The last error is rethrown unchanged.** It is not wrapped, aggregated, or converted to an `Error`, so a rejection with `{ code: 503 }` comes out as that same object. Earlier errors are discarded.

**Synchronous throws are retried too.** `fn` is called inside the `try`, so an `fn` that throws before returning a promise is handled the same as one that rejects.

**`maxAttempts` is a total, not a retry count.** `maxAttempts: 1` means one call and no retries. Values below 1 behave like 1, because `fn` is always called at least once.

**Every error is retried.** There is no way yet to stop early on an error that will never succeed, like a 404. If you need that, check inside `fn` and return or throw a value your caller handles, or keep `maxAttempts` low.

**Delays come from `setTimeout`.** A strategy returning `0` or a negative number still yields to the event loop once before the next attempt. Delays above about 24.8 days overflow `setTimeout` and fire immediately, which the strategies' `max` cap prevents in practice.

### Strategies

Each strategy is a factory: you call it with its settings and get back a `BackoffStrategy`.

| Strategy | Delay before retry `n` | `base = 100`, retries 1–5 |
| --- | --- | --- |
| `fixedBackoff(ms)` | `ms` | 100, 100, 100, 100, 100 |
| `linearBackoff(step)` | `step * n` | 100, 200, 300, 400, 500 |
| `exponentialBackoff(base, max)` | `min(base * 2^(n-1), max)` | 100, 200, 400, 800, 1600 |
| `exponentialJitterBackoff(base, max)` | `random() * min(base * 2^(n-1), max)` | a random value in each of `[0, 100)`, `[0, 200)`, … |

`max` defaults to 30 seconds for both exponential strategies. The jitter strategy applies the cap first and the randomness second, so its delay is always below `max`.

## API

### `withRetry`

```ts
function withRetry<T>(fn: () => Promise<T>, options?: WithRetryOptions): Promise<T>;
```

- `fn` — the operation to run. Called once, then again after each failure until it resolves or attempts run out.
- `options.backoff` — the delay policy. Defaults to `exponentialJitterBackoff(200)`.
- `options.maxAttempts` — total calls to `fn`, including the first. Defaults to `5`.

Resolves with the first successful result of `fn`. Rejects with the error from the last attempt.

### Strategy factories

```ts
function fixedBackoff(ms: number): BackoffStrategy;
function linearBackoff(step: number): BackoffStrategy;
function exponentialBackoff(base: number, max?: number): BackoffStrategy;
function exponentialJitterBackoff(base: number, max?: number): BackoffStrategy;
```

### Types

```ts
type BackoffStrategy = (attempt: number) => number;

type WithRetryOptions = {
  backoff?: BackoffStrategy;
  maxAttempts?: number;
};
```

## Usage

```ts
import { withRetry } from "@isel-jao/ts-lib";

// Defaults: 5 attempts, exponential backoff with jitter starting at 200ms
const user = await withRetry(() => fetch("/api/user").then((r) => r.json()));
```

Picking a strategy per call:

```ts
import { exponentialJitterBackoff, fixedBackoff, withRetry } from "@isel-jao/ts-lib";

// A local service that is just starting up: poll at a steady pace
await withRetry(() => db.ping(), { backoff: fixedBackoff(250), maxAttempts: 20 });

// A shared, rate-limited API: back off hard and spread clients out
const report = await withRetry(() => fetch("/api/heavy-report").then((r) => r.json()), {
  backoff: exponentialJitterBackoff(1000, 10_000),
  maxAttempts: 3,
});
```

One policy shared across many calls:

```ts
import { exponentialJitterBackoff, withRetry, type WithRetryOptions } from "@isel-jao/ts-lib";

const apiRetry: WithRetryOptions = { backoff: exponentialJitterBackoff(500), maxAttempts: 3 };

await withRetry(fetchUser, apiRetry);
await withRetry(fetchOrders, apiRetry);
```

A custom strategy is just a function:

```ts
import { type BackoffStrategy, withRetry } from "@isel-jao/ts-lib";

// Fibonacci delays: 100, 100, 200, 300, 500, …
const fibonacciBackoff =
  (unit: number): BackoffStrategy =>
  (attempt) => {
    let [a, b] = [1, 1];
    for (let i = 1; i < attempt; i++) [a, b] = [b, a + b];
    return unit * a;
  };

await withRetry(sendWebhook, { backoff: fibonacciBackoff(100) });
```

`fetch` only rejects on network failures, not on HTTP error statuses. To retry on a 503, throw for it inside `fn`:

```ts
await withRetry(async () => {
  const res = await fetch(url);
  if (res.status >= 500) throw new Error(`server error ${res.status}`);
  return res.json();
});
```

## Edge cases

| Input | Result |
| --- | --- |
| `fn` succeeds on the first call | resolved immediately, strategy never called |
| `fn` never succeeds | rejects with the last attempt's error |
| `fn` throws synchronously | retried like a rejection |
| `fn` rejects with a non-`Error` value | that exact value is rethrown |
| `options` omitted or `{}` | 5 attempts, `exponentialJitterBackoff(200)` |
| `maxAttempts: 1` | one call, no retries |
| `maxAttempts` of `0` or negative | treated as `1` |
| strategy returns `0` or a negative number | next attempt after one event-loop turn |
| `base` larger than `max` | every delay is `max` |
| options object | never mutated; safe to share between calls |
