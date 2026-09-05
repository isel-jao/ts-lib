# getReverseGraph

Inverts a directed graph. Given a map of "what each node depends on", it returns a map of "what depends on each node" — every key of the input gets an entry in the output, empty when nothing depends on it.

Reach for it whenever a change to one node has to propagate outward: cache invalidation, incremental rebuilds, "what breaks if I delete this", reactive recomputation.

## Why

Dependency data is almost always *stored* in the forward direction, because that is how it is authored — a `package.json` lists what it needs, an import statement names the module being imported, a memoized cell records the cells it read. The edge is written down at the dependent end.

The questions you ask at runtime run the other way: a file changed, so which caches are stale? Answering that from the forward map means a full scan per query — O(V + E) *per lookup*, and walking the transitive blast radius does one scan per visited node, turning an O(V + E) traversal into O(V·(V + E)). Inverting once makes every lookup O(1).

The inline version people write has two bugs that surface late:

1. **Leaf nodes vanish.** Entries created lazily only exist once something points at them, so a node nothing depends on never becomes a key. `reverse.get("app")` is `undefined` instead of an empty set, and every call site needs `?? new Set()` or crashes on whichever node sits at the top of the tree.
2. **Dangling edges create nodes out of thin air.** If `a` depends on `"ghost"` and `ghost` is not a node in your graph, the lazy version invents a `ghost` key. The reversed graph now has a node the forward graph does not, and anything iterating both is off by one.

This function fixes the first unconditionally and makes the second a decision you state at the call site.

## How it works

Two passes, no recursion.

**Pass 1 — seed.** Every key of `graph` gets an empty `Set`. This one loop is what guarantees the output key set covers the input key set, so a leaf node reads as `Set {}` rather than `undefined`.

**Pass 2 — flip each edge.** For every edge `node -> dependency`, record `node` in the bucket of `dependency`. Before the write, one `graph.has(dependency)` lookup classifies the edge:

```ts
const isGhostNode = !graph.has(dependency);

if (isGhostNode && !includeGhostNodes) {
  continue; // Skip dependencies not defined in graph keys
}

getOrCreateSet(dependency).add(node);
```

A **ghost node** is an edge target that is not itself a key of the input — a dependency you named but never declared. That single branch is the entire out-of-graph policy:

- **`includeGhostNodes: false` (default)** — the edge is dropped. `[...result.keys()]` equals `[...graph.keys()]`, same membership *and* same insertion order, so the two graphs can be iterated in lockstep.
- **`includeGhostNodes: true`** — the edge survives and `getOrCreateSet` materializes a bucket for the ghost. It lands after all declared keys, in the order the edges were visited. Use it when the undeclared targets are real and interesting — external packages, files outside the workspace, dangling foreign keys you want to report on.

`getOrCreateSet` is what makes both passes share one code path; in the default mode it never actually creates anything during pass 2, since every reachable target was already seeded.

**Invariants.**

- `result.get(y).has(x)` iff `graph.get(x).has(y)`, and either `y` is a key of `graph` or ghost nodes are included.
- The input is never touched: new `Map`, new `Set`s, no aliasing. Asserted by the tests.
- Self-loops and cycles are preserved, with their direction reversed.
- Within a bucket, dependents appear in the order their edges were visited — outer key order first, then dependency-set order.

**Round-tripping.** Double inversion returns the original for *closed* graphs — every edge target is also a key — which is what tells you the inversion is lossless. Neither ghost mode preserves that:

```ts
{ a: ["ghost"], b: ["a"] }
  // default:  -> { a: ["b"], b: [] }         -> { a: [], b: ["a"] }   edge lost
  // included: -> { a: ["b"], b: [], ghost: ["a"] }
  //           -> { a: ["ghost"], b: ["a"], ghost: [] }   edge kept, ghost promoted
```

The default drops the edge on the first pass and it cannot come back. Including ghost nodes keeps the edge but promotes `ghost` to a real key, so the second inversion returns a graph with a node the original did not have. Close the graph first if you need an exact round trip.

**Complexity.** O(V + E) time and space, all `Map`/`Set` operations amortized O(1) — including the `has` check, which adds one lookup per edge. Inverting beats one forward scan per query as soon as you have more than one query.

The parameter is a `ReadonlyMap<string, ReadonlySet<string>>`, which accepts a mutable map without a cast while proving the function cannot write to it. The return type is deliberately *not* readonly: the result is a fresh structure you own, and callers routinely keep mutating it while they walk the graph.

## API

### `getReverseGraph`

```ts
function getReverseGraph(graph: Graph, options?: GetReverseGraphOptions): ReverseGraph;
```

- `graph` — forward graph. `graph.get(x)` is the set of nodes `x` depends on. The key set defines the node set. Not mutated.
- `options.includeGhostNodes` — whether edges pointing at nodes that are not keys of `graph` are kept, each ghost getting its own entry. Defaults to `false`, which drops them.

Returns a new mutable map with an entry for every key of `graph`, where `result.get(y)` is the set of nodes that depend on `y`. Never throws.

### Types

```ts
type Graph = ReadonlyMap<string, ReadonlySet<string>>;
type ReverseGraph = Map<string, Set<string>>;

interface GetReverseGraphOptions {
  includeGhostNodes?: boolean;
}
```

## Usage

```ts
import { getReverseGraph } from "@isel-jao/ts-lib";

const graph = new Map([
  ["core", new Set<string>()],
  ["ui", new Set(["core"])],
  ["app", new Set(["ui", "core"])],
]);

const dependents = getReverseGraph(graph);
dependents.get("core"); // Set { "ui", "app" }
dependents.get("app");  // Set {} — nothing depends on it
```

Ghost nodes let you ask the same question about things outside the graph — which of your workspace packages pull in an external one:

```ts
const workspace = new Map([
  ["ui", new Set(["react", "core"])],
  ["core", new Set(["react"])],
]);

getReverseGraph(workspace).has("react");
// false — the edges are dropped, keys stay exactly ["ui", "core"]

getReverseGraph(workspace, { includeGhostNodes: true }).get("react");
// Set { "ui", "core" } — both packages would be hit by a React upgrade
```

Transitive invalidation — one inversion, then a BFS gives the full blast radius. Hoist the inversion out of any loop; it is the expensive half and only changes when the graph does.

```ts
import { getReverseGraph, type Graph } from "@isel-jao/ts-lib";

function blastRadius(graph: Graph, changed: string): Set<string> {
  const dependents = getReverseGraph(graph);
  const affected = new Set([changed]);
  const queue = [changed];

  for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
    for (const dependent of dependents.get(node) ?? []) {
      if (affected.has(dependent)) continue; // also terminates on cycles
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return affected;
}

const project = new Map([
  ["schema", new Set<string>()],
  ["model", new Set(["schema"])],
  ["api", new Set(["model"])],
  ["cli", new Set(["schema"])],
  ["unrelated", new Set<string>()],
]);

blastRadius(project, "schema"); // Set { "schema", "model", "cli", "api" }
```

## Edge cases

| Input | Result |
| --- | --- |
| Empty map | empty map |
| Nodes with no dependencies | keys preserved, sets empty |
| Shared dependency (`b: [a]`, `c: [a]`) | `a` maps to `{ b, c }` |
| Self-dependency (`a: [a]`) | preserved |
| 2-cycle (`a: [b]`, `b: [a]`) | preserved as a 2-cycle |
| Longer cycle | preserved, direction reversed |
| Edge to a non-key (`a: ["ghost"]`) | dropped; no `ghost` key in the output |
| Same, with `includeGhostNodes: true` | kept; `ghost` maps to `{ a }` |
| Ghost node with no dependents | impossible — ghosts are only discovered through edges |
| Key order, default | identical to the input's, including insertion order |
| Key order, ghosts included | declared keys first, then ghosts in discovery order |
| Input map and sets | never mutated; output sets never alias them |
| Double inversion, closed graph | returns the original |
| Double inversion, dangling edges | loses them — not a round trip |
| Double inversion, ghosts included | keeps the edges but promotes each ghost to a key |
