export function serialize(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data === null || data === undefined) {
    return "";
  }
  return String(data);
}

export const TEMPLATE_RE = /\{\{([\s\S]*?)\}\}/g;

type LiteralResult = { ok: true; value: unknown } | { ok: false };

export type TemplateErrorHandler = (error: unknown, expr: string) => void;

export function evaluateTemplate(
  doc: string,
  ctx: Record<string, unknown>,
  onError?: TemplateErrorHandler
): unknown {
  const source = doc.trim();
  const matches = [...source.matchAll(TEMPLATE_RE)];

  if (matches.length === 0) {
    const literal = parseLiteral(source);
    return literal.ok ? literal.value : source;
  }

  const evaluate = makeEvaluator(ctx, onError);

  // The whole string is a single template: return the raw evaluated value,
  // preserving type and identity (objects, dates, functions, undefined).
  const first = matches[0];
  if (matches.length === 1 && first && first.index === 0 && first[0].length === source.length) {
    return evaluate(first[1] ?? "");
  }

  const values = matches.map((match) => evaluate(match[1] ?? ""));

  // Pass 1 (structural): splice quoted sentinel strings so the result can
  // parse as a data literal, then swap each sentinel for its raw evaluated
  // value — references, dates, and functions survive inside structures,
  // e.g. `{x: {{1 + 2}}, y: {{obj}}}` -> `{x: 3, y: ctx.obj}`.
  // A NUL in the doc could forge a sentinel, so skip straight to pass 2.
  if (!source.includes("\u0000")) {
    const sentinels = new Map<string, number>();
    const tokens = values.map((_, index) => {
      const sentinel = `\u0000${index}\u0000`;
      sentinels.set(sentinel, index);
      return JSON.stringify(sentinel);
    });
    const literal = parseLiteral(splice(source, tokens));
    if (literal.ok) {
      const resolved = resolveSentinels(literal.value, sentinels, values);
      if (resolved.ok) return resolved.value;
    }
  }

  // Pass 2 (textual): splice serialized values as plain text.
  const text = splice(source, values.map(serialize)).trim();
  const literal = parseLiteral(text);
  return literal.ok ? literal.value : text;
}

function splice(source: string, tokens: string[]): string {
  let i = 0;
  return source.replace(TEMPLATE_RE, () => tokens[i++] ?? "");
}

// Rebuilds a parsed literal, swapping each sentinel string for its raw
// evaluated value (a sentinel in key position becomes a serialized key).
// Fails when a sentinel ended up embedded inside a longer string — the
// template sat inside quotes — so pass 2 can handle the doc textually.
function resolveSentinels(
  parsed: unknown,
  sentinels: Map<string, number>,
  values: unknown[]
): LiteralResult {
  if (typeof parsed === "string") {
    if (!parsed.includes("\u0000")) return { ok: true, value: parsed };
    const index = sentinels.get(parsed);
    if (index === undefined) return { ok: false };
    return { ok: true, value: values[index] };
  }
  if (Array.isArray(parsed)) {
    const arr: unknown[] = [];
    for (const element of parsed) {
      const resolved = resolveSentinels(element, sentinels, values);
      if (!resolved.ok) return resolved;
      arr.push(resolved.value);
    }
    return { ok: true, value: arr };
  }
  if (parsed !== null && typeof parsed === "object") {
    const obj: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
      let key = rawKey;
      if (rawKey.includes("\u0000")) {
        const index = sentinels.get(rawKey);
        if (index === undefined) return { ok: false };
        key = serialize(values[index]);
      }
      const resolved = resolveSentinels(rawValue, sentinels, values);
      if (!resolved.ok) return resolved;
      Object.defineProperty(obj, key, {
        value: resolved.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { ok: true, value: obj };
  }
  return { ok: true, value: parsed };
}

// A failed expression evaluates to undefined; `onError` observes the failure
// so callers that track errors (variables, bindings) can record it.
function makeEvaluator(ctx: Record<string, unknown>, onError?: TemplateErrorHandler) {
  const names = Object.keys(ctx).filter(isBindableName);
  const args = names.map((name) => ctx[name]);
  return (expr: string): unknown => {
    try {
      const fn = new Function(...names, `"use strict"; return (${expr}\n);`);
      return fn(...args);
    } catch (error) {
      onError?.(error, expr);
      return undefined;
    }
  };
}

// A ctx key can only be bound as a function parameter if it is a valid,
// non-reserved identifier ("foo-bar" or "class" would be a SyntaxError).
function isBindableName(name: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  try {
    new Function(name, '"use strict";');
    return true;
  } catch {
    return false;
  }
}

// Parses a string as a pure data literal (JSON plus unquoted keys, single
// quotes, undefined/NaN/Infinity, signed numbers). A hand-written recursive
// descent parser, so the library stays dependency-free — nothing is executed
// and no name is resolved. Any operator, call, or identifier fails, and a
// failure is never an error: the caller falls back to treating the doc as text.
function parseLiteral(src: string): LiteralResult {
  const cursor: Cursor = { src, pos: 0 };
  const result = parseValue(cursor);
  if (!result.ok) return { ok: false };
  skipSpace(cursor);
  // Trailing junk means the doc was never a literal, e.g. "10d" or "(10)".
  return cursor.pos === src.length ? result : { ok: false };
}

type Cursor = { src: string; pos: number };

const KEYWORDS = new Map<string, unknown>([
  ["true", true],
  ["false", false],
  ["null", null],
  ["undefined", undefined],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
]);

function parseValue(cursor: Cursor): LiteralResult {
  skipSpace(cursor);
  const char = cursor.src[cursor.pos];
  if (char === undefined) return { ok: false };
  if (char === '"' || char === "'") return parseString(cursor, char);
  if (char === "{") return parseObject(cursor);
  if (char === "[") return parseArray(cursor);
  if (char === "-" || char === "+") return parseSigned(cursor, char);
  if (char === "." || isDigit(char)) return parseNumber(cursor);
  const name = readIdentifier(cursor);
  if (name === undefined || !KEYWORDS.has(name)) return { ok: false };
  return { ok: true, value: KEYWORDS.get(name) };
}

// Recursive so `-Infinity`, `- -1` and `+NaN` all behave as JS does.
function parseSigned(cursor: Cursor, sign: string): LiteralResult {
  cursor.pos += 1;
  // `--` and `++` are increment operators, not two signs.
  if (cursor.src[cursor.pos] === sign) return { ok: false };
  const arg = parseValue(cursor);
  if (!arg.ok || typeof arg.value !== "number") return { ok: false };
  return { ok: true, value: sign === "-" ? -arg.value : arg.value };
}

const NUMBER_RE =
  /0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/y;

function parseNumber(cursor: Cursor): LiteralResult {
  NUMBER_RE.lastIndex = cursor.pos;
  const match = NUMBER_RE.exec(cursor.src);
  if (!match) return { ok: false };
  cursor.pos = NUMBER_RE.lastIndex;
  // A number cannot run straight into a word: "10d" and bigint "1n" are not
  // numbers, and letting them through would truncate the source silently.
  if (isIdentifierPart(cursor.src[cursor.pos])) return { ok: false };
  return { ok: true, value: Number(match[0].replace(/_/g, "")) };
}

function parseString(cursor: Cursor, quote: string): LiteralResult {
  const { src } = cursor;
  let pos = cursor.pos + 1;
  let value = "";
  while (pos < src.length) {
    const char = src[pos] as string;
    if (char === quote) {
      cursor.pos = pos + 1;
      return { ok: true, value };
    }
    // An unescaped line break ends the line, not the string: it is unterminated.
    if (char === "\n" || char === "\r") return { ok: false };
    if (char !== "\\") {
      value += char;
      pos += 1;
      continue;
    }
    const decoded = readEscape(src, pos + 1);
    if (decoded === undefined) return { ok: false };
    value += decoded.value;
    pos = decoded.pos;
  }
  return { ok: false };
}

type Escape = { value: string; pos: number } | undefined;

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function readEscape(src: string, pos: number): Escape {
  const char = src[pos];
  if (char === undefined) return undefined;
  // A backslash before a line break is a continuation and contributes nothing.
  if (char === "\r") {
    return { value: "", pos: src[pos + 1] === "\n" ? pos + 2 : pos + 1 };
  }
  if (char === "\n" || char === "\u2028" || char === "\u2029") {
    return { value: "", pos: pos + 1 };
  }
  if (char === "x") return readHex(src, pos + 1, 2);
  if (char === "u") return readUnicodeEscape(src, pos + 1);
  if (char >= "0" && char <= "7") return readOctalEscape(src, pos);
  // Every other escape is the character itself, e.g. `\'`, `\\`, `\/`, `\8`.
  return { value: SIMPLE_ESCAPES[char] ?? char, pos: pos + 1 };
}

const OCTAL_RE = /[0-7]{1,3}/y;

// `\0` is NUL and `\101` is "A". The highest legacy octal escape is `\377`,
// so a third digit only counts when the first two leave room for it.
function readOctalEscape(src: string, pos: number): Escape {
  OCTAL_RE.lastIndex = pos;
  const match = OCTAL_RE.exec(src);
  if (!match) return undefined;
  const digits = Number.parseInt(match[0], 8) > 0xff ? match[0].slice(0, 2) : match[0];
  return {
    value: String.fromCharCode(Number.parseInt(digits, 8)),
    pos: pos + digits.length,
  };
}

const HEX_RE = /^[\dA-Fa-f]+$/;

function readHex(src: string, pos: number, length: number): Escape {
  const digits = src.slice(pos, pos + length);
  if (digits.length !== length || !HEX_RE.test(digits)) return undefined;
  return {
    value: String.fromCharCode(Number.parseInt(digits, 16)),
    pos: pos + length,
  };
}

function readUnicodeEscape(src: string, pos: number): Escape {
  if (src[pos] !== "{") return readHex(src, pos, 4);
  const end = src.indexOf("}", pos + 1);
  if (end === -1) return undefined;
  const digits = src.slice(pos + 1, end);
  if (digits.length === 0 || !HEX_RE.test(digits)) return undefined;
  const code = Number.parseInt(digits, 16);
  if (code > 0x10ffff) return undefined;
  return { value: String.fromCodePoint(code), pos: end + 1 };
}

function parseObject(cursor: Cursor): LiteralResult {
  cursor.pos += 1;
  const obj: Record<string, unknown> = {};
  skipSpace(cursor);
  while (cursor.src[cursor.pos] !== "}") {
    const key = parseKey(cursor);
    if (key === undefined) return { ok: false };
    skipSpace(cursor);
    if (cursor.src[cursor.pos] !== ":") return { ok: false };
    cursor.pos += 1;
    const value = parseValue(cursor);
    if (!value.ok) return { ok: false };
    // defineProperty so a "__proto__" key becomes a plain own property
    Object.defineProperty(obj, key, {
      value: value.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    skipSpace(cursor);
    if (cursor.src[cursor.pos] !== ",") break;
    cursor.pos += 1;
    skipSpace(cursor);
  }
  if (cursor.src[cursor.pos] !== "}") return { ok: false };
  cursor.pos += 1;
  return { ok: true, value: obj };
}

// Keys are unquoted names (reserved words included), quoted strings, or
// numbers — computed keys, shorthand, spread, and accessors all fail.
function parseKey(cursor: Cursor): string | undefined {
  skipSpace(cursor);
  const char = cursor.src[cursor.pos];
  if (char === undefined) return undefined;
  if (char === '"' || char === "'") {
    const key = parseString(cursor, char);
    return key.ok ? (key.value as string) : undefined;
  }
  if (char === "." || isDigit(char)) {
    const key = parseNumber(cursor);
    return key.ok ? String(key.value) : undefined;
  }
  return readIdentifier(cursor);
}

function parseArray(cursor: Cursor): LiteralResult {
  cursor.pos += 1;
  const arr: unknown[] = [];
  skipSpace(cursor);
  while (cursor.src[cursor.pos] !== "]") {
    // Holes ("[1,,2]") and spread fail here: neither starts a value.
    const value = parseValue(cursor);
    if (!value.ok) return { ok: false };
    arr.push(value.value);
    skipSpace(cursor);
    if (cursor.src[cursor.pos] !== ",") break;
    cursor.pos += 1;
    skipSpace(cursor);
  }
  if (cursor.src[cursor.pos] !== "]") return { ok: false };
  cursor.pos += 1;
  return { ok: true, value: arr };
}

// ZWNJ and ZWJ are identifier parts, spelled as alternatives because a
// character class must not split a joined character sequence.
const IDENTIFIER_RE = /[$_\p{ID_Start}](?:[$\p{ID_Continue}]|\u200C|\u200D)*/uy;

function readIdentifier(cursor: Cursor): string | undefined {
  IDENTIFIER_RE.lastIndex = cursor.pos;
  const match = IDENTIFIER_RE.exec(cursor.src);
  if (!match) return undefined;
  cursor.pos = IDENTIFIER_RE.lastIndex;
  return match[0];
}

const IDENTIFIER_PART_RE = /[$\p{ID_Continue}]|\u200C|\u200D/u;

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && IDENTIFIER_PART_RE.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

const WHITESPACE_RE = /\s/;
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/;

// Whitespace and comments both separate tokens. An unterminated block comment
// is left in place, so the stray "/" fails wherever the parser stands.
function skipSpace(cursor: Cursor): void {
  const { src } = cursor;
  while (cursor.pos < src.length) {
    const char = src[cursor.pos] as string;
    if (WHITESPACE_RE.test(char)) {
      cursor.pos += 1;
      continue;
    }
    if (char !== "/") return;
    const next = src[cursor.pos + 1];
    if (next === "/") {
      let end = cursor.pos + 2;
      while (end < src.length && !LINE_BREAK_RE.test(src[end] as string)) {
        end += 1;
      }
      cursor.pos = end;
      continue;
    }
    if (next !== "*") return;
    const end = src.indexOf("*/", cursor.pos + 2);
    if (end === -1) return;
    cursor.pos = end + 2;
  }
}
