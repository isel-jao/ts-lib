export function createSyncFunction(
  doc: string,
  context: Record<string, unknown> = {},
): (...args: unknown[]) => unknown {
  const syncFunction = new Function(
    ...Object.keys(context),
    "...args",
    doc,
  ) as (...params: unknown[]) => unknown;

  return (...args: unknown[]): unknown => {
    return syncFunction(...Object.values(context), ...args);
  };
}

export function createAsyncFunction(
  doc: string,
  context: Record<string, unknown> = {},
): (...args: unknown[]) => Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as new (
    ...params: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  const asyncFunction = new AsyncFunction(
    ...Object.keys(context),
    "...args",
    doc,
  );

  return async (...args: unknown[]): Promise<unknown> => {
    return asyncFunction(...Object.values(context), ...args);
  };
}
