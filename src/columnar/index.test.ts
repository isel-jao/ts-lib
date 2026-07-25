import { describe, expect, it } from "vitest";
import { fromColumnar, toColumnarByAllKeys, toColumnarByFirstKeys } from "./index";

describe("toColumnarByFirstKeys", () => {
  it("converts an array of objects into arrays keyed by column", () => {
    expect(
      toColumnarByFirstKeys([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ])
    ).toEqual({ a: [1, 3], b: [2, 4] });
  });

  it("returns an empty object for an empty array", () => {
    expect(toColumnarByFirstKeys([])).toEqual({});
  });

  it("handles a single object", () => {
    expect(toColumnarByFirstKeys([{ a: 1, b: "x" }])).toEqual({
      a: [1],
      b: ["x"],
    });
  });

  it("takes its columns from the first object's keys, in order", () => {
    expect(
      Object.keys(
        toColumnarByFirstKeys([
          { b: 1, a: 2 },
          { b: 3, a: 4 },
        ])
      )
    ).toEqual(["b", "a"]);
  });

  it("fills missing keys with undefined so columns stay aligned", () => {
    expect(toColumnarByFirstKeys([{ a: 1, b: 2 }, { a: 3 }])).toEqual({
      a: [1, 3],
      b: [2, undefined],
    });
  });

  it("ignores keys absent from the first object", () => {
    expect(toColumnarByFirstKeys([{ a: 1 }, { a: 2, b: 3 }])).toEqual({
      a: [1, 2],
    });
  });

  it("preserves value types within a column", () => {
    expect(
      toColumnarByFirstKeys([
        { id: "a", active: true },
        { id: "b", active: false },
      ])
    ).toEqual({ id: ["a", "b"], active: [true, false] });
  });

  it("keeps explicit undefined values distinct from missing keys", () => {
    expect(toColumnarByFirstKeys([{ a: undefined }, { a: 1 }])).toEqual({
      a: [undefined, 1],
    });
  });
});

describe("toColumnarByAllKeys", () => {
  it("converts an array of objects into arrays keyed by column", () => {
    expect(
      toColumnarByAllKeys([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ])
    ).toEqual({ a: [1, 3], b: [2, 4] });
  });

  it("returns an empty object for an empty array", () => {
    expect(toColumnarByAllKeys([])).toEqual({});
  });

  it("unions keys across all objects, filling gaps with undefined", () => {
    expect(toColumnarByAllKeys([{ a: 1 }, { b: 2 }])).toEqual({
      a: [1, undefined],
      b: [undefined, 2],
    });
  });

  it("orders columns by first appearance", () => {
    expect(Object.keys(toColumnarByAllKeys([{ b: 1 }, { a: 2, c: 3 }]))).toEqual(["b", "a", "c"]);
  });

  it("includes keys that only appear on later objects", () => {
    expect(toColumnarByAllKeys([{ a: 1 }, { a: 2, b: 3 }])).toEqual({
      a: [1, 2],
      b: [undefined, 3],
    });
  });

  it("keeps explicit undefined values distinct from missing keys", () => {
    expect(toColumnarByAllKeys([{ a: undefined }, { a: 1 }])).toEqual({
      a: [undefined, 1],
    });
  });
});

describe("fromColumnar", () => {
  it("converts columns into an array of row objects", () => {
    expect(fromColumnar({ a: [1, 3], b: [2, 4] })).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it("returns an empty array for an empty object", () => {
    expect(fromColumnar({})).toEqual([]);
  });

  it("handles a single column", () => {
    expect(fromColumnar({ a: [1, 2, 3] })).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("preserves column order within each row", () => {
    const [firstRow] = fromColumnar({ b: [1], a: [2] });
    expect(Object.keys(firstRow ?? {})).toEqual(["b", "a"]);
  });

  it("uses the longest column and fills short columns with undefined", () => {
    expect(fromColumnar({ a: [1, 2], b: [3] })).toEqual([
      { a: 1, b: 3 },
      { a: 2, b: undefined },
    ]);
  });

  it("round-trips values produced by toColumnarByFirstKeys", () => {
    const rows = [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ];
    expect(fromColumnar(toColumnarByFirstKeys(rows))).toEqual(rows);
  });
});
