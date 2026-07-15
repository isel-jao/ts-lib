import { describe, expect, it } from "vitest";
import { createAsyncFunction, createSyncFunction } from "./index";

describe("createSyncFunction", () => {
  it("executes the doc body and returns the result", () => {
    const fn = createSyncFunction("return 1 + 1;");
    expect(fn()).toBe(2);
  });

  it("exposes call arguments as the args rest parameter", () => {
    const fn = createSyncFunction("return args[0] + args[1];");
    expect(fn(3, 4)).toBe(7);
  });

  it("exposes context values by name", () => {
    const fn = createSyncFunction("return a + b;", { a: 1, b: 2 });
    expect(fn()).toBe(3);
  });

  it("combines context values and call arguments", () => {
    const fn = createSyncFunction("return a + args[0];", { a: 10 });
    expect(fn(5)).toBe(15);
  });

  it("defaults context to an empty object", () => {
    const fn = createSyncFunction("return args.length;");
    expect(fn(1, 2, 3)).toBe(3);
  });

  it("returns undefined when the doc has no return statement", () => {
    const fn = createSyncFunction("const x = 1;");
    expect(fn()).toBeUndefined();
  });

  it("propagates errors thrown in the doc body", () => {
    const fn = createSyncFunction('throw new Error("boom");');
    expect(() => fn()).toThrow("boom");
  });

  it("supports functions passed via context", () => {
    const fn = createSyncFunction("return double(args[0]);", {
      double: (n: number) => n * 2,
    });
    expect(fn(6)).toBe(12);
  });

  it("can be called multiple times with different arguments", () => {
    const fn = createSyncFunction("return args[0] * 2;");
    expect(fn(2)).toBe(4);
    expect(fn(5)).toBe(10);
  });
});

describe("createAsyncFunction", () => {
  it("returns a promise", () => {
    const fn = createAsyncFunction("return 1;");
    expect(fn()).toBeInstanceOf(Promise);
  });

  it("resolves with the returned value", async () => {
    const fn = createAsyncFunction("return 1 + 1;");
    await expect(fn()).resolves.toBe(2);
  });

  it("awaits promises used inside the doc body", async () => {
    const fn = createAsyncFunction("return await Promise.resolve(args[0]);");
    await expect(fn(42)).resolves.toBe(42);
  });

  it("exposes context values by name", async () => {
    const fn = createAsyncFunction("return a + b;", { a: 1, b: 2 });
    await expect(fn()).resolves.toBe(3);
  });

  it("exposes call arguments as the args rest parameter", async () => {
    const fn = createAsyncFunction("return args[0] + args[1];");
    await expect(fn(3, 4)).resolves.toBe(7);
  });

  it("combines context values and call arguments", async () => {
    const fn = createAsyncFunction("return a + args[0];", { a: 10 });
    await expect(fn(5)).resolves.toBe(15);
  });

  it("defaults context to an empty object", async () => {
    const fn = createAsyncFunction("return args.length;");
    await expect(fn(1, 2, 3)).resolves.toBe(3);
  });

  it("rejects when the doc body throws synchronously", async () => {
    const fn = createAsyncFunction('throw new Error("boom");');
    await expect(fn()).rejects.toThrow("boom");
  });

  it("rejects when an awaited promise rejects", async () => {
    const fn = createAsyncFunction('return await Promise.reject(new Error("nope"));');
    await expect(fn()).rejects.toThrow("nope");
  });

  it("supports functions passed via context", async () => {
    const fn = createAsyncFunction("return double(args[0]);", {
      double: (n: number) => n * 2,
    });
    await expect(fn(6)).resolves.toBe(12);
  });
});
