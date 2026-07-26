import { describe, expect, it } from "vitest";

import { topoSort } from "./index";

describe("topoSort", () => {
  describe("acyclic graphs", () => {
    it("handles empty input", () => {
      expect(topoSort([], {})).toEqual({ order: [], cyclic: new Set() });
    });

    it("returns a single node with no deps", () => {
      expect(topoSort(["a"], {})).toEqual({
        order: ["a"],
        cyclic: new Set(),
      });
    });

    it("orders a linear chain dependencies-first", () => {
      const { order, cyclic } = topoSort(["c", "b", "a"], {
        c: ["b"],
        b: ["a"],
      });
      expect(order).toEqual(["a", "b", "c"]);
      expect(cyclic.size).toBe(0);
    });

    it("places every node after all of its dependencies (diamond)", () => {
      const { order, cyclic } = topoSort(["d", "b", "c", "a"], {
        b: ["a"],
        c: ["a"],
        d: ["b", "c"],
      });
      expect(cyclic.size).toBe(0);
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
      expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
    });

    it("breaks ties by position in `nodes`", () => {
      expect(topoSort(["b", "a", "c"], {}).order).toEqual(["b", "a", "c"]);
      expect(topoSort(["x", "b", "a"], { b: ["x"], a: ["x"] }).order).toEqual([
        "x",
        "b",
        "a",
      ]);
    });

    it("ignores deps pointing outside `nodes`", () => {
      const { order, cyclic } = topoSort(["a", "b"], {
        a: ["ghost"],
        b: ["a", "another-ghost"],
      });
      expect(order).toEqual(["a", "b"]);
      expect(cyclic.size).toBe(0);
    });

    it("ignores deps entries for nodes not in `nodes`", () => {
      const { order } = topoSort(["a"], { stranger: ["a"] });
      expect(order).toEqual(["a"]);
    });

    it("tolerates duplicate dependency edges", () => {
      const { order, cyclic } = topoSort(["b", "a"], { b: ["a", "a"] });
      expect(order).toEqual(["a", "b"]);
      expect(cyclic.size).toBe(0);
    });
  });

  describe("cycles", () => {
    it("flags a self-dependency as a 1-cycle", () => {
      expect(topoSort(["a"], { a: ["a"] })).toEqual({
        order: [],
        cyclic: new Set(["a"]),
      });
    });

    it("flags a 2-cycle", () => {
      const { order, cyclic } = topoSort(["a", "b"], {
        a: ["b"],
        b: ["a"],
      });
      expect(order).toEqual([]);
      expect(cyclic).toEqual(new Set(["a", "b"]));
    });

    it("flags a longer cycle", () => {
      const { cyclic } = topoSort(["a", "b", "c"], {
        a: ["c"],
        b: ["a"],
        c: ["b"],
      });
      expect(cyclic).toEqual(new Set(["a", "b", "c"]));
    });

    it("keeps nodes outside the cycle in `order`", () => {
      const { order, cyclic } = topoSort(["a", "b", "c", "d"], {
        a: ["b"],
        b: ["a"],
        d: ["c"],
      });
      expect(order).toEqual(["c", "d"]);
      expect(cyclic).toEqual(new Set(["a", "b"]));
    });

    it("flags nodes downstream of a cycle as cyclic too", () => {
      // c is not on the cycle, but it can never run: its dep never resolves.
      const { order, cyclic } = topoSort(["a", "b", "c"], {
        a: ["b"],
        b: ["a"],
        c: ["a"],
      });
      expect(order).toEqual([]);
      expect(cyclic).toEqual(new Set(["a", "b", "c"]));
    });

    it("does not flag nodes upstream of a cycle", () => {
      const { order, cyclic } = topoSort(["a", "b", "c"], {
        b: ["a", "c"],
        c: ["b"],
      });
      expect(order).toEqual(["a"]);
      expect(cyclic).toEqual(new Set(["b", "c"]));
    });

    it("handles independent cycles alongside an acyclic component", () => {
      const { order, cyclic } = topoSort(["a", "b", "x", "y", "m", "n"], {
        a: ["b"],
        b: ["a"],
        x: ["y"],
        y: ["x"],
        n: ["m"],
      });
      expect(order).toEqual(["m", "n"]);
      expect(cyclic).toEqual(new Set(["a", "b", "x", "y"]));
    });
  });
});
