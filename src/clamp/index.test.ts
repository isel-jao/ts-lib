import { describe, expect, it } from "vitest";

import { clamp } from "./index";

describe("clamp", () => {
  describe("min/max form", () => {
    it("returns a value that is already in range", () => {
      expect(clamp({ value: 5, min: 0, max: 10 })).toBe(5);
    });

    it("pulls a value above the range down to max", () => {
      expect(clamp({ value: 42, min: 0, max: 10 })).toBe(10);
    });

    it("pulls a value below the range up to min", () => {
      expect(clamp({ value: -3, min: 0, max: 10 })).toBe(0);
    });

    it("returns the bounds themselves unchanged", () => {
      expect(clamp({ value: 0, min: 0, max: 10 })).toBe(0);
      expect(clamp({ value: 10, min: 0, max: 10 })).toBe(10);
    });

    it("handles negative ranges", () => {
      expect(clamp({ value: -5, min: -10, max: -1 })).toBe(-5);
      expect(clamp({ value: 0, min: -10, max: -1 })).toBe(-1);
      expect(clamp({ value: -50, min: -10, max: -1 })).toBe(-10);
    });

    it("collapses to the single value when min equals max", () => {
      expect(clamp({ value: 100, min: 3, max: 3 })).toBe(3);
      expect(clamp({ value: -100, min: 3, max: 3 })).toBe(3);
    });

    it("preserves fractional precision", () => {
      expect(clamp({ value: 0.1, min: 0, max: 1 })).toBe(0.1);
      expect(clamp({ value: 1.5, min: 0, max: 0.3 })).toBe(0.3);
    });
  });

  describe("range form", () => {
    it("clamps against an ascending tuple", () => {
      expect(clamp({ value: 42, range: [0, 10] })).toBe(10);
      expect(clamp({ value: -3, range: [0, 10] })).toBe(0);
      expect(clamp({ value: 5, range: [0, 10] })).toBe(5);
    });

    it("sorts a descending tuple instead of throwing", () => {
      expect(clamp({ value: 42, range: [10, 0] })).toBe(10);
      expect(clamp({ value: -3, range: [10, 0] })).toBe(0);
      expect(clamp({ value: 5, range: [10, 0] })).toBe(5);
    });

    it("agrees with the min/max form for equivalent bounds", () => {
      for (const value of [-100, -1, 0, 0.5, 7, 10, 999]) {
        expect(clamp({ value, range: [0, 10] })).toBe(clamp({ value, min: 0, max: 10 }));
      }
    });

    it("collapses to the single value for a zero-width range", () => {
      expect(clamp({ value: 5, range: [0, 0] })).toBe(0);
    });

    it("lets range win when both forms are present", () => {
      // not reachable through the public union with an object literal, but a
      // widened value can carry both — the `in` check decides
      const options = { value: 50, range: [0, 10], min: 0, max: 100 } as const;
      expect(clamp(options)).toBe(10);
    });
  });

  describe("invalid bounds", () => {
    it("throws a RangeError when min is above max", () => {
      expect(() => clamp({ value: 5, min: 10, max: 0 })).toThrow(RangeError);
      expect(() => clamp({ value: 5, min: 10, max: 0 })).toThrow(
        "clamp: invalid bounds min=10, max=0"
      );
    });

    it("throws when either named bound is NaN", () => {
      expect(() => clamp({ value: 5, min: Number.NaN, max: 10 })).toThrow(RangeError);
      expect(() => clamp({ value: 5, min: 0, max: Number.NaN })).toThrow(RangeError);
    });

    it("does not throw for a NaN bound in the range form, yielding NaN", () => {
      expect(clamp({ value: 5, range: [Number.NaN, 10] })).toBeNaN();
      expect(clamp({ value: 5, range: [0, Number.NaN] })).toBeNaN();
    });
  });

  describe("non-finite values", () => {
    it("propagates a NaN value in both forms", () => {
      expect(clamp({ value: Number.NaN, min: 0, max: 10 })).toBeNaN();
      expect(clamp({ value: Number.NaN, range: [0, 10] })).toBeNaN();
    });

    it("clamps infinities to the finite bounds", () => {
      expect(clamp({ value: Number.POSITIVE_INFINITY, min: 0, max: 10 })).toBe(10);
      expect(clamp({ value: Number.NEGATIVE_INFINITY, min: 0, max: 10 })).toBe(0);
    });

    it("accepts infinite bounds as an open side", () => {
      expect(
        clamp({ value: 5, min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY })
      ).toBe(5);
      expect(clamp({ value: -5, min: 0, max: Number.POSITIVE_INFINITY })).toBe(0);
      expect(clamp({ value: 5, min: Number.NEGATIVE_INFINITY, max: 0 })).toBe(0);
    });

    it("returns Infinity when it is inside the bounds", () => {
      expect(
        clamp({ value: Number.POSITIVE_INFINITY, min: 0, max: Number.POSITIVE_INFINITY })
      ).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe("signed zero", () => {
    it("returns -0 when the lower bound is -0", () => {
      expect(clamp({ value: -5, min: -0, max: 5 })).toBe(-0);
      expect(Object.is(clamp({ value: -5, min: -0, max: 5 }), -0)).toBe(true);
    });

    it("returns +0 when the lower bound is +0", () => {
      expect(Object.is(clamp({ value: -5, min: 0, max: 5 }), 0)).toBe(true);
    });
  });

  describe("properties", () => {
    it("is idempotent", () => {
      const bounds = { min: 0, max: 10 } as const;
      for (const value of [-100, -0.5, 0, 3, 10, 11, 1e9]) {
        const once = clamp({ value, ...bounds });
        expect(clamp({ value: once, ...bounds })).toBe(once);
      }
    });

    it("never returns a result outside the bounds", () => {
      for (const value of [-1e308, -7.5, 0, 0.3, 42, 1e308]) {
        const result = clamp({ value, min: -1, max: 1 });
        expect(result).toBeGreaterThanOrEqual(-1);
        expect(result).toBeLessThanOrEqual(1);
      }
    });

    it("does not mutate the options object or the range tuple", () => {
      const range: readonly [number, number] = [10, 0];
      const options = { value: 42, range };

      clamp(options);

      expect(options).toEqual({ value: 42, range: [10, 0] });
      expect(range).toEqual([10, 0]);
    });
  });

  describe("use case: scroll progress", () => {
    it("keeps a ratio within 0..1 when the scroll runs past either end", () => {
      const progress = (scrollTop: number, height: number) =>
        clamp({ value: scrollTop / height, range: [0, 1] });

      expect(progress(-120, 800)).toBe(0); // rubber-band scrolling goes negative
      expect(progress(400, 800)).toBe(0.5);
      expect(progress(1200, 800)).toBe(1);
    });
  });
});
