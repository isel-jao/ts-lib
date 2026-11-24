import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  type BackoffStrategy,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STRATEGY,
  ExponentialBackoff,
  FixedBackoff,
  LinearBackoff,
  withRetry,
} from "./index.js";

const delays = (strategy: BackoffStrategy, attempts: number) =>
  Array.from({ length: attempts }, (_, i) => strategy.delay(i + 1));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FixedBackoff", () => {
  it("returns the same delay for every attempt", () => {
    expect(delays(new FixedBackoff(500), 4)).toEqual([500, 500, 500, 500]);
  });

  it("allows a zero delay", () => {
    expect(delays(new FixedBackoff(0), 3)).toEqual([0, 0, 0]);
  });
});

describe("LinearBackoff", () => {
  it("grows by one step per attempt, starting at one step", () => {
    expect(delays(new LinearBackoff({ step: 100 }), 4)).toEqual([100, 200, 300, 400]);
  });

  it("caps the delay at max", () => {
    expect(delays(new LinearBackoff({ step: 100, max: 250 }), 4)).toEqual([100, 200, 250, 250]);
  });

  it("accepts max equal to step", () => {
    expect(delays(new LinearBackoff({ step: 100, max: 100 }), 3)).toEqual([100, 100, 100]);
  });

  it.each([0, -100])("throws when step is %d", (step) => {
    expect(() => new LinearBackoff({ step })).toThrow("Step must be greater than 0");
  });

  it.each([0, -100])("throws when max is %d", (max) => {
    expect(() => new LinearBackoff({ step: 100, max })).toThrow("Max must be greater than 0");
  });

  it("throws when max is below step", () => {
    expect(() => new LinearBackoff({ step: 100, max: 50 })).toThrow(
      "Max must be greater than or equal to step"
    );
  });
});

describe("ExponentialBackoff", () => {
  it("waits exactly base on the first retry, then doubles", () => {
    expect(delays(new ExponentialBackoff({ base: 100 }), 5)).toEqual([100, 200, 400, 800, 1600]);
  });

  it("grows without limit when max is omitted", () => {
    expect(new ExponentialBackoff({ base: 100 }).delay(21)).toBe(100 * 2 ** 20);
  });

  it("caps the delay at max", () => {
    expect(delays(new ExponentialBackoff({ base: 100, max: 300 }), 5)).toEqual([
      100, 200, 300, 300, 300,
    ]);
  });

  it("accepts max equal to base", () => {
    expect(delays(new ExponentialBackoff({ base: 100, max: 100 }), 3)).toEqual([100, 100, 100]);
  });

  it("does not use Math.random without jitter", () => {
    const random = vi.spyOn(Math, "random");

    delays(new ExponentialBackoff({ base: 100 }), 3);
    delays(new ExponentialBackoff({ base: 100, jitter: false }), 3);

    expect(random).not.toHaveBeenCalled();
  });

  it("scales the capped delay by Math.random() with jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(delays(new ExponentialBackoff({ base: 100, jitter: true }), 4)).toEqual([
      50, 100, 200, 400,
    ]);
  });

  it("applies the cap before the jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(new ExponentialBackoff({ base: 100, max: 300, jitter: true }).delay(10)).toBe(150);
  });

  it("produces jittered values in [0, capped delay) with the real Math.random", () => {
    const strategy = new ExponentialBackoff({ base: 100, max: 1000, jitter: true });
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = strategy.delay(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(Math.min(100 * 2 ** (attempt - 1), 1000));
    }
  });

  it.each([0, -100])("throws when base is %d", (base) => {
    expect(() => new ExponentialBackoff({ base })).toThrow("Base must be greater than 0");
  });

  it.each([0, -100])("throws when max is %d", (max) => {
    expect(() => new ExponentialBackoff({ base: 100, max })).toThrow("Max must be greater than 0");
  });

  it("throws when max is below base", () => {
    expect(() => new ExponentialBackoff({ base: 100, max: 50 })).toThrow(
      "Max must be greater than or equal to base"
    );
  });
});

describe("defaults", () => {
  it("allows 5 attempts", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
  });

  it("uses jittered exponential backoff from 100ms, capped at 5s", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(DEFAULT_STRATEGY).toBeInstanceOf(ExponentialBackoff);
    expect(delays(DEFAULT_STRATEGY, 8)).toEqual([50, 100, 200, 400, 800, 1600, 2500, 2500]);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  const alwaysFails = () => flaky(Number.POSITIVE_INFINITY);

  it("does not call the callback until the wrapper is invoked", () => {
    const callback = flaky(0);

    withRetry({ callback });

    expect(callback).not.toHaveBeenCalled();
  });

  it("resolves with the first result without waiting when the callback succeeds", async () => {
    const callback = flaky(0);
    const strategy = { delay: vi.fn(() => 1000) };
    const onRetry = vi.fn();

    await expect(withRetry({ callback, strategy, onRetry })()).resolves.toBe("ok");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(strategy.delay).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries until the callback succeeds", async () => {
    const callback = flaky(2);
    const result = withRetry({ callback, strategy: new FixedBackoff(100) })();

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok");
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("rethrows the last error once maxAttempts is reached", async () => {
    const callback = alwaysFails();
    const result = withRetry({ callback, strategy: new FixedBackoff(100), maxAttempts: 3 })();
    const assertion = expect(result).rejects.toThrow("fail 3");

    await vi.runAllTimersAsync();

    await assertion;
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("passes the wrapper's arguments to the callback on every attempt", async () => {
    let calls = 0;
    const callback = vi.fn(async (id: number, name: string) => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return `${id}:${name}`;
    });
    const result = withRetry({ callback, strategy: new FixedBackoff(0) })(7, "ada");

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("7:ada");
    expect(callback.mock.calls).toEqual([
      [7, "ada"],
      [7, "ada"],
      [7, "ada"],
    ]);
  });

  it("passes attempt numbers starting at 1 to the strategy", async () => {
    const strategy = { delay: vi.fn(() => 10) };
    const result = withRetry({ callback: alwaysFails(), strategy, maxAttempts: 4 })();
    const assertion = expect(result).rejects.toThrow();

    await vi.runAllTimersAsync();

    await assertion;
    expect(strategy.delay.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("waits the strategy's delay before each retry", async () => {
    const callback = flaky(2);
    const result = withRetry({ callback, strategy: new LinearBackoff({ step: 100 }) })();

    await vi.advanceTimersByTimeAsync(99);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(callback).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toBe("ok");
  });

  it("calls onRetry with the attempt, delay and error before waiting", async () => {
    const callback = flaky(2);
    const onRetry = vi.fn();
    const result = withRetry({ callback, strategy: new LinearBackoff({ step: 100 }), onRetry })();

    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok");
    expect(onRetry.mock.calls).toEqual([
      [{ attempt: 1, delay: 100, error: new Error("fail 1") }],
      [{ attempt: 2, delay: 200, error: new Error("fail 2") }],
    ]);
  });

  it("does not call onRetry after the final failure", async () => {
    const onRetry = vi.fn();
    const result = withRetry({
      callback: alwaysFails(),
      strategy: new FixedBackoff(0),
      maxAttempts: 3,
      onRetry,
    })();
    const assertion = expect(result).rejects.toThrow("fail 3");

    await vi.runAllTimersAsync();

    await assertion;
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("rejects with the onRetry error and stops retrying when onRetry throws", async () => {
    const callback = alwaysFails();
    const hookError = new Error("hook");
    const onRetry = vi.fn(() => {
      throw hookError;
    });
    const result = withRetry({ callback, strategy: new FixedBackoff(0), onRetry })();
    const assertion = expect(result).rejects.toBe(hookError);

    await vi.runAllTimersAsync();

    await assertion;
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("rejects with the strategy error without calling onRetry when the strategy throws", async () => {
    const callback = alwaysFails();
    const strategyError = new Error("strategy");
    const strategy = {
      delay: () => {
        throw strategyError;
      },
    };
    const onRetry = vi.fn();

    await expect(withRetry({ callback, strategy, onRetry })()).rejects.toBe(strategyError);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("defaults maxAttempts to DEFAULT_MAX_ATTEMPTS", async () => {
    const callback = alwaysFails();
    const result = withRetry({ callback, strategy: new FixedBackoff(0) })();
    const assertion = expect(result).rejects.toThrow(`fail ${DEFAULT_MAX_ATTEMPTS}`);

    await vi.runAllTimersAsync();

    await assertion;
    expect(callback).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
  });

  it("defaults the strategy to DEFAULT_STRATEGY", async () => {
    const delay = vi.spyOn(DEFAULT_STRATEGY, "delay").mockReturnValue(0);
    const result = withRetry({ callback: flaky(2) })();

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok");
    expect(delay.mock.calls).toEqual([[1], [2]]);
  });

  it("resolves a synchronous callback's return value", async () => {
    const add = withRetry({ callback: (a: number, b: number) => a + b });

    await expect(add(2, 3)).resolves.toBe(5);
  });

  it("retries a callback that throws synchronously", async () => {
    let calls = 0;
    const callback = vi.fn(() => {
      calls++;
      if (calls === 1) throw new Error("sync");
      return "ok";
    });
    const result = withRetry({ callback, strategy: new FixedBackoff(0) })();

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok");
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-Error rejections as-is", async () => {
    const reason = { code: 503 };
    const callback = vi.fn(() => Promise.reject(reason));
    const result = withRetry({ callback, strategy: new FixedBackoff(0), maxAttempts: 2 })();
    const assertion = expect(result).rejects.toBe(reason);

    await vi.runAllTimersAsync();

    await assertion;
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not retry when maxAttempts is 1", async () => {
    const callback = alwaysFails();
    const onRetry = vi.fn();

    await expect(withRetry({ callback, maxAttempts: 1, onRetry })()).rejects.toThrow("fail 1");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("still calls the callback once when maxAttempts is 0 or negative", async () => {
    const callback = alwaysFails();

    await expect(withRetry({ callback, maxAttempts: 0 })()).rejects.toThrow("fail 1");
    await expect(withRetry({ callback, maxAttempts: -3 })()).rejects.toThrow("fail 2");
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN])(
    "keeps retrying past the default limit when maxAttempts is %d",
    async (maxAttempts) => {
      const callback = flaky(10);
      const result = withRetry({ callback, strategy: new FixedBackoff(0), maxAttempts })();

      await vi.runAllTimersAsync();

      await expect(result).resolves.toBe("ok");
      expect(callback).toHaveBeenCalledTimes(11);
    }
  );

  it("gives every call of the wrapper its own attempts", async () => {
    const callback = alwaysFails();
    const retrying = withRetry({ callback, strategy: new FixedBackoff(10), maxAttempts: 3 });
    const assertions = [retrying(), retrying()].map((result) => expect(result).rejects.toThrow());

    await vi.runAllTimersAsync();

    await Promise.all(assertions);
    expect(callback).toHaveBeenCalledTimes(6);
  });

  it("reads options once, when the wrapper is created", async () => {
    const options = { callback: alwaysFails(), strategy: new FixedBackoff(0), maxAttempts: 2 };
    const retrying = withRetry(options);
    options.maxAttempts = 10;
    const result = retrying();
    const assertion = expect(result).rejects.toThrow("fail 2");

    await vi.runAllTimersAsync();

    await assertion;
    expect(options.callback).toHaveBeenCalledTimes(2);
  });

  it("calls the callback without a this binding", async () => {
    const callback = vi.fn(function (this: unknown) {
      return this;
    });

    await expect(withRetry({ callback })()).resolves.toBeUndefined();
  });

  it("types the wrapper after the callback", () => {
    expectTypeOf(withRetry({ callback: async (id: number) => ({ id }) })).toEqualTypeOf<
      (id: number) => Promise<{ id: number }>
    >();
    expectTypeOf(withRetry({ callback: (a: number, b: string) => `${a}${b}` })).toEqualTypeOf<
      (a: number, b: string) => Promise<string>
    >();
  });
});
