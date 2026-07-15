import { describe, expect, it } from "vitest";

import { reverseDependencies } from "./index";

function graph(entries: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(
    Object.entries(entries).map(([node, deps]) => [node, new Set(deps)]),
  );
}

describe("reverseDependencies", () => {
  it("handles an empty map", () => {
    expect(reverseDependencies(new Map())).toEqual(new Map());
  });

  it("gives every node an entry, empty when nothing depends on it", () => {
    expect(reverseDependencies(graph({ a: [], b: [] }))).toEqual(
      graph({ a: [], b: [] }),
    );
  });

  it("inverts a single edge", () => {
    expect(reverseDependencies(graph({ a: [], b: ["a"] }))).toEqual(
      graph({ a: ["b"], b: [] }),
    );
  });

  it("inverts a linear chain", () => {
    expect(
      reverseDependencies(graph({ a: [], b: ["a"], c: ["b"] })),
    ).toEqual(graph({ a: ["b"], b: ["c"], c: [] }));
  });

  it("collects all dependents of a shared dependency (diamond)", () => {
    expect(
      reverseDependencies(
        graph({ a: [], b: ["a"], c: ["a"], d: ["b", "c"] }),
      ),
    ).toEqual(graph({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] }));
  });

  it("keeps a self-dependency", () => {
    expect(reverseDependencies(graph({ a: ["a"] }))).toEqual(
      graph({ a: ["a"] }),
    );
  });

  it("keeps a 2-cycle", () => {
    expect(reverseDependencies(graph({ a: ["b"], b: ["a"] }))).toEqual(
      graph({ a: ["b"], b: ["a"] }),
    );
  });

  it("ignores edges pointing outside the map's keys", () => {
    expect(reverseDependencies(graph({ a: ["ghost"], b: ["a"] }))).toEqual(
      graph({ a: ["b"], b: [] }),
    );
  });

  it("does not modify the input map", () => {
    const input = graph({ a: [], b: ["a"] });
    reverseDependencies(input);
    expect(input).toEqual(graph({ a: [], b: ["a"] }));
  });

  it("round-trips: reversing twice returns the original graph", () => {
    const input = graph({ a: [], b: ["a"], c: ["a", "b"], d: [] });
    expect(reverseDependencies(reverseDependencies(input))).toEqual(input);
  });
});
