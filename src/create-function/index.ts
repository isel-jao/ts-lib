type CreateFunctionOptions = {
  doc: string;
  context?: Record<string, unknown>;
  params?: string[];
};

export function createSyncFunction(
  options: CreateFunctionOptions
): (...args: unknown[]) => unknown {
  const { doc, context = {}, params = [] } = options;
  const syncFunction = new Function(...Object.keys(context), params.join(","), doc) as (
    ...params: unknown[]
  ) => unknown;

  return (...args: unknown[]): unknown => {
    return syncFunction(...Object.values(context), ...args);
  };
}

export function createAsyncFunction(
  options: CreateFunctionOptions
): (...args: unknown[]) => Promise<unknown> {
  const { doc, context = {}, params = [] } = options;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...params: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  const asyncFunction = new AsyncFunction(...Object.keys(context), params.join(","), doc);

  return async (...args: unknown[]): Promise<unknown> => {
    return asyncFunction(...Object.values(context), ...args);
  };
}
