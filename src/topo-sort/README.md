# topoSort

Topological sort over a string-keyed dependency graph, implemented with Kahn's algorithm. Given a list of node ids and a map of "what each node depends on", it returns a dependency-respecting order plus the set of nodes that could not be scheduled because a cycle blocks them. It never throws and never recurses, so it is safe to point at untrusted or malformed graph data.

Reach for it when you have to run things in an order determined by their declared dependencies: build steps, migrations, module initialization, task pipelines, spreadsheet-style formula recomputation.

## Why

The version most people write by hand is a recursive DFS with a `visited` set:

```ts
function naive(nodes: string[], deps: Record<string, string[]>) {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of deps[n] ?? []) visit(d);
    out.push(n);
  };
  nodes.forEach(visit);
  return out;
}
```

This is correct only on a graph you already know is acyclic. Every real graph fails it in a specific way:

- **Cycles blow the stack.** `visited` is marked before recursion, so `a -> b -> a` does terminate, but it terminates by silently emitting a bogus order — `a` gets pushed after `b`, which was pushed after `a` was already marked. You get output that violates the ordering constraint with no error. Fixing this properly means a second "in progress" colour set and a distinct `onStack` check, which is where hand-rolled versions usually get subtly wrong.
- **Failure is all-or-nothing.** Once you add cycle detection, the natural implementation throws on the first back-edge. But in a build system you rarely want to abort everything — you want to run the 400 tasks that *are* schedulable and report the 3 that are tangled.
- **Missing nodes.** `deps[n]` routinely references ids that are not in `nodes` (an optional dependency, a package outside the workspace, a stale entry). The naive `visit` recurses into them and emits them into the output, quietly widening the node set.
- **Deep graphs.** Recursion depth is proportional to the longest chain. A few thousand transitive dependencies is enough to hit the engine's stack limit.

`topoSort` is iterative (no stack limit), partial-failure-aware (schedulable nodes still come back in `order`), closed over `nodes` (nothing outside the given id list ever appears in the output), and deterministic (same input, same output, always).

## How it works

Kahn's algorithm, not DFS. The distinguishing feature is the **in-degree map**: for each node, a count of how many of its dependencies are still unsatisfied.

**Phase 1 — seed.** Every id in `nodes` gets `inDegree = 0` and an empty `dependents` array. Doing this up front is what makes the rest of the code free of "does this key exist" checks, and it is what defines the node set: an id that is not in `nodes` has no entry, and every later lookup filters it out.

**Phase 2 — build the reverse graph and count.** For each `node` and each `dep` in `deps[node]`:

```ts
if (!inDegree.has(dep)) continue;              // edge points outside `nodes` — drop it
inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
dependents.get(dep)?.push(node);
```

Two structures are built in the same pass. `inDegree[node]` counts the dependencies of `node` that are actually in the node set. `dependents[dep]` is the **inverted edge list** — the nodes waiting on `dep`. That inversion is exactly the operation [`reverseDependencies`](../reverse-dependencies/README.md) performs as a standalone function; Kahn's algorithm needs it because the traversal runs forward along "unblocks" edges while the input is expressed as "depends on" edges.

Note that the increment and the push happen together, once per edge occurrence. That is why duplicate edges are harmless: `b: ["a", "a"]` gives `b` an in-degree of 2 *and* puts `b` into `dependents["a"]` twice, so processing `a` decrements `b` twice. The two errors cancel exactly. No deduplication is needed.

**Phase 3 — drain the queue.** The queue is seeded with every node whose in-degree is 0 (nothing it depends on is in the set), in the order those nodes appear in `nodes`. Then, FIFO:

```ts
for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
  order.push(node);
  for (const dependent of dependents.get(node) ?? []) {
    const next = (inDegree.get(dependent) ?? 0) - 1;
    inDegree.set(dependent, next);
    if (next === 0) queue.push(dependent);
  }
}
```

Emitting a node means "its dependencies are all already in `order`". Decrementing a dependent means "one more of your blockers is done". A node enters the queue at the exact moment its last blocker is emitted — and only then, because `next === 0` is checked on the decremented value, so each node is enqueued exactly once.

**Invariant:** at every iteration, `inDegree[n]` equals the number of `n`'s in-set dependencies not yet pushed to `order`. It starts true after phase 2 and each decrement is paired one-to-one with a push to `order`.

**Phase 4 — cycle detection falls out for free.** No extra colouring, no back-edge check. A node reaches the queue only when its in-degree hits 0. A node on a cycle has a blocker that is itself blocked, transitively, by the node itself — so its count never reaches 0 and it is never emitted. Once the queue drains, whatever is missing from `order` is unschedulable:

```ts
const ordered = new Set(order);
const cyclic = new Set(nodes.filter((node) => !ordered.has(node)));
```

This is the "processed count < node count" test, expressed as a set difference so you get the offending ids rather than just a boolean.

**`cyclic` means "cannot ever run", not "sits on a cycle".** This is the most important thing to understand about the return value. If `a <-> b` is a cycle and `c` depends on `a`, then `c` is reported as cyclic too — it is not part of any cycle, but its dependency never resolves, so it can never run. Nodes *upstream* of a cycle are unaffected and appear in `order` normally. That is almost always the semantics you want for scheduling (the set of things you must skip), but it is not the set you want if you are trying to print the cycle itself — for that you would need to run an SCC algorithm over `cyclic`.

**Ordering among independent nodes.** Two nodes with no path between them can appear in either order and both are valid topological sorts; this implementation pins the choice so runs are reproducible:

- The initial queue comes from `nodes.filter(...)`, so roots come out in the order you listed them.
- `dependents` arrays are appended in `nodes` iteration order, so ties created by the same unblocking node follow `nodes` order too.
- FIFO (`shift`) rather than LIFO means the output is layered breadth-first: all roots, then everything unblocked by a root, and so on. `topoSort(["a","b","c","d","e"], { c: ["a"], d: ["a"], e: ["b"] })` yields `["a","b","c","d","e"]` — both roots before any dependent.

Swapping `shift()` for `pop()` would still produce a valid topological order, just a depth-first-looking one. The `nodes` array is the sole tie-breaker; sort it before calling if you want alphabetical output.

**Complexity.** Phases 1, 2 and 4 are O(V + E). The drain visits each node once and each edge once. The one wart is `Array.prototype.shift()`, which is O(n) in the general case, making the strict worst case O(V² + E). In practice V8 handles shift on packed arrays cheaply and this only matters for very large graphs; if you need the guarantee, replace `shift()` with a head index (`let head = 0; ... queue[head++]`) and the algorithm becomes a true O(V + E) with no other changes. Space is O(V + E) for the two maps.

Neither argument is mutated; all working state is allocated inside the function.

## API

### `topoSort`

```ts
function topoSort(nodes: string[], deps: Record<string, string[]>): TopoSortResult;
```

- `nodes` — the complete set of node ids to schedule. Defines the universe: any id not in this list is invisible to the algorithm, whether it appears as a key of `deps` or as an edge target. Also the tie-breaker for output ordering. Assumed to contain unique ids; duplicates are not removed.
- `deps` — `deps[node]` lists the ids `node` depends on, i.e. the nodes that must come *before* it. Missing keys are treated as an empty array. Extra keys for ids not in `nodes` are ignored. Duplicate entries within an array are harmless.

Returns a `TopoSortResult`. Never throws.

### `TopoSortResult`

```ts
interface TopoSortResult {
  readonly order: string[];
  readonly cyclic: Set<string>;
}
```

- `order` — the schedulable nodes, each positioned after all of its dependencies.
- `cyclic` — the nodes that could not be scheduled: those on a cycle, plus everything transitively downstream of one.

For a `nodes` array of unique ids, `order.length + cyclic.size === nodes.length` and the two are disjoint.

## Usage

Basic build ordering:

```ts
import { topoSort } from "@isel-jao/ts-lib";

const { order, cyclic } = topoSort(["app", "ui", "core"], {
  app: ["ui", "core"],
  ui: ["core"],
});

order; // ["core", "ui", "app"]
cyclic; // Set {}
```

Partial failure — run what you can, report what you cannot:

```ts
import { topoSort } from "@isel-jao/ts-lib";

const tasks = ["lint", "build", "test", "docs", "site"];
const { order, cyclic } = topoSort(tasks, {
  build: ["lint"],
  test: ["build"],
  docs: ["site"],
  site: ["docs"], // circular
});

for (const task of order) await run(task); // lint, build, test
if (cyclic.size > 0) {
  console.error(`skipped (unresolvable deps): ${[...cyclic].join(", ")}`);
}
```

Incremental rebuild — invert the graph to find the blast radius, then sort that subgraph to get a safe rebuild order:

```ts
import { reverseDependencies, topoSort } from "@isel-jao/ts-lib";

const deps = new Map([
  ["core", new Set<string>()],
  ["ui", new Set(["core"])],
  ["app", new Set(["ui", "core"])],
  ["cli", new Set(["core"])],
]);

// Who is affected when `core` changes?
const dependents = reverseDependencies(deps);
const affected = new Set<string>(["core"]);
const stack = ["core"];
while (stack.length > 0) {
  const node = stack.pop() as string;
  for (const d of dependents.get(node) ?? []) {
    if (!affected.has(d)) {
      affected.add(d);
      stack.push(d);
    }
  }
}

// Rebuild them in dependency order.
const { order } = topoSort(
  [...affected],
  Object.fromEntries([...deps].map(([n, d]) => [n, [...d]]))
);
order; // ["core", "ui", "cli", "app"] — core first, app last
```

## Edge cases

| Input | Result | Source |
| --- | --- | --- |
| `topoSort([], {})` | `{ order: [], cyclic: Set {} }` | test |
| Single node, no deps | emitted as-is | test |
| Dep target not in `nodes` (`a: ["ghost"]`) | edge dropped; `a` stays a root | test |
| `deps` key not in `nodes` (`{ stranger: ["a"] }`) | entry ignored entirely | test |
| Duplicate edge (`b: ["a", "a"]`) | counted twice on both sides; cancels out, order correct | test |
| Self-dependency (`a: ["a"]`) | `a` is cyclic, `order` empty | test |
| 2-cycle / longer cycle | all members in `cyclic`, none in `order` | test |
| Node downstream of a cycle | reported in `cyclic` — it can never run | test |
| Node upstream of a cycle | reported in `order` — unaffected | test |
| Several disjoint cycles plus a clean component | clean component in `order`, all cycle members in `cyclic` | test |
| Mutually independent nodes | ordered by their position in `nodes` | test |
| Duplicate id in `nodes` | not deduplicated; a duplicated root appears twice in `order`. Pass unique ids | code |
| Very deep chains | fine — the algorithm is iterative, no recursion limit | code |
