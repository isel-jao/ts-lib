// A strategy is just "given the attempt number, how long to wait?"
// `attempt` is 1 for the first retry, 2 for the second, and so on.
export type BackoffStrategy = (attempt: number) => number;

export const fixedBackoff =
  (ms: number): BackoffStrategy =>
  () =>
    ms;

export const linearBackoff =
  (step: number): BackoffStrategy =>
  (attempt) =>
    step * attempt;

// First retry waits exactly `base`, then doubles each time, capped at `max`
export const exponentialBackoff =
  (base: number, max = 30_000): BackoffStrategy =>
  (attempt) =>
    Math.min(base * 2 ** (attempt - 1), max);

// Randomness spreads retries out so thousands of clients don't hit the server at once
export const exponentialJitterBackoff =
  (base: number, max = 30_000): BackoffStrategy =>
  (attempt) =>
    Math.random() * Math.min(base * 2 ** (attempt - 1), max);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type WithRetryOptions = {
  // Defaults to exponentialJitterBackoff(200).
  backoff?: BackoffStrategy;
  // Total tries, including the first call. Defaults to 5.
  maxAttempts?: number;
};

// The context: retry logic written once, works with any strategy
export async function withRetry<T>(
  fn: () => Promise<T>,
  { backoff = exponentialJitterBackoff(200), maxAttempts = 5 }: WithRetryOptions = {}
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await sleep(backoff(attempt));
    }
  }
}

// Usage: same retry logic, different behavior per use case
// const user = await withRetry(() => fetch("/api/user").then((r) => r.json()), {
//   backoff: fixedBackoff(500),
// });

// const report = await withRetry(() => fetch("/api/heavy-report").then((r) => r.json()), {
//   backoff: exponentialJitterBackoff(1000),
//   maxAttempts: 3,
// });
