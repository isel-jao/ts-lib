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
