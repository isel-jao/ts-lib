import { describe, expect, it } from "vitest";

import { mapRange } from "./index";

describe("mapRange", () => {
  describe("basics", () => {
    it("maps the midpoint to the midpoint", () => {
      expect(mapRange({ value: 0.5, from: [0, 1], to: [0, 100] })).toBe(50);
    });

    it("maps each endpoint to the matching endpoint", () => {
      expect(mapRange({ value: 0, from: [0, 1], to: [7, 13] })).toBe(7);
      expect(mapRange({ value: 1, from: [0, 1], to: [7, 13] })).toBe(13);
    });

    it("maps between ranges that share no bounds", () => {
      expect(mapRange({ value: 5, from: [0, 10], to: [100, 200] })).toBe(150);
      expect(mapRange({ value: 75, from: [50, 100], to: [-1, 1] })).toBe(0);
    });

    it("maps through negative ranges", () => {
      expect(mapRange({ value: -5, from: [-10, 0], to: [0, 1] })).toBe(0.5);
      expect(mapRange({ value: 0.5, from: [0, 1], to: [-100, -200] })).toBe(-150);
    });

    it("is the identity for identical ranges", () => {
      for (const value of [-3, 0, 0.1, 0.5, 1, 7.25]) {
        expect(mapRange({ value, from: [0, 1], to: [0, 1] })).toBe(value);
      }
    });

    it("converts units", () => {
      expect(mapRange({ value: 98.6, from: [32, 212], to: [0, 100] })).toBe(37);
      expect(mapRange({ value: 32, from: [32, 212], to: [0, 100] })).toBe(0);
      expect(mapRange({ value: 212, from: [32, 212], to: [0, 100] })).toBe(100);
      expect(mapRange({ value: 0, from: [32, 212], to: [0, 100] })).toBeCloseTo(-17.78, 2);
    });
  });

  describe("extrapolation", () => {
    it("extends past the end of the output range by default", () => {
      expect(mapRange({ value: 2, from: [0, 1], to: [0, 100] })).toBe(200);
      expect(mapRange({ value: -1, from: [0, 1], to: [0, 100] })).toBe(-100);
    });

    it("extrapolates symmetrically on both sides", () => {
      expect(mapRange({ value: 15, from: [0, 10], to: [0, 10] })).toBe(15);
      expect(mapRange({ value: -5, from: [0, 10], to: [0, 10] })).toBe(-5);
    });

    it("treats an explicit clamp: false as the default", () => {
      expect(mapRange({ value: 2, from: [0, 1], to: [0, 100], clamp: false })).toBe(200);
    });
  });

  describe("clamping", () => {
    it("pins values above the input range to the far endpoint", () => {
      expect(mapRange({ value: 2, from: [0, 1], to: [0, 100], clamp: true })).toBe(100);
    });

    it("pins values below the input range to the near endpoint", () => {
      expect(mapRange({ value: -1, from: [0, 1], to: [0, 100], clamp: true })).toBe(0);
    });

    it("leaves values inside the input range untouched", () => {
      expect(mapRange({ value: 0.25, from: [0, 1], to: [0, 100], clamp: true })).toBe(25);
    });

    it("clamps in normalized space, so a descending output range still works", () => {
      expect(mapRange({ value: 2, from: [0, 1], to: [100, 0], clamp: true })).toBe(0);
      expect(mapRange({ value: -1, from: [0, 1], to: [100, 0], clamp: true })).toBe(100);
    });

    it("clamps correctly for a descending input range", () => {
      expect(mapRange({ value: 20, from: [10, 0], to: [0, 100], clamp: true })).toBe(0);
      expect(mapRange({ value: -10, from: [10, 0], to: [0, 100], clamp: true })).toBe(100);
    });

    it("never returns a result outside the output endpoints", () => {
      for (const value of [-1e6, -1, 0, 0.5, 1, 2, 1e6]) {
        const result = mapRange({ value, from: [0, 1], to: [-20, 60], clamp: true });
        expect(result).toBeGreaterThanOrEqual(-20);
        expect(result).toBeLessThanOrEqual(60);
      }
    });
  });

  describe("reversed ranges", () => {
    it("inverts the mapping for a descending input range", () => {
      expect(mapRange({ value: 2, from: [10, 0], to: [0, 100] })).toBe(80);
      expect(mapRange({ value: 10, from: [10, 0], to: [0, 100] })).toBe(0);
      expect(mapRange({ value: 0, from: [10, 0], to: [0, 100] })).toBe(100);
    });

    it("inverts the mapping for a descending output range", () => {
      expect(mapRange({ value: 0.25, from: [0, 1], to: [100, 0] })).toBe(75);
    });

    it("cancels out when both ranges are descending", () => {
      expect(mapRange({ value: 2, from: [10, 0], to: [100, 0] })).toBeCloseTo(20, 10);
    });
  });

  describe("invalid input", () => {
    it("throws a RangeError for a zero-width input range", () => {
      expect(() => mapRange({ value: 1, from: [5, 5], to: [0, 1] })).toThrow(RangeError);
      expect(() => mapRange({ value: 1, from: [5, 5], to: [0, 1] })).toThrow(
        "mapRange: 'from' range has zero width (5)"
      );
    });

    it("treats 0 and -0 as zero width", () => {
      expect(() => mapRange({ value: 1, from: [0, -0], to: [0, 1] })).toThrow(RangeError);
    });

    it("throws before reading to, so a bad from is caught either way", () => {
      expect(() => mapRange({ value: 1, from: [5, 5], to: [5, 5] })).toThrow(RangeError);
    });

    it("accepts a zero-width output range, returning that constant", () => {
      expect(mapRange({ value: 123, from: [0, 10], to: [5, 5] })).toBe(5);
      expect(mapRange({ value: -999, from: [0, 10], to: [5, 5] })).toBe(5);
    });
  });

  describe("non-finite numbers", () => {
    it("propagates a NaN value", () => {
      expect(mapRange({ value: Number.NaN, from: [0, 1], to: [0, 100] })).toBeNaN();
    });

    it("does not rescue a NaN value when clamping", () => {
      // Math.max(NaN, 0) is NaN, so the clamp cannot pull it back into 0..1
      expect(mapRange({ value: Number.NaN, from: [0, 1], to: [0, 100], clamp: true })).toBeNaN();
    });

    it("yields NaN for a NaN input bound rather than throwing", () => {
      // NaN !== NaN, so the zero-width guard does not fire
      expect(mapRange({ value: 1, from: [Number.NaN, 10], to: [0, 1] })).toBeNaN();
      expect(mapRange({ value: 1, from: [0, Number.NaN], to: [0, 1] })).toBeNaN();
    });

    it("yields NaN for an unclamped infinite value", () => {
      // t is infinite, and (1 - Infinity) * to[0] + Infinity * to[1] is NaN
      expect(mapRange({ value: Number.POSITIVE_INFINITY, from: [0, 10], to: [0, 100] })).toBeNaN();
      expect(mapRange({ value: Number.NEGATIVE_INFINITY, from: [0, 10], to: [1, 100] })).toBeNaN();
    });

    it("resolves an infinite value to an endpoint when clamping", () => {
      expect(
        mapRange({
          value: Number.POSITIVE_INFINITY,
          from: [0, 10],
          to: [0, 100],
          clamp: true,
        })
      ).toBe(100);
      expect(
        mapRange({
          value: Number.NEGATIVE_INFINITY,
          from: [0, 10],
          to: [0, 100],
          clamp: true,
        })
      ).toBe(0);
    });

    it("collapses an infinitely wide input range to the start of the output", () => {
      // t is 0 for every finite value
      expect(mapRange({ value: 5, from: [0, Number.POSITIVE_INFINITY], to: [0, 100] })).toBe(0);
    });
  });

  describe("floating point", () => {
    it("returns the output endpoints exactly, with no drift", () => {
      const from: readonly [number, number] = [0.1, 0.7];
      const to: readonly [number, number] = [0.3, 0.1];

      // the naive `c + t * (d - c)` form misses `to[1]` here; this form does not
      expect(mapRange({ value: 0.7, from, to })).toBe(0.1);
      expect(mapRange({ value: 0.1, from, to })).toBe(0.3);
    });

    it("stays exact on endpoints for awkward bounds", () => {
      const cases: ReadonlyArray<readonly [number, number]> = [
        [1e-9, 1e9],
        [-0.3, 0.1],
        [1 / 3, 2 / 3],
        [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ];

      for (const from of cases) {
        expect(mapRange({ value: from[0], from, to: [-7.5, 123.456] })).toBe(-7.5);
        expect(mapRange({ value: from[1], from, to: [-7.5, 123.456] })).toBe(123.456);
      }
    });

    it("carries the usual drift on interior points", () => {
      // only the endpoints are exact; 0.19999999999999996 * 100 lands just short
      expect(mapRange({ value: 2, from: [10, 0], to: [100, 0] })).toBe(19.999999999999996);
    });

    it("round-trips a value back through the inverse mapping", () => {
      const value = 42;
      const forward = mapRange({ value, from: [0, 255], to: [0, 1] });

      expect(mapRange({ value: forward, from: [0, 1], to: [0, 255] })).toBeCloseTo(value, 10);
    });
  });

  describe("purity", () => {
    it("does not mutate the options object or its tuples", () => {
      const from: readonly [number, number] = [0, 10];
      const to: readonly [number, number] = [100, 0];
      const options = { value: 3, from, to, clamp: true };

      mapRange(options);

      expect(options).toEqual({ value: 3, from: [0, 10], to: [100, 0], clamp: true });
    });

    it("is deterministic across repeated calls", () => {
      const options = { value: 0.37, from: [0, 1], to: [-5, 5] } as const;

      expect(mapRange(options)).toBe(mapRange(options));
    });
  });

  describe("use case: normalize then project", () => {
    it("maps data values onto screen coordinates with a flipped y axis", () => {
      const toY = (temperature: number) =>
        mapRange({ value: temperature, from: [-10, 40], to: [480, 0], clamp: true });

      expect(toY(-10)).toBe(480); // coldest sits at the bottom
      expect(toY(15)).toBe(240);
      expect(toY(40)).toBe(0); // hottest sits at the top
      expect(toY(60)).toBe(0); // out-of-range data stays on canvas
    });
  });
});
