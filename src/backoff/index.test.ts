import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exponentialBackoff,
  exponentialJitterBackoff,
  fixedBackoff,
  linearBackoff,
  withRetry,
} from "./index.js";

const delays = (strategy: (attempt: number) => number, attempts: number) =>
  Array.from({ length: attempts }, (_, i) => strategy(i + 1));

describe("fixedBackoff", () => {
  it("returns the same delay for every attempt", () => {
    expect(delays(fixedBackoff(500), 4)).toEqual([500, 500, 500, 500]);
  });

  it("allows a zero delay", () => {
    expect(delays(fixedBackoff(0), 3)).toEqual([0, 0, 0]);
  });
});

describe("linearBackoff", () => {
  it("grows by one step per attempt, starting at one step", () => {
    expect(delays(linearBackoff(100), 4)).toEqual([100, 200, 300, 400]);
  });
});

describe("exponentialBackoff", () => {
  it("waits exactly base on the first retry, then doubles", () => {
    expect(delays(exponentialBackoff(100), 5)).toEqual([100, 200, 400, 800, 1600]);
  });

  it("caps the delay at max", () => {
    expect(delays(exponentialBackoff(100, 300), 5)).toEqual([100, 200, 300, 300, 300]);
  });

  it("defaults max to 30 seconds", () => {
    expect(exponentialBackoff(1000)(10)).toBe(30_000);
    expect(exponentialBackoff(1000)(100)).toBe(30_000);
  });

  it("returns max on the first retry when base exceeds it", () => {
    expect(exponentialBackoff(5000, 1000)(1)).toBe(1000);
  });
});

describe("exponentialJitterBackoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scales the capped exponential delay by Math.random()", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(delays(exponentialJitterBackoff(100), 4)).toEqual([50, 100, 200, 400]);
  });

  it("stays within [0, capped delay)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(exponentialJitterBackoff(100)(3)).toBe(0);

    vi.spyOn(Math, "random").mockReturnValue(0.999);
    expect(exponentialJitterBackoff(100)(3)).toBeLessThan(400);
  });

  it("applies the cap before the jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(exponentialJitterBackoff(100, 300)(10)).toBe(300);
  });

  it("produces values in range with the real Math.random", () => {
    const strategy = exponentialJitterBackoff(100, 1000);
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = strategy(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(Math.min(100 * 2 ** (attempt - 1), 1000));
    }
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Fails `failures` times with Error("fail <n>"), then resolves to "ok".
  const flaky = (failures: number) => {
    let calls = 0;
    return vi.fn(async () => {
      calls++;
      if (calls <= failures) throw new Error(`fail ${calls}`);
      return "ok";
    });
  };

  it("returns the first result without waiting when fn succeeds", async () => {
    const fn = flaky(0);
    const backoff = vi.fn(fixedBackoff(1000));

    await expect(withRetry(fn, { backoff })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(backoff).not.toHaveBeenCalled();
  });

  it("retries until fn succeeds", async () => {
    const fn = flaky(2);
    const result = withRetry(fn, { backoff: fixedBackoff(100) });

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows the last error once maxAttempts is reached", async () => {
    const fn = flaky(Number.POSITIVE_INFINITY);
    const result = withRetry(fn, { backoff: fixedBackoff(100), maxAttempts: 3 });
    const assertion = expect(result).rejects.toThrow("fail 3");

    await vi.runAllTimersAsync();

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("passes attempt numbers starting at 1 to the strategy", async () => {
    const backoff = vi.fn(fixedBackoff(10));
    const result = withRetry(flaky(Number.POSITIVE_INFINITY), { backoff, maxAttempts: 4 });
    const assertion = expect(result).rejects.toThrow();

    await vi.runAllTimersAsync();

    await assertion;
    expect(backoff.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("waits the strategy's delay before each retry", async () => {
    const fn = flaky(2);
    const result = withRetry(fn, { backoff: linearBackoff(100) });

    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toBe("ok");
  });

  it("defaults maxAttempts to 5", async () => {
    const fn = flaky(Number.POSITIVE_INFINITY);
    const result = withRetry(fn, { backoff: fixedBackoff(0) });
    const assertion = expect(result).rejects.toThrow("fail 5");

    await vi.runAllTimersAsync();

    await assertion;
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("defaults backoff to exponentialJitterBackoff(200)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fn = flaky(2);
    const result = withRetry(fn);

    // 0.5 * 200 = 100ms before the second call
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // 0.5 * 400 = 200ms before the third call
    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toBe("ok");
  });

  it("accepts an empty options object", async () => {
    await expect(withRetry(flaky(0), {})).resolves.toBe("ok");
  });

  it("does not retry when maxAttempts is 1", async () => {
    const fn = flaky(Number.POSITIVE_INFINITY);

    await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow("fail 1");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still calls fn once when maxAttempts is 0 or negative", async () => {
    const fn = flaky(Number.POSITIVE_INFINITY);

    await expect(withRetry(fn, { maxAttempts: 0 })).rejects.toThrow("fail 1");
    await expect(withRetry(fn, { maxAttempts: -3 })).rejects.toThrow("fail 2");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries an fn that throws synchronously", async () => {
    let calls = 0;
    const fn = vi.fn((): Promise<string> => {
      calls++;
      if (calls === 1) throw new Error("sync");
      return Promise.resolve("ok");
    });
    const result = withRetry(fn, { backoff: fixedBackoff(0) });

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-Error rejections as-is", async () => {
    const reason = { code: 503 };
    const fn = vi.fn(() => Promise.reject(reason));
    const result = withRetry(fn, { backoff: fixedBackoff(0), maxAttempts: 2 });
    const assertion = expect(result).rejects.toBe(reason);

    await vi.runAllTimersAsync();

    await assertion;
  });

  it("shares one options object across calls without mutating it", async () => {
    const options = { backoff: fixedBackoff(0), maxAttempts: 3 };
    const first = withRetry(flaky(1), options);
    const second = withRetry(flaky(2), options);

    await vi.runAllTimersAsync();

    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
    expect(options).toEqual({ backoff: options.backoff, maxAttempts: 3 });
  });
});
