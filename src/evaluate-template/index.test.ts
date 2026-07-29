import { describe, expect, it } from "vitest";

import { evaluateTemplate } from "./index";

describe("evaluateTemplate", () => {
  describe("literal strings", () => {
    it("parses keyword literals", () => {
      expect(evaluateTemplate("true", {})).toBe(true);
      expect(evaluateTemplate("false", {})).toBe(false);
      expect(evaluateTemplate("null", {})).toBe(null);
      expect(evaluateTemplate("undefined", {})).toBe(undefined);
    });

    it("parses numbers", () => {
      expect(evaluateTemplate("10", {})).toBe(10);
      expect(evaluateTemplate("-3.14", {})).toBe(-3.14);
      expect(evaluateTemplate("1e3", {})).toBe(1000);
      expect(evaluateTemplate("NaN", {})).toBeNaN();
      expect(evaluateTemplate("Infinity", {})).toBe(Number.POSITIVE_INFINITY);
      expect(evaluateTemplate("-Infinity", {})).toBe(Number.NEGATIVE_INFINITY);
    });

    it("unwraps quoted strings", () => {
      expect(evaluateTemplate('"hello"', {})).toBe("hello");
      expect(evaluateTemplate("'hello'", {})).toBe("hello");
      // quoting is the escape hatch to force a string
      expect(evaluateTemplate('"true"', {})).toBe("true");
    });

    it("parses objects with unquoted keys", () => {
      expect(evaluateTemplate("{x: 10}", {})).toEqual({ x: 10 });
      expect(evaluateTemplate("{}", {})).toEqual({});
      expect(evaluateTemplate('{a: {b: [1, "two", true]}, "c d": null}', {})).toEqual({
        a: { b: [1, "two", true] },
        "c d": null,
      });
      expect(evaluateTemplate("{x: 1,}", {})).toEqual({ x: 1 });
    });

    it("parses arrays", () => {
      expect(evaluateTemplate("[1, 2, 3]", {})).toEqual([1, 2, 3]);
      expect(evaluateTemplate("[]", {})).toEqual([]);
    });

    it("trims before parsing", () => {
      expect(evaluateTemplate(" 10 ", {})).toBe(10);
      expect(evaluateTemplate(" {x: 1} ", {})).toEqual({ x: 1 });
    });
  });

  describe("invalid literals fall back to the (trimmed) string", () => {
    it("keeps near-misses as strings", () => {
      expect(evaluateTemplate("truee", {})).toBe("truee");
      expect(evaluateTemplate("10d", {})).toBe("10d");
      expect(evaluateTemplate("hello world", {})).toBe("hello world");
      expect(evaluateTemplate("", {})).toBe("");
      expect(evaluateTemplate("  hello  ", {})).toBe("hello");
    });

    it("rejects anything that is not pure data", () => {
      expect(evaluateTemplate("{x: 10 + 20}", {})).toBe("{x: 10 + 20}");
      expect(evaluateTemplate("[1, foo()]", {})).toBe("[1, foo()]");
      expect(evaluateTemplate("n = 5", {})).toBe("n = 5");
      expect(evaluateTemplate("(10)", {})).toBe("(10)");
      expect(evaluateTemplate("[...rest]", {})).toBe("[...rest]");
    });
  });

  describe("literal grammar", () => {
    it("parses every JS number form", () => {
      expect(evaluateTemplate("0x1f", {})).toBe(31);
      expect(evaluateTemplate("0o17", {})).toBe(15);
      expect(evaluateTemplate("0b1010", {})).toBe(10);
      expect(evaluateTemplate("1_000", {})).toBe(1000);
      expect(evaluateTemplate("10.", {})).toBe(10);
      expect(evaluateTemplate(".5", {})).toBe(0.5);
      expect(evaluateTemplate("+3", {})).toBe(3);
      expect(evaluateTemplate("- -3", {})).toBe(3);
      expect(evaluateTemplate("-0", {})).toBe(-0);
    });

    it("rejects numbers that run into something else", () => {
      expect(evaluateTemplate("1n", {})).toBe("1n");
      expect(evaluateTemplate("0x", {})).toBe("0x");
      expect(evaluateTemplate("1.2.3", {})).toBe("1.2.3");
      // "--" is an increment operator, not two signs
      expect(evaluateTemplate("--1", {})).toBe("--1");
    });

    it("decodes string escapes", () => {
      expect(evaluateTemplate('"a\\nb"', {})).toBe("a\nb");
      expect(evaluateTemplate('"\\x41\\u0042\\u{43}"', {})).toBe("ABC");
      expect(evaluateTemplate("'\\101'", {})).toBe("A");
      expect(evaluateTemplate("'\\0'", {})).toBe("\0");
      // an unknown escape is the character itself
      expect(evaluateTemplate("'\\q'", {})).toBe("q");
      // a backslash before a line break continues the line
      expect(evaluateTemplate("'a\\\nb'", {})).toBe("ab");
    });

    it("rejects malformed strings", () => {
      expect(evaluateTemplate('"unterminated', {})).toBe('"unterminated');
      expect(evaluateTemplate('"\\u00zz"', {})).toBe('"\\u00zz"');
      expect(evaluateTemplate("'a\nb'", {})).toBe("'a\nb'");
    });

    it("accepts keys of every shape", () => {
      expect(evaluateTemplate("{class: 1, 2: 'b', 'c d': 3}", {})).toEqual({
        class: 1,
        2: "b",
        "c d": 3,
      });
      const parsed = evaluateTemplate("{__proto__: 1}", {}) as object;
      expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    });

    it("rejects syntax that is not pure data", () => {
      expect(evaluateTemplate("{x}", {})).toBe("{x}");
      expect(evaluateTemplate("{[k]: 1}", {})).toBe("{[k]: 1}");
      expect(evaluateTemplate("{...a}", {})).toBe("{...a}");
      expect(evaluateTemplate("{get x() {}}", {})).toBe("{get x() {}}");
      expect(evaluateTemplate("[1,,2]", {})).toBe("[1,,2]");
      expect(evaluateTemplate("`tpl`", {})).toBe("`tpl`");
    });

    it("skips comments between tokens", () => {
      expect(evaluateTemplate("{a: 1 /* two */, b: 2}", {})).toEqual({
        a: 1,
        b: 2,
      });
      expect(evaluateTemplate("[1] // done", {})).toEqual([1]);
      // an unterminated block comment is not a comment
      expect(evaluateTemplate("[1] /* oops", {})).toBe("[1] /* oops");
    });
  });

  describe("whole-string templates return the raw value", () => {
    it("evaluates expressions against ctx", () => {
      expect(evaluateTemplate("{{num}}", { num: 10 })).toBe(10);
      expect(evaluateTemplate("{{10 + 20}}", {})).toBe(30);
      expect(evaluateTemplate('{{"hello" + "world"}}', {})).toBe("helloworld");
      expect(evaluateTemplate("{{Math.max(1, 2)}}", {})).toBe(2);
      expect(
        evaluateTemplate("{{items.filter((x) => x > 1)}}", {
          items: [1, 2, 3],
        })
      ).toEqual([2, 3]);
    });

    it("preserves identity and non-JSON types", () => {
      const user = { name: "a" };
      expect(evaluateTemplate("{{user}}", { user })).toBe(user);
      const fn = () => 1;
      expect(evaluateTemplate("{{fn}}", { fn })).toBe(fn);
      const date = new Date();
      expect(evaluateTemplate("{{date}}", { date })).toBe(date);
      // raw values are returned untouched, even untrimmed strings
      expect(evaluateTemplate("{{s}}", { s: " a " })).toBe(" a ");
    });

    it("is whole-string even with surrounding whitespace", () => {
      const user = { name: "a" };
      expect(evaluateTemplate("  {{user}}  ", { user })).toBe(user);
    });

    it("never throws: bad expressions yield undefined", () => {
      expect(evaluateTemplate("{{missing}}", {})).toBe(undefined);
      expect(evaluateTemplate("{{foo.bar.baz}}", { foo: {} })).toBe(undefined);
      expect(evaluateTemplate("{{(}}", {})).toBe(undefined);
      expect(evaluateTemplate("{{}}", {})).toBe(undefined);
      expect(evaluateTemplate("{{throw new Error('x')}}", {})).toBe(undefined);
    });
  });

  describe("templates embedded in a structure", () => {
    it("injects evaluated values so the result parses as a literal", () => {
      expect(evaluateTemplate('{x: {{10 + 20}}, y: {{"hello" + "world"}}}', {})).toEqual({
        x: 30,
        y: "helloworld",
      });
      expect(evaluateTemplate("[{{a}}, {{b}}]", { a: 1, b: 2 })).toEqual([1, 2]);
    });

    it("preserves reference identity in structures", () => {
      const obj = { x: 1 };
      const result = evaluateTemplate("{obj: {{obj}} }", { obj }) as {
        obj: unknown;
      };
      expect(result).toEqual({ obj: { x: 1 } });
      expect(result.obj).toBe(obj);
    });

    it("preserves reference identity in arrays", () => {
      const obj = { x: 1 };
      const result = evaluateTemplate("[{{a}}, {{obj}}]", {
        a: 1,
        obj,
      }) as unknown[];
      expect(result).toEqual([1, { x: 1 }]);
      expect(result[1]).toBe(obj);
      const nested = evaluateTemplate("{items: [{{obj}}]}", { obj }) as {
        items: unknown[];
      };
      expect(nested.items[0]).toBe(obj);
    });

    it("preserves non-JSON types in structures", () => {
      const date = new Date();
      const fn = () => 1;
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = evaluateTemplate("{d: {{d}}, f: {{f}}, c: {{c}}}", {
        d: date,
        f: fn,
        c: circular,
      }) as { d: unknown; f: unknown; c: unknown };
      expect(result.d).toBe(date);
      expect(result.f).toBe(fn);
      expect(result.c).toBe(circular);
    });

    it("evaluates templates in key position", () => {
      expect(evaluateTemplate("{ {{k}}: 1 }", { k: "name" })).toEqual({
        name: 1,
      });
    });

    it("treats a quoted template as text", () => {
      expect(evaluateTemplate('{x: "{{a}}"}', { a: 1 })).toEqual({ x: "1" });
    });

    it("does not confuse NUL characters in the doc with sentinels", () => {
      expect(evaluateTemplate("{x: {{a}}, y: '\u0000'}", { a: 1 })).toEqual({
        x: 1,
        y: "\u0000",
      });
    });

    it("supports undefined and non-finite numbers in structures", () => {
      expect(evaluateTemplate("{v: {{missing}}}", {})).toEqual({
        v: undefined,
      });
      expect(evaluateTemplate("{n: {{0 / 0}}}", {})).toEqual({ n: Number.NaN });
      expect(evaluateTemplate("{n: {{1 / 0}}}", {})).toEqual({
        n: Number.POSITIVE_INFINITY,
      });
    });
  });

  describe("templates embedded in text", () => {
    it("splices serialized values and trims the result", () => {
      expect(evaluateTemplate("{{num}} {{num}}", { num: 10 })).toBe("10 10");
      expect(evaluateTemplate(" {{num}} {{num}} ", { num: 10 })).toBe("10 10");
      expect(evaluateTemplate("hello {{name}}", { name: "world" })).toBe("hello world");
    });

    it("injects an empty string for undefined and null", () => {
      expect(evaluateTemplate("hello {{missing}}!", {})).toBe("hello !");
      // trailing empty injection is then trimmed away
      expect(evaluateTemplate("hello {{missing}}", {})).toBe("hello");
    });

    it("serializes values textually when the doc is not a structure", () => {
      const fn = function greet() {};
      expect(evaluateTemplate("id: {{fn}}", { fn })).toBe(`id: ${fn.toString()}`);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(evaluateTemplate("x: {{c}}", { c: circular })).toBe("x: [object Object]");
    });

    it("re-parses the spliced text as a literal", () => {
      // the final string is subject to the same literal-or-string rule
      expect(evaluateTemplate("{{a}}{{b}}", { a: "1", b: "0" })).toBe(10);
      expect(evaluateTemplate("{{a}}{{b}}", { a: "tru", b: "e" })).toBe(true);
      expect(evaluateTemplate("{{x}}%", { x: 100 })).toBe("100%");
    });
  });

  describe("ctx binding", () => {
    it("ignores ctx keys that cannot be identifiers without breaking others", () => {
      expect(evaluateTemplate("{{num}}", { "foo-bar": 1, num: 2 })).toBe(2);
      expect(evaluateTemplate("{{num}}", { class: 1, num: 2 })).toBe(2);
      expect(evaluateTemplate("{{class}}", { class: 1 })).toBe(undefined);
    });
  });

  describe("onError", () => {
    it("observes a failing expression, which still evaluates to undefined", () => {
      const failures: string[] = [];
      const result = evaluateTemplate("{{missing.value}}", {}, (error, expr) =>
        failures.push(`${expr.trim()}: ${(error as Error).message}`)
      );
      expect(result).toBeUndefined();
      expect(failures).toEqual(["missing.value: missing is not defined"]);
    });

    it("is not called for successful expressions or plain strings", () => {
      const failures: unknown[] = [];
      const onError = (error: unknown) => failures.push(error);
      expect(evaluateTemplate("{{a + 1}}", { a: 1 }, onError)).toBe(2);
      expect(evaluateTemplate("plain text", {}, onError)).toBe("plain text");
      expect(failures).toEqual([]);
    });

    it("reports each failing template independently", () => {
      const failures: unknown[] = [];
      const result = evaluateTemplate("{a: {{boom.x}}, b: {{ok}}}", { ok: 5 }, (error) =>
        failures.push(error)
      );
      expect(result).toEqual({ a: undefined, b: 5 });
      expect(failures).toHaveLength(1);
    });
  });
});
