import { describe, expect, it } from "vitest";
import { Registry } from "./index";

describe("Registry", () => {
  describe("register", () => {
    it("adds a new entry", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      expect(registry.get("a")).toBe(1);
    });

    it("throws when the name is already registered", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      expect(() => registry.register("a", 2)).toThrow("Already registered: a");
    });

    it("does not overwrite the existing value when it throws", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      expect(() => registry.register("a", 2)).toThrow();
      expect(registry.get("a")).toBe(1);
    });
  });

  describe("upsert", () => {
    it("adds a new entry", () => {
      const registry = new Registry<number>();
      registry.upsert("a", 1);
      expect(registry.get("a")).toBe(1);
    });

    it("overwrites an existing entry without throwing", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      expect(() => registry.upsert("a", 2)).not.toThrow();
      expect(registry.get("a")).toBe(2);
    });
  });

  describe("unregister", () => {
    it("removes an existing entry and returns true", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      expect(registry.unregister("a")).toBe(true);
      expect(registry.has("a")).toBe(false);
    });

    it("returns false when the name is not registered", () => {
      const registry = new Registry<number>();
      expect(registry.unregister("a")).toBe(false);
    });
  });

  describe("get", () => {
    it("returns the registered value", () => {
      const registry = new Registry<string>();
      registry.register("a", "value");
      expect(registry.get("a")).toBe("value");
    });

    it("returns undefined when not registered", () => {
      const registry = new Registry<string>();
      expect(registry.get("missing")).toBeUndefined();
    });
  });

  describe("require", () => {
    it("returns the registered value", () => {
      const registry = new Registry<string>();
      registry.register("a", "value");
      expect(registry.require("a")).toBe("value");
    });

    it("throws when the name is not registered", () => {
      const registry = new Registry<string>();
      expect(() => registry.require("missing")).toThrow("Not registered: missing");
    });
  });

  describe("has", () => {
    it("returns true for a registered name", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      expect(registry.has("a")).toBe(true);
    });

    it("returns false for an unregistered name", () => {
      const registry = new Registry<number>();
      expect(registry.has("a")).toBe(false);
    });
  });

  describe("list", () => {
    it("returns an empty array when nothing is registered", () => {
      const registry = new Registry<number>();
      expect(registry.list()).toEqual([]);
    });

    it("returns all registered names", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      registry.register("b", 2);
      expect(registry.list()).toEqual(["a", "b"]);
    });

    it("reflects names after unregistering", () => {
      const registry = new Registry<number>();
      registry.register("a", 1);
      registry.register("b", 2);
      registry.unregister("a");
      expect(registry.list()).toEqual(["b"]);
    });
  });
});
