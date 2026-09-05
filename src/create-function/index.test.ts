import { describe, expect, it } from "vitest";
import { createAsyncFunction, createSyncFunction } from "./index";

describe("createSyncFunction", () => {
  it("executes the doc body and returns the result", () => {
    const fn = createSyncFunction({ doc: "return 1 + 1;" });
    expect(fn()).toBe(2);
  });

  it("exposes declared params by name", () => {
    const fn = createSyncFunction({ doc: "return a + b;", params: ["a", "b"] });
    expect(fn(3, 4)).toBe(7);
  });

  it("exposes context values by name", () => {
    const fn = createSyncFunction({ doc: "return a + b;", context: { a: 1, b: 2 } });
    expect(fn()).toBe(3);
  });

  it("combines context values and declared params", () => {
    const fn = createSyncFunction({ doc: "return a + x;", context: { a: 10 }, params: ["x"] });
    expect(fn(5)).toBe(15);
  });

  it("defaults context and params to empty", () => {
    const fn = createSyncFunction({ doc: "return 42;" });
    expect(fn()).toBe(42);
  });

  it("returns undefined when the doc has no return statement", () => {
    const fn = createSyncFunction({ doc: "const x = 1;" });
    expect(fn()).toBeUndefined();
  });

  it("propagates errors thrown in the doc body", () => {
    const fn = createSyncFunction({ doc: 'throw new Error("boom");' });
    expect(() => fn()).toThrow("boom");
  });

  it("supports functions passed via context", () => {
    const fn = createSyncFunction({
      doc: "return double(n);",
      context: { double: (n: number) => n * 2 },
      params: ["n"],
    });
    expect(fn(6)).toBe(12);
  });

  it("can be called multiple times with different arguments", () => {
    const fn = createSyncFunction({ doc: "return n * 2;", params: ["n"] });
    expect(fn(2)).toBe(4);
    expect(fn(5)).toBe(10);
  });

  it("ignores arguments beyond the declared params", () => {
    const fn = createSyncFunction({ doc: "return a;", params: ["a"] });
    expect(fn(1, 2, 3)).toBe(1);
  });

  it("binds undefined to params with no matching argument", () => {
    const fn = createSyncFunction({ doc: "return b;", params: ["a", "b"] });
    expect(fn(1)).toBeUndefined();
  });

  it("supports a rest param", () => {
    const fn = createSyncFunction({ doc: "return rest.length;", params: ["...rest"] });
    expect(fn(1, 2, 3)).toBe(3);
  });

  it("supports a default value in a param", () => {
    const fn = createSyncFunction({ doc: "return a;", params: ["a = 7"] });
    expect(fn()).toBe(7);
    expect(fn(1)).toBe(1);
  });

  it("supports a destructured param", () => {
    const fn = createSyncFunction({ doc: "return x;", params: ["{ x }"] });
    expect(fn({ x: 9 })).toBe(9);
  });

  it("reads context values fresh on every call", () => {
    const box = { v: 1 };
    const fn = createSyncFunction({ doc: "return box.v;", context: { box } });
    expect(fn()).toBe(1);
    box.v = 2;
    expect(fn()).toBe(2);
  });

  it("lets a param shadow a context key of the same name", () => {
    const fn = createSyncFunction({ doc: "return a;", context: { a: 1 }, params: ["a"] });
    expect(fn(2)).toBe(2);
  });

  it("throws at creation time when the doc does not parse", () => {
    expect(() => createSyncFunction({ doc: "return (" })).toThrow(SyntaxError);
  });

  it("throws at creation time when a context key is not a valid identifier", () => {
    expect(() => createSyncFunction({ doc: "return 1;", context: { "my-key": 1 } })).toThrow(
      SyntaxError
    );
  });

  it("throws at creation time when a param is not a valid identifier", () => {
    expect(() => createSyncFunction({ doc: "return 1;", params: ["my-param"] })).toThrow(
      SyntaxError
    );
  });

  it("throws at creation time on a duplicate name when the body is strict", () => {
    expect(() =>
      createSyncFunction({ doc: '"use strict"; return a;', context: { a: 1 }, params: ["a"] })
    ).toThrow(SyntaxError);
  });
});

describe("createAsyncFunction", () => {
  it("returns a promise", () => {
    const fn = createAsyncFunction({ doc: "return 1;" });
    expect(fn()).toBeInstanceOf(Promise);
  });

  it("resolves with the returned value", async () => {
    const fn = createAsyncFunction({ doc: "return 1 + 1;" });
    await expect(fn()).resolves.toBe(2);
  });

  it("awaits promises used inside the doc body", async () => {
    const fn = createAsyncFunction({ doc: "return await Promise.resolve(n);", params: ["n"] });
    await expect(fn(42)).resolves.toBe(42);
  });

  it("exposes context values by name", async () => {
    const fn = createAsyncFunction({ doc: "return a + b;", context: { a: 1, b: 2 } });
    await expect(fn()).resolves.toBe(3);
  });

  it("exposes declared params by name", async () => {
    const fn = createAsyncFunction({ doc: "return a + b;", params: ["a", "b"] });
    await expect(fn(3, 4)).resolves.toBe(7);
  });

  it("combines context values and declared params", async () => {
    const fn = createAsyncFunction({ doc: "return a + x;", context: { a: 10 }, params: ["x"] });
    await expect(fn(5)).resolves.toBe(15);
  });

  it("defaults context and params to empty", async () => {
    const fn = createAsyncFunction({ doc: "return 42;" });
    await expect(fn()).resolves.toBe(42);
  });

  it("supports a rest param", async () => {
    const fn = createAsyncFunction({ doc: "return rest.length;", params: ["...rest"] });
    await expect(fn(1, 2, 3)).resolves.toBe(3);
  });

  it("rejects when the doc body throws synchronously", async () => {
    const fn = createAsyncFunction({ doc: 'throw new Error("boom");' });
    await expect(fn()).rejects.toThrow("boom");
  });

  it("rejects when an awaited promise rejects", async () => {
    const fn = createAsyncFunction({ doc: 'return await Promise.reject(new Error("nope"));' });
    await expect(fn()).rejects.toThrow("nope");
  });

  it("supports functions passed via context", async () => {
    const fn = createAsyncFunction({
      doc: "return double(n);",
      context: { double: (n: number) => n * 2 },
      params: ["n"],
    });
    await expect(fn(6)).resolves.toBe(12);
  });

  it("lets a param shadow a context key of the same name", async () => {
    const fn = createAsyncFunction({ doc: "return a;", context: { a: 1 }, params: ["a"] });
    await expect(fn(2)).resolves.toBe(2);
  });

  it("throws at creation time rather than rejecting when the doc does not parse", () => {
    expect(() => createAsyncFunction({ doc: "return (" })).toThrow(SyntaxError);
  });

  it("throws at creation time when a param is not a valid identifier", () => {
    expect(() => createAsyncFunction({ doc: "return 1;", params: ["my-param"] })).toThrow(
      SyntaxError
    );
  });
});
