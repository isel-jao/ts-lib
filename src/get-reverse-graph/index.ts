/**
 * A directed graph in forward (authored) form: `graph.get(node)` is the set of
 * nodes `node` points at — its dependencies. The key set defines the node set;
 * a target that is not itself a key is a *ghost node*.
 */
export type Graph = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The inverted graph: `reverseGraph.get(node)` is the set of nodes that point
 * at `node` — its dependents. A fresh, mutable `Map` of fresh `Set`s.
 */
export type ReverseGraph = Map<string, Set<string>>;

export interface GetReverseGraphOptions {
  /**
   * Whether edges pointing at nodes that are not keys of the input (ghost
   * nodes) are kept. When `false` (the default) such edges are dropped and the
   * output key set is exactly the input key set. When `true` each ghost node
   * gets its own entry, appended after the declared keys.
   */
  includeGhostNodes?: boolean;
}

/**
 * Inverts a directed graph. Given a map of "what each node depends on", it
 * returns a map of "what depends on each node". Every key of `graph` gets an
 * entry — empty when nothing depends on it — so the result is safe to read
 * without a `?? new Set()` fallback.
 *
 * Edges pointing at nodes that are not keys of `graph` are dropped, unless
 * `includeGhostNodes` is set. Self-loops and cycles are preserved. The input
 * is never mutated. O(V + E) time and space.
 *
 * @example
 * const graph = new Map([
 *   ["core", new Set<string>()],
 *   ["ui", new Set(["core"])],
 *   ["app", new Set(["ui", "core"])],
 * ]);
 *
 * getReverseGraph(graph).get("core"); // Set { "ui", "app" }
 * getReverseGraph(graph).get("app");  // Set {} — nothing depends on it
 */
export function getReverseGraph(graph: Graph, options: GetReverseGraphOptions = {}): ReverseGraph {
  const { includeGhostNodes = false } = options;
  const reverseGraph: ReverseGraph = new Map();

  // Helper to ensure a target node set exists in the map
  const getOrCreateSet = (node: string): Set<string> => {
    let set = reverseGraph.get(node);
    if (!set) {
      set = new Set();
      reverseGraph.set(node, set);
    }
    return set;
  };

  // Pre-initialize all declared graph keys
  for (const node of graph.keys()) {
    getOrCreateSet(node);
  }

  // Populate reversed relationships
  for (const [node, dependencies] of graph) {
    for (const dependency of dependencies) {
      const isGhostNode = !graph.has(dependency);

      if (isGhostNode && !includeGhostNodes) {
        continue; // Skip dependencies not defined in graph keys
      }

      getOrCreateSet(dependency).add(node);
    }
  }

  return reverseGraph;
}
