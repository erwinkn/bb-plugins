import { describe, expect, it } from "vitest";
import {
  JsonBytes,
  splice,
  StringCheck,
  topLevelFields,
} from "./json-scan.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (body: Uint8Array) => new TextDecoder().decode(body);

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Whether the scanner accepts the text as exactly one JSON value, as JSON.parse does.
function scans(text: string): boolean {
  const json = new JsonBytes(bytes(text));
  const start = json.start;
  const end = json.skip(start);
  return end !== -1 && end === bytes(text.trimEnd()).length;
}

describe("JsonBytes", () => {
  it.each([
    "{}",
    "[]",
    ' { "a" : [ 1 , -2.5e+3 , true , false , null , "x" ] } ',
    '{"a":{"b":{"c":[[],[{}]]}}}',
    '"just a string"',
    "0",
    "-0.0E-0",
    '{"q":"a \\" quote, a \\\\ slash, then \\\\\\" both"}',
    '{"u":"caf\\u00e9 \\ud83d\\ude00 ü"}',
    '{"\\u0061":1,"a":2}',
    `{"n":0.${"0".repeat(600)}1,"m":${"9".repeat(700)}}`,
    '{"n":1e400,"m":-0,"o":1E+2,"p":0.5e-3}',
  ])("accepts %s like JSON.parse", (text) => {
    expect(parses(text)).toBe(true);
    expect(scans(text)).toBe(true);
  });

  it.each([
    "",
    "{",
    '{"a":1,}',
    "[1,]",
    '{"a" 1}',
    '{"a":1 "b":2}',
    "[1 2]",
    '{a:1}',
    '{"a":01}',
    '{"a":1.}',
    '{"a":.5}',
    '{"a":tru}',
    '{"a":nulls}',
    '{"a":"unterminated}',
    '{"a":"escaped end\\"}',
    '{"a":1}}',
    "{} {}",
    "]",
    '{"a":"bad \\q escape"}',
    '{"a":"short \\u12g4"}',
    '{"a":"raw \u0001 control"}',
    '{"a":"raw\ttab"}',
    '{"a":-}',
    '{"a":1e}',
    '{"a":--1}',
    '{"a":+1}',
    '{"a":1.5.5}',
    '{"a":0x10}',
  ])("rejects %j like JSON.parse", (text) => {
    expect(parses(text)).toBe(false);
    expect(scans(text)).toBe(false);
  });

  it("reads members and elements with JSON.parse's view of keys, values and duplicates", () => {
    // Behind a byte order mark, which TextDecoder drops before JSON.parse sees it.
    const body = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...bytes(
        '{"model":"m1","list":[1,{"x":"}"},"]"],"model":"m2","caf\\u00e9":true,"nested":{"model":"no"}}',
      ),
    ]);
    const json = new JsonBytes(body);
    const seen: string[] = [];
    let elements = 0;
    expect(
      json.eachTopLevelMember((key, value) => {
        seen.push(key);
        if (key === "list")
          return json.eachElement(value, () => {
            elements += 1;
            return undefined;
          });
        return undefined;
      }),
    ).toBe(true);
    expect(seen).toEqual(["model", "list", "model", "café", "nested"]);
    expect(elements).toBe(3);
    expect(topLevelFields(body, new Set(["model", "café"]))).toEqual({
      model: "m2",
      café: true,
    });
  });

  it("finds no field in a body that is not a JSON object", () => {
    for (const text of ["[1]", '"s"', "nope", '{"a":1} x'])
      expect(topLevelFields(bytes(text), new Set(["a"]))).toBeNull();
  });

  it("skips deeply nested values without recursion", () => {
    const depth = 100_000;
    const text = `{"a":${"[".repeat(depth)}${"]".repeat(depth)},"b":2}`;
    expect(topLevelFields(bytes(text), new Set(["b"]))).toEqual({ b: 2 });
  });

  it("agrees with JSON.parse on random documents", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pieces = ['"', "\\", "\\\\", '\\"', "a", "é", "{", "}", "[", "]", ",", ":", " "];
    const value = (depth: number): unknown => {
      const kind = Math.floor(random() * (depth > 3 ? 4 : 6));
      if (kind === 0) return Math.floor(random() * 1e6) / 100;
      if (kind === 1) return [true, false, null][Math.floor(random() * 3)];
      if (kind === 2 || kind === 3)
        return Array.from({ length: Math.floor(random() * 6) }, () =>
          pieces[Math.floor(random() * pieces.length)],
        ).join("");
      if (kind === 4)
        return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      return Object.fromEntries(
        Array.from({ length: Math.floor(random() * 4) }, (_, index) => [
          `${pieces[Math.floor(random() * pieces.length)]}${index}`,
          value(depth + 1),
        ]),
      );
    };
    for (let round = 0; round < 500; round += 1) {
      const text = JSON.stringify({ model: value(0), rest: value(0) }, null, round % 2 ? 1 : 0);
      expect(scans(text)).toBe(true);
      expect(topLevelFields(bytes(text), new Set(["model", "rest"]))).toEqual(JSON.parse(text));
      // Cutting a document short never leaves valid JSON behind.
      const cut = text.slice(0, Math.floor(random() * text.length));
      expect(scans(cut)).toBe(parses(cut));
    }
  });
});

describe("string and number checks", () => {
  let seed = 11;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const noise = ["\\", '"', "\u0001", "\n", "\t", "u", "x", "0", "e", ".", "-", "}", ",", "é"];

  // The body read after StringCheck saw it in random chunks, as the hub reads a request.
  function arrived(body: Uint8Array): Uint8Array {
    const check = new StringCheck();
    for (let offset = 0; offset < body.length; ) {
      const size = 1 + Math.floor(random() * 9);
      check.push(body.subarray(offset, offset + size));
      offset += size;
    }
    check.finish(body);
    return body;
  }

  it("accepts a corrupted document exactly when JSON.parse does, checked on arrival or not", () => {
    let accepted = 0;
    for (let round = 0; round < 3_000; round += 1) {
      const document = {
        model: "claude",
        text: 'a "quoted" \\ path\nnext \u00e9 \ud83d\ude00',
        list: [1, -2.5e3, true, null, { k: "v" }],
      };
      const chars = Array.from(JSON.stringify(document));
      for (let edit = 0; edit < 1 + Math.floor(random() * 2); edit += 1)
        chars.splice(
          Math.floor(random() * chars.length),
          Math.floor(random() * 2),
          noise[Math.floor(random() * noise.length)],
        );
      const text = chars.join("");
      const expected = parses(text) && typeof JSON.parse(text) === "object";
      const fields = new Set(["model", "text", "list"]);
      const cold = topLevelFields(bytes(text), fields);
      const warm = topLevelFields(arrived(bytes(text)), fields);
      expect(cold !== null).toBe(expected);
      expect(warm !== null).toBe(expected);
      if (expected) {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const want = Object.fromEntries(
          [...fields].filter((key) => key in parsed).map((key) => [key, parsed[key]]),
        );
        expect(cold).toEqual(want);
        expect(warm).toEqual(want);
        accepted += 1;
      }
    }
    // Both outcomes are exercised.
    expect(accepted).toBeGreaterThan(300);
    expect(accepted).toBeLessThan(2_700);
  });

  it("flags numbers JSON.parse and JSON.stringify would not write back the same", () => {
    const canonical = (text: string) => {
      const json = new JsonBytes(bytes(text));
      expect(json.skip(json.start)).toBe(bytes(text).length);
      return json.canonicalNumbers;
    };
    expect(canonical('[0,-1,12.5,123456789012345,1e-7,"1.0"]')).toBe(true);
    for (const number of ["1.0", "1e2", "1e400", "-0", "12345678901234567890", "0.10"])
      expect(canonical(`[${number}]`)).toBe(false);
  });
});

describe("splice", () => {
  it("replaces spans and keeps every other byte", () => {
    const body = bytes('{"a":"x","b":"caf\\u00e9","c":1}');
    const out = splice(body, [
      { span: { start: 5, end: 8 }, text: '"long value"' },
      { span: { start: 29, end: 30 }, text: "2" },
    ]);
    expect(decode(out)).toBe('{"a":"long value","b":"caf\\u00e9","c":2}');
  });
});
