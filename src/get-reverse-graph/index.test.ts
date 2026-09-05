import { describe, expect, it } from "vitest";

import { type Graph, getReverseGraph } from "./index";

/** Builds a graph from a plain object, so the tests stay readable. */
const graph = (edges: Record<string, string[]>): Graph =>
  new Map(Object.entries(edges).map(([node, deps]) => [node, new Set(deps)]));

/** The expected shape, in the same form. */
const expected = (edges: Record<string, string[]>) =>
  new Map(Object.entries(edges).map(([node, deps]) => [node, new Set(deps)]));

describe("getReverseGraph", () => {
  describe("basics", () => {
    it("returns an empty map for an empty graph", () => {
      expect(getReverseGraph(new Map())).toEqual(new Map());
    });

    it("inverts a single edge", () => {
      expect(getReverseGraph(graph({ ui: ["core"], core: [] }))).toEqual(
        expected({ ui: [], core: ["ui"] })
      );
    });

    it("keeps every declared key, empty when nothing depends on it", () => {
      const reverse = getReverseGraph(graph({ core: [], ui: ["core"], app: ["ui", "core"] }));

      expect(reverse).toEqual(expected({ core: ["ui", "app"], ui: ["app"], app: [] }));
      // the point of seeding: no `?? new Set()` needed at the call site
      expect(reverse.get("app")).toEqual(new Set());
    });

    it("collects every dependent of a shared dependency", () => {
      expect(getReverseGraph(graph({ a: [], b: ["a"], c: ["a"], d: ["a"] }))).toEqual(
        expected({ a: ["b", "c", "d"], b: [], c: [], d: [] })
      );
    });

    it("handles nodes with no dependencies at all", () => {
      expect(getReverseGraph(graph({ a: [], b: [], c: [] }))).toEqual(
        expected({ a: [], b: [], c: [] })
      );
    });

    it("treats an explicit empty options object as the default", () => {
      const input = graph({ a: ["ghost"], b: ["a"] });
      expect(getReverseGraph(input, {})).toEqual(getReverseGraph(input));
    });
  });

  describe("cycles and self-loops", () => {
    it("preserves a self-loop", () => {
      expect(getReverseGraph(graph({ a: ["a"] }))).toEqual(expected({ a: ["a"] }));
    });

    it("preserves a 2-cycle", () => {
      expect(getReverseGraph(graph({ a: ["b"], b: ["a"] }))).toEqual(
        expected({ a: ["b"], b: ["a"] })
      );
    });

    it("preserves a longer cycle, reversing its direction", () => {
      expect(getReverseGraph(graph({ a: ["b"], b: ["c"], c: ["a"] }))).toEqual(
        expected({ a: ["c"], b: ["a"], c: ["b"] })
      );
    });
  });

  describe("ghost nodes", () => {
    it("drops edges to undeclared nodes by default", () => {
      const reverse = getReverseGraph(graph({ a: ["ghost"], b: ["a"] }));

      expect(reverse).toEqual(expected({ a: ["b"], b: [] }));
      expect(reverse.has("ghost")).toBe(false);
    });

    it("keeps the output key set identical to the input key set by default", () => {
      const input = graph({ a: ["ghost", "b"], b: ["missing"], c: [] });

      expect([...getReverseGraph(input).keys()]).toEqual([...input.keys()]);
    });

    it("gives each ghost node an entry when includeGhostNodes is true", () => {
      const reverse = getReverseGraph(graph({ a: ["ghost"], b: ["a"] }), {
        includeGhostNodes: true,
      });

      expect(reverse).toEqual(expected({ a: ["b"], b: [], ghost: ["a"] }));
    });

    it("collects every dependent of a shared ghost node", () => {
      expect(
        getReverseGraph(graph({ a: ["ghost"], b: ["ghost"] }), { includeGhostNodes: true })
      ).toEqual(expected({ a: [], b: [], ghost: ["a", "b"] }));
    });

    it("appends ghost nodes after the declared keys, in discovery order", () => {
      const reverse = getReverseGraph(graph({ a: ["y"], b: ["x"], c: [] }), {
        includeGhostNodes: true,
      });

      expect([...reverse.keys()]).toEqual(["a", "b", "c", "y", "x"]);
    });

    it("never creates an entry for a ghost node with no dependents", () => {
      // ghost nodes are only discovered through edges, so there is no such case
      expect(getReverseGraph(graph({ a: [] }), { includeGhostNodes: true })).toEqual(
        expected({ a: [] })
      );
    });
  });

  describe("ordering", () => {
    it("preserves input key insertion order", () => {
      const input = graph({ zebra: [], apple: ["zebra"], mango: [] });

      expect([...getReverseGraph(input).keys()]).toEqual(["zebra", "apple", "mango"]);
    });

    it("lists dependents in the order their edges are visited", () => {
      const reverse = getReverseGraph(graph({ core: [], c: ["core"], a: ["core"], b: ["core"] }));

      expect([...(reverse.get("core") ?? [])]).toEqual(["c", "a", "b"]);
    });
  });

  describe("purity", () => {
    it("does not mutate the input map or its sets", () => {
      const coreDeps = new Set<string>();
      const uiDeps = new Set(["core", "ghost"]);
      const input = new Map([
        ["core", coreDeps],
        ["ui", uiDeps],
      ]);

      getReverseGraph(input, { includeGhostNodes: true });

      expect(input.size).toBe(2);
      expect(coreDeps).toEqual(new Set());
      expect(uiDeps).toEqual(new Set(["core", "ghost"]));
    });

    it("returns fresh sets that do not alias the input sets", () => {
      const deps = new Set(["b"]);
      const input = new Map([
        ["a", deps],
        ["b", new Set<string>()],
      ]);

      const reverse = getReverseGraph(input);
      reverse.get("b")?.add("injected");

      expect(deps).toEqual(new Set(["b"]));
      expect(input.get("b")).toEqual(new Set());
    });

    it("returns a mutable map the caller owns", () => {
      const reverse = getReverseGraph(graph({ a: [] }));

      reverse.set("b", new Set(["a"]));
      expect(reverse.get("b")).toEqual(new Set(["a"]));
    });

    it("is deterministic across repeated calls", () => {
      const input = graph({ a: ["b"], b: ["c"], c: [] });

      expect(getReverseGraph(input)).toEqual(getReverseGraph(input));
    });
  });

  describe("double inversion", () => {
    it("round-trips a closed graph", () => {
      const input = graph({ core: [], ui: ["core"], app: ["ui", "core"] });

      expect(getReverseGraph(getReverseGraph(input))).toEqual(input);
    });

    it("round-trips a graph containing a cycle", () => {
      const input = graph({ a: ["b"], b: ["c"], c: ["a"] });

      expect(getReverseGraph(getReverseGraph(input))).toEqual(input);
    });

    it("loses edges to ghost nodes, so it is not a round trip", () => {
      const input = graph({ a: ["ghost"], b: ["a"] });

      // a -> ghost is dropped on the first pass and cannot come back
      expect(getReverseGraph(getReverseGraph(input))).toEqual(expected({ a: [], b: ["a"] }));
    });

    it("promotes ghost nodes to real nodes when they are included", () => {
      const input = graph({ a: ["ghost"], b: ["a"] });
      const once = getReverseGraph(input, { includeGhostNodes: true });

      // the edge survives, but `ghost` is now a key the original did not have
      expect(getReverseGraph(once)).toEqual(expected({ a: ["ghost"], b: ["a"], ghost: [] }));
    });
  });

  describe("use case: blast radius", () => {
    it("finds everything transitively affected by a change", () => {
      const input = graph({
        schema: [],
        model: ["schema"],
        api: ["model"],
        cli: ["schema"],
        unrelated: [],
      });

      const dependents = getReverseGraph(input);
      const affected = new Set(["schema"]);
      const queue = ["schema"];

      for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
        for (const dependent of dependents.get(node) ?? []) {
          if (affected.has(dependent)) continue;
          affected.add(dependent);
          queue.push(dependent);
        }
      }

      expect(affected).toEqual(new Set(["schema", "model", "cli", "api"]));
    });
  });
});
