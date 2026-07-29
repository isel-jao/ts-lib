type ArrayOrObject = readonly unknown[] | Record<string, unknown>;

export type Templated<T> =
  | (T extends ArrayOrObject ? { [K in keyof T]: Templated<T[K]> } : T)
  | string;

export type TemplatedRecord<T extends Record<string, unknown>> = {
  [K in keyof T]: Templated<T[K]>;
};
