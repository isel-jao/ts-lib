# topoSort

Topological sort over a string-keyed dependency graph, implemented with Kahn's algorithm. Given a list of node ids and a map of "what each node depends on", it returns a dependency-respecting order plus the set of nodes that could not be scheduled because a cycle blocks them. It never throws and never recurses, so it is safe to point at untrusted or malformed graph data.

Reach for it when things must run in an order determined by their declared dependencies: build steps, migrations, module initialization, task pipelines, spreadsheet-style formula recomputation.

## Why

The version most people write by hand is a recursive DFS with a `visited` set:

```ts
const visit = (n: string) => {
  if (seen.has(n)) return;
  seen.add(n);
  for (const d of deps[n] ?? []) visit(d);
  out.push(n);
};
```

That is correct only on a graph you already know is acyclic, and every real graph fails it in a specific way.

**Cycles produce a silently bogus order.** `visited` is marked before recursion, so `a -> b -> a` terminates — but `a` gets pushed after `b`, which was pushed after `a` was already marked. The output violates the ordering constraint with no error. Fixing it properly needs a second "in progress" colour set and a distinct `onStack` check, which is where hand-rolled versions usually go subtly wrong.

**Failure is all-or-nothing.** Once cycle detection is added, the natural implementation throws on the first back-edge. But in a build system you rarely want to abort everything — you want to run the 400 tasks that *are* schedulable and report the 3 that are tangled.

**Missing nodes widen the node set.** `deps[n]` routinely references ids not in `nodes` (an optional dependency, a package outside the workspace, a stale entry); the naive `visit` recurses into them and emits them.

**Deep graphs blow the stack**, since recursion depth is proportional to the longest chain and a few thousand transitive dependencies is enough.

`topoSort` is iterative (no stack limit), partial-failure-aware (schedulable nodes still come back in `order`), closed over `nodes` (nothing outside the given id list ever appears in the output), and deterministic.

## How it works

Kahn's algorithm, not DFS. The distinguishing feature is the **in-degree map**: for each node, a count of how many of its dependencies are still unsatisfied.

**Phase 1 — seed.** Every id in `nodes` gets `inDegree = 0` and an empty `dependents` array. Doing this up front frees the rest of the code from "does this key exist" checks, and it defines the node set: an id not in `nodes` has no entry, and every later lookup filters it out.

**Phase 2 — build the reverse graph and count.** For each `node` and each `dep` in `deps[node]`:

```ts
if (!inDegree.has(dep)) continue;              // edge points outside `nodes` — drop it
inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
dependents.get(dep)?.push(node);
```

Two structures are built in one pass. `inDegree[node]` counts the dependencies of `node` actually in the node set; `dependents[dep]` is the **inverted edge list** of nodes waiting on `dep`. That inversion is exactly what [`reverseDependencies`](../reverse-dependencies/README.md) does standalone — Kahn's algorithm needs it because the traversal runs forward along "unblocks" edges while the input is expressed as "depends on" edges.

The increment and the push happen together, once per edge occurrence, which is why duplicate edges are harmless: `b: ["a", "a"]` gives `b` an in-degree of 2 *and* puts `b` into `dependents["a"]` twice, so processing `a` decrements twice. The two errors cancel exactly, and no deduplication is needed.

**Phase 3 — drain the queue,** seeded with every node whose in-degree is 0, in the order those nodes appear in `nodes`:

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

Emitting a node means "its dependencies are all already in `order`"; decrementing a dependent means "one more of your blockers is done". A node enters the queue at the exact moment its last blocker is emitted, and only then — `next === 0` is checked on the decremented value, so each node is enqueued exactly once. The **invariant**: at every iteration `inDegree[n]` equals the number of `n`'s in-set dependencies not yet pushed to `order`, true after phase 2 and preserved because each decrement pairs one-to-one with a push.

**Phase 4 — cycle detection falls out for free.** No colouring, no back-edge check: a node reaches the queue only when its in-degree hits 0, and a node on a cycle has a blocker transitively blocked by itself, so its count never reaches 0. Whatever is missing from `order` once the queue drains is unschedulable — the "processed count < node count" test, expressed as `nodes.filter((n) => !ordered.has(n))` so you get the offending ids rather than a boolean.

**`cyclic` means "cannot ever run", not "sits on a cycle".** This is the most important thing about the return value. If `a <-> b` is a cycle and `c` depends on `a`, then `c` is reported as cyclic too — it is on no cycle, but its dependency never resolves. Nodes *upstream* of a cycle are unaffected and appear in `order` normally. That is almost always the right semantics for scheduling (the set of things you must skip), but it is not the set you want to print the cycle itself; for that, run an SCC algorithm over `cyclic`.

**Ordering among independent nodes.** Two nodes with no path between them may appear in either order and both are valid topological sorts; this implementation pins the choice so runs are reproducible. The initial queue comes from `nodes.filter(...)`, so roots come out in the order you listed them; `dependents` arrays are appended in `nodes` iteration order, so ties follow `nodes` order too; and FIFO (`shift`) rather than LIFO makes the output layered breadth-first — `topoSort(["a","b","c","d","e"], { c: ["a"], d: ["a"], e: ["b"] })` yields `["a","b","c","d","e"]`, both roots before any dependent. Swapping `shift()` for `pop()` would still be a valid topological order, just depth-first-looking. The `nodes` array is the sole tie-breaker; sort it before calling for alphabetical output.

**Complexity.** Phases 1, 2 and 4 are O(V + E), and the drain visits each node and edge once. The one wart is `Array.prototype.shift()`, O(n) in the general case, making the strict worst case O(V² + E) — in practice V8 handles shift on packed arrays cheaply, and if you need the guarantee, replacing `shift()` with a head index (`let head = 0; ... queue[head++]`) makes it a true O(V + E) with no other changes. Space is O(V + E) for the two maps. Neither argument is mutated; all working state is allocated inside the function.

## API

### `topoSort`

```ts
function topoSort(nodes: string[], deps: Record<string, string[]>): TopoSortResult;
```

- `nodes` — the complete set of node ids to schedule. Defines the universe: any id not in this list is invisible, whether it appears as a key of `deps` or as an edge target. Also the tie-breaker for output ordering. Assumed to contain unique ids; duplicates are not removed.
- `deps` — `deps[node]` lists the ids `node` depends on, i.e. those that must come *before* it. Missing keys are treated as an empty array, extra keys for ids not in `nodes` are ignored, and duplicate entries within an array are harmless.

Never throws.

### `TopoSortResult`

```ts
interface TopoSortResult {
  readonly order: string[];   // schedulable nodes, each after all its dependencies
  readonly cyclic: Set<string>; // nodes on a cycle, plus everything transitively downstream
}
```

For a `nodes` array of unique ids, `order.length + cyclic.size === nodes.length` and the two are disjoint.

## Usage

```ts
import { topoSort } from "@isel-jao/ts-lib";

const { order, cyclic } = topoSort(["app", "ui", "core"], {
  app: ["ui", "core"],
  ui: ["core"],
});
order;  // ["core", "ui", "app"]
cyclic; // Set {}
```

Partial failure — run what you can, report what you cannot:

```ts
const { order, cyclic } = topoSort(["lint", "build", "test", "docs", "site"], {
  build: ["lint"],
  test: ["build"],
  docs: ["site"],
  site: ["docs"], // circular
});

for (const task of order) await run(task); // lint, build, test
if (cyclic.size > 0) console.error(`skipped (unresolvable deps): ${[...cyclic].join(", ")}`);
```

Incremental rebuild — invert the graph to find the blast radius, then sort that subgraph for a safe rebuild order:

```ts
import { reverseDependencies, topoSort } from "@isel-jao/ts-lib";

const deps = new Map([
  ["core", new Set<string>()],
  ["ui", new Set(["core"])],
  ["app", new Set(["ui", "core"])],
  ["cli", new Set(["core"])],
]);

const dependents = reverseDependencies(deps);
const affected = new Set<string>(["core"]);
const stack = ["core"];
while (stack.length > 0) {
  for (const d of dependents.get(stack.pop() as string) ?? []) {
    if (!affected.has(d)) { affected.add(d); stack.push(d); }
  }
}

const { order } = topoSort(
  [...affected],
  Object.fromEntries([...deps].map(([n, d]) => [n, [...d]]))
);
order; // ["core", "ui", "cli", "app"] — core first, app last
```

## Edge cases

| Input | Result |
| --- | --- |
| `topoSort([], {})` | `{ order: [], cyclic: Set {} }` |
| Single node, no deps | emitted as-is |
| Dep target not in `nodes` (`a: ["ghost"]`) | edge dropped; `a` stays a root |
| `deps` key not in `nodes` (`{ stranger: ["a"] }`) | entry ignored entirely |
| Duplicate edge (`b: ["a", "a"]`) | counted twice on both sides; cancels out, order correct |
| Self-dependency (`a: ["a"]`) | `a` is cyclic, `order` empty |
| 2-cycle / longer cycle | all members in `cyclic`, none in `order` |
| Node downstream of a cycle | reported in `cyclic` — it can never run |
| Node upstream of a cycle | reported in `order` — unaffected |
| Several disjoint cycles plus a clean component | clean component in `order`, all cycle members in `cyclic` |
| Mutually independent nodes | ordered by their position in `nodes` |
| Duplicate id in `nodes` | not deduplicated; a duplicated root appears twice in `order`. Pass unique ids |
| Very deep chains | fine — the algorithm is iterative, no recursion limit |
