import { describe, expect, it } from "vitest";
import { ensureUniqueName } from "./index";

describe("ensureUniqueName", () => {
  it("returns the name unchanged when not taken", () => {
    expect(ensureUniqueName("foo", new Set(["bar"]))).toBe("foo");
  });

  it("appends 1 when name is taken", () => {
    expect(ensureUniqueName("foo", new Set(["foo"]))).toBe("foo1");
  });

  it("increments existing trailing number", () => {
    expect(ensureUniqueName("foo1", new Set(["foo1"]))).toBe("foo2");
  });

  it("skips numbers already taken", () => {
    expect(ensureUniqueName("foo", new Set(["foo", "foo1", "foo2"]))).toBe("foo3");
  });

  it("accepts an array instead of a Set", () => {
    expect(ensureUniqueName("foo", ["foo", "foo1"])).toBe("foo2");
  });

  it("returns the name unchanged when the list is empty", () => {
    expect(ensureUniqueName("foo", [])).toBe("foo");
  });

  it("fills the first gap when there is a skipped index", () => {
    expect(ensureUniqueName("foo", new Set(["foo", "foo1", "foo3"]))).toBe("foo2");
  });
});
