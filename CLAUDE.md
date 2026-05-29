# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm build          # compile to dist/ (ESM + CJS + .d.ts)
pnpm dev            # watch mode build
pnpm test           # vitest in watch mode
pnpm test:run       # vitest single run (CI)
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome lint
pnpm format         # biome format --write
pnpm check          # biome check --write (lint + format)
```

Run a single test file:
```bash
pnpm test src/ring-buffer/index.test.ts
```

## Architecture

This is a zero-dependency TypeScript utility library (`@isel-jao/ts-lib`) published as dual ESM/CJS via tsup.

**Module pattern:** each utility lives in its own directory under `src/` with a colocated test file (`index.ts` + `index.test.ts`). New modules must be re-exported from `src/index.ts` to be included in the package.

**Formatting (Biome):** 2-space indent, 100-char line width, double quotes, trailing commas (ES5), semicolons required.
