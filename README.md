# @isel-jao/ts-lib

A collection of small, general-purpose TypeScript utilities for everyday application code.

## Features

- **Zero dependencies** — nothing gets pulled into your bundle but this library itself.
- **Tree-shakeable** — ships as ES modules with no side effects, so bundlers only include the parts you actually import.
- **Type-safe** — written in TypeScript with full type definitions included.
- Works in both ESM and CommonJS projects.

## Installation

```bash
npm install @isel-jao/ts-lib
```

## Usage

Import only what you need — unused exports are automatically excluded from your final bundle.

```ts
import { /* ... */ } from "@isel-jao/ts-lib";
```

## Modules

Every module ships its own reference doc covering why it exists, how it works internally, its full API, and its edge cases.

| Module | What it does | Main exports |
| --- | --- | --- |
| [columnar](src/columnar/README.md) | Converts arrays of records to and from column-oriented form. | `toColumnarByFirstKeys`, `toColumnarByAllKeys`, `fromColumnar` |
| [console-styles](src/console-styles/README.md) | ANSI escape codes and an emoji set for styling terminal output. | `Ansi`, `Emoji` |
| [create-function](src/create-function/README.md) | Builds sync and async functions from source strings at runtime. | `createSyncFunction`, `createAsyncFunction` |
| [ensure-unique-name](src/ensure-unique-name/README.md) | Suffixes a name until it stops colliding with names already taken. | `ensureUniqueName` |
| [evaluate-template](src/evaluate-template/README.md) | Resolves `{{ ... }}` expressions against a context and parses the document into a typed value. | `evaluateTemplate`, `serialize`, `TEMPLATE_RE` |
| [http-error](src/http-error/README.md) | Typed error classes for the common 4xx/5xx statuses, with a JSON-serializable shape. | `HttpError`, `NotFoundError`, `createHttpError` |
| [registry](src/registry/README.md) | A named-value store that fails fast on duplicate registration. | `Registry` |
| [reverse-dependencies](src/reverse-dependencies/README.md) | Inverts a dependency graph to answer "what depends on this?". | `reverseDependencies` |
| [ring-buffer](src/ring-buffer/README.md) | Fixed-capacity circular buffer with O(1) insertion and removal at both ends. | `RingBuffer` |
| [topo-sort](src/topo-sort/README.md) | Topological sort with cycle detection. | `topoSort` |
| [utility-types](src/utility-types/README.md) | Derives the authored (pre-`evaluateTemplate`) shape of a config from its resolved shape. | `Templated`, `TemplatedRecord` |

> **Note:** `topo-sort` and `reverse-dependencies` are not currently re-exported from `src/index.ts`, so they cannot be imported from the package entry point yet.
