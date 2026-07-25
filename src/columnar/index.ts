/**
 * Converts an array of uniformly-shaped objects (row-oriented) into a single
 * object of arrays (column-oriented). The columns are the keys of the **first**
 * object; each column holds that key's value from every row, in row order.
 * Rows missing one of those keys get `undefined`, so all columns share the
 * length of `objs`. Keys that only appear on later objects are ignored.
 *
 * This is the fast path: it reads the schema once from the first object. Use
 * {@link toColumnarByAllKeys} when rows may have differing keys.
 *
 * @example
 * toColumnarByFirstKeys([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
 * // => { a: [1, 3], b: [2, 4] }
 */
export function toColumnarByFirstKeys<T extends Record<string, unknown>>(
  objs: readonly T[]
): { [K in keyof T]: T[K][] } {
  const columns = {} as { [K in keyof T]: T[K][] };
  const [first] = objs;
  if (first === undefined) {
    return columns;
  }

  for (const key of Object.keys(first) as (keyof T)[]) {
    columns[key] = objs.map((obj) => obj[key]);
  }

  return columns;
}

/**
 * Like {@link toColumnarByFirstKeys}, but the columns are the **union** of
 * every key that appears on any object, ordered by first appearance. Rows
 * missing a key contribute `undefined`, so all columns share the length of
 * `objs`.
 *
 * Use this when rows may have differing shapes; it costs an extra pass to
 * gather the full set of keys. When every row has the same keys, prefer
 * {@link toColumnarByFirstKeys}.
 *
 * @example
 * toColumnarByAllKeys([{ a: 1 }, { b: 2 }]);
 * // => { a: [1, undefined], b: [undefined, 2] }
 */
export function toColumnarByAllKeys<T extends Record<string, unknown>>(
  objs: readonly T[]
): { [K in keyof T]: T[K][] } {
  const columns = {} as { [K in keyof T]: T[K][] };
  const keys = new Set<keyof T>();

  for (const obj of objs) {
    for (const key of Object.keys(obj) as (keyof T)[]) {
      keys.add(key);
    }
  }

  for (const key of keys) {
    columns[key] = objs.map((obj) => obj[key]);
  }

  return columns;
}

/**
 * Converts a column-oriented object (arrays keyed by column) back into an array
 * of row objects — the inverse of the `toColumnarBy*` helpers above. The row
 * count is the length of the longest column; every row carries every key, with
 * `undefined` where a column is shorter than the row count.
 *
 * @example
 * fromColumnar({ a: [1, 3], b: [2, 4] });
 * // => [{ a: 1, b: 2 }, { a: 3, b: 4 }]
 */
export function fromColumnar<T extends Record<string, unknown>>(
  columns: {
    [K in keyof T]: readonly T[K][];
  }
): T[] {
  const entries = Object.entries(columns);

  let rowCount = 0;
  for (const [, column] of entries) {
    rowCount = Math.max(rowCount, column.length);
  }

  const rows: T[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row = {} as Record<string, unknown>;
    for (const [key, column] of entries) {
      row[key] = column[i];
    }
    rows.push(row as T);
  }

  return rows;
}
