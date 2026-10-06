// Reads a few fields out of a large JSON request body without decoding or parsing all of it.
//
// A Claude Code or Codex request body is often several MB, nearly all of it string contents
// (files, tool results). JSON.parse would decode the whole body to a JS string, then build every
// object in it, on the event loop BB's server shares with every plugin. JsonBytes walks the bytes
// instead, in one pass: a string is skipped with a native byte search for its closing quote, and
// only the small values a caller asks for are decoded and parsed.
//
// A body is accepted exactly when JSON.parse would accept it: structure, literals, numbers and
// string syntax (escapes, no raw control characters) are all checked. Checking strings costs a
// byte-by-byte loop, about 1.2 ms per MB, so StringCheck does it chunk by chunk while a request
// body arrives; a body whose strings passed (or that one full walk accepted) is later walked with
// the fast native search for each closing quote.

// A value's bytes in the body: [start, end).
export interface Span {
  start: number;
  end: number;
}

// Called for each member of an object with its key, where its value starts and where its key
// starts. Returns where the value ends when it read the value itself (with skip, eachMember or
// eachElement), or undefined to have it skipped.
export type MemberVisitor = (
  key: string,
  value: number,
  keyStart: number,
) => number | undefined;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const LOWER_E = 0x65;
const UPPER_E = 0x45;
const LOWER_U = 0x75;
const LITERALS = ["true", "false", "null"].map((literal) =>
  Array.from(literal, (char) => char.charCodeAt(0)),
);
// Integers this long or shorter survive JSON.parse and JSON.stringify unchanged.
const MAX_EXACT_INTEGER_DIGITS = 15;
// The character after a backslash: 1 for a one-character escape, 2 for \u.
const ESCAPES = new Uint8Array(256);
for (const char of '"\\/bfnrt') ESCAPES[char.charCodeAt(0)] = 1;
ESCAPES[LOWER_U] = 2;
const HEX_DIGITS = new Uint8Array(256);
for (const char of "0123456789abcdefABCDEF") HEX_DIGITS[char.charCodeAt(0)] = 1;

// Bodies whose strings are all well-formed: their strings are skipped without checking again.
const checkedStrings = new WeakSet<Uint8Array>();

const decoder = new TextDecoder();

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end; index += 1)
    text += String.fromCharCode(bytes[index]);
  return text;
}

// Every method returns -1 for "not well-formed JSON here", and passes a -1 from a visitor on.
export class JsonBytes {
  // Buffer.indexOf is a memchr; Uint8Array.indexOf is several times slower per call.
  private readonly bytes: Buffer;
  private readonly stringsChecked: boolean;
  // False once a number was walked that JSON.parse then JSON.stringify would not write back the
  // same (1.0, 1e2, 1e400, -0, a long integer). A byte-level edit would keep its spelling.
  canonicalNumbers = true;

  constructor(private readonly body: Uint8Array) {
    this.bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    this.stringsChecked = checkedStrings.has(body);
  }

  // The start of the body's single top-level value, past whitespace and a byte order mark.
  get start(): number {
    const bytes = this.bytes;
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return this.space(bom ? 3 : 0);
  }

  isObject(at: number): boolean {
    return this.bytes[at] === OPEN_OBJECT;
  }

  isArray(at: number): boolean {
    return this.bytes[at] === OPEN_ARRAY;
  }

  isString(at: number): boolean {
    return this.bytes[at] === QUOTE;
  }

  isNull(at: number): boolean {
    return this.literal(at, LITERALS[2]) !== -1;
  }

  // eachMember over the top-level object. False when the body is not JSON or not an object.
  // Visitors must read every value they claim with this class's methods: a successful walk marks
  // the body's strings as checked.
  eachTopLevelMember(visit: MemberVisitor): boolean {
    const end = this.eachMember(this.start, visit);
    const valid = end !== -1 && this.space(end) === this.bytes.length;
    if (valid) checkedStrings.add(this.body);
    return valid;
  }

  // Visits the members of the object at `at` in order; returns the index just past it.
  eachMember(at: number, visit: MemberVisitor): number {
    const bytes = this.bytes;
    if (bytes[at] !== OPEN_OBJECT) return -1;
    let index = this.space(at + 1);
    if (bytes[index] === CLOSE_OBJECT) return index + 1;
    while (true) {
      const keyEnd = this.string(index);
      const value = this.colon(keyEnd);
      if (value === -1) return -1;
      const end =
        visit(this.keyText(index, keyEnd), value, index) ?? this.skip(value);
      if (end === -1) return -1;
      index = this.space(end);
      if (bytes[index] === CLOSE_OBJECT) return index + 1;
      if (bytes[index] !== COMMA) return -1;
      index = this.space(index + 1);
    }
  }

  // Visits where each element of the array at `at` starts; returns the index just past it.
  eachElement(
    at: number,
    visit: (value: number) => number | undefined,
  ): number {
    const bytes = this.bytes;
    if (bytes[at] !== OPEN_ARRAY) return -1;
    let index = this.space(at + 1);
    if (bytes[index] === CLOSE_ARRAY) return index + 1;
    while (true) {
      const end = visit(index) ?? this.skip(index);
      if (end === -1) return -1;
      index = this.space(end);
      if (bytes[index] === CLOSE_ARRAY) return index + 1;
      if (bytes[index] !== COMMA) return -1;
      index = this.space(index + 1);
    }
  }

  // The index just past the value starting at `at`. Iterative, so nesting costs no stack.
  skip(at: number): number {
    const bytes = this.bytes;
    const closers: number[] = [];
    let index = at;
    while (true) {
      // A value.
      index = this.space(index);
      const byte = bytes[index];
      if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
        const close = byte === OPEN_OBJECT ? CLOSE_OBJECT : CLOSE_ARRAY;
        index = this.space(index + 1);
        if (bytes[index] !== close) {
          closers.push(close);
          if (
            close === CLOSE_OBJECT &&
            (index = this.colon(this.string(index))) === -1
          )
            return -1;
          continue;
        }
        index += 1;
      } else if (byte === QUOTE) {
        if ((index = this.string(index)) === -1) return -1;
      } else if ((index = this.scalar(index)) === -1) return -1;
      // Then close containers until one continues with a comma.
      while (true) {
        if (closers.length === 0) return index;
        index = this.space(index);
        const close = closers[closers.length - 1];
        if (bytes[index] === close) {
          closers.pop();
          index += 1;
          continue;
        }
        if (bytes[index] !== COMMA) return -1;
        index = this.space(index + 1);
        if (
          close === CLOSE_OBJECT &&
          (index = this.colon(this.string(index))) === -1
        )
          return -1;
        break;
      }
    }
  }

  // The value at `at` and where it ends, or null when it is not well-formed.
  span(at: number): Span | null {
    const end = this.skip(at);
    return end === -1 ? null : { start: at, end };
  }

  // JSON.parse of one (small) value.
  parse(span: Span): unknown {
    const text = decoder.decode(this.bytes.subarray(span.start, span.end));
    return JSON.parse(text);
  }

  private space(at: number): number {
    const bytes = this.bytes;
    while (at < bytes.length && isSpace(bytes[at])) at += 1;
    return at;
  }

  // The index just past the closing quote of the string opening at `at`.
  private string(at: number): number {
    const bytes = this.bytes;
    if (bytes[at] !== QUOTE) return -1;
    if (!this.stringsChecked) return checkString(bytes, at + 1);
    let quote = bytes.indexOf(QUOTE, at + 1);
    while (quote !== -1) {
      let slashes = 0;
      while (bytes[quote - 1 - slashes] === BACKSLASH) slashes += 1;
      if (slashes % 2 === 0) return quote + 1;
      quote = bytes.indexOf(QUOTE, quote + 1);
    }
    return -1;
  }

  // A literal or a number, checked byte by byte against JSON's grammar.
  private scalar(at: number): number {
    for (const literal of LITERALS) {
      const end = this.literal(at, literal);
      if (end !== -1) return end;
    }
    const bytes = this.bytes;
    let index = at;
    if (bytes[index] === MINUS) index += 1;
    if (bytes[index] === ZERO) index += 1;
    else if (isDigit(bytes[index]))
      while (isDigit(bytes[index])) index += 1;
    else return -1;
    let integer = true;
    if (bytes[index] === DOT) {
      integer = false;
      index += 1;
      if (!isDigit(bytes[index])) return -1;
      while (isDigit(bytes[index])) index += 1;
    }
    if (bytes[index] === LOWER_E || bytes[index] === UPPER_E) {
      integer = false;
      index += 1;
      if (bytes[index] === PLUS || bytes[index] === MINUS) index += 1;
      if (!isDigit(bytes[index])) return -1;
      while (isDigit(bytes[index])) index += 1;
    }
    if (
      this.canonicalNumbers &&
      (!integer ||
        index - at > MAX_EXACT_INTEGER_DIGITS ||
        (bytes[at] === MINUS && bytes[at + 1] === ZERO))
    ) {
      const text = ascii(bytes, at, index);
      if (JSON.stringify(Number(text)) !== text) this.canonicalNumbers = false;
    }
    return index;
  }

  private literal(at: number, literal: readonly number[]): number {
    for (let index = 0; index < literal.length; index += 1)
      if (this.bytes[at + index] !== literal[index]) return -1;
    return at + literal.length;
  }

  // Skips the `:` after a key ending at `keyEnd` and returns where its value starts.
  private colon(keyEnd: number): number {
    if (keyEnd === -1) return -1;
    const colon = this.space(keyEnd);
    return this.bytes[colon] === COLON ? this.space(colon + 1) : -1;
  }

  private keyText(start: number, end: number): string {
    // Keys are short and nearly always plain ASCII, which needs no decoder.
    const bytes = this.bytes;
    let plain = end - start <= 66;
    for (let index = start + 1; plain && index < end - 1; index += 1)
      plain = bytes[index] < 0x80 && bytes[index] !== BACKSLASH;
    return plain
      ? ascii(bytes, start + 1, end - 1)
      : (JSON.parse(decoder.decode(bytes.subarray(start, end))) as string);
  }
}

// The body with each span replaced by its text. Spans are in body order and do not overlap, and
// each text is JSON (from JSON.stringify), so a checked body stays checked.
export function splice(
  body: Uint8Array,
  edits: ReadonlyArray<{ span: Span; text: string }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = edits.map((edit) => encoder.encode(edit.text));
  let length = body.length;
  edits.forEach((edit, index) => {
    length += encoded[index].length - (edit.span.end - edit.span.start);
  });
  const out = new Uint8Array(length);
  let read = 0;
  let write = 0;
  edits.forEach((edit, index) => {
    out.set(body.subarray(read, edit.span.start), write);
    write += edit.span.start - read;
    out.set(encoded[index], write);
    write += encoded[index].length;
    read = edit.span.end;
  });
  out.set(body.subarray(read), write);
  carryStringCheck(body, out);
  return out;
}

// Marks `to`, built from `from`'s bytes and JSON literals, as checked when `from` is.
export function carryStringCheck(from: Uint8Array, to: Uint8Array): void {
  if (checkedStrings.has(from)) checkedStrings.add(to);
}

// The index just past the closing quote of a string whose contents start at `at`, or -1 when an
// escape is malformed, a control character is unescaped, or the string never closes.
function checkString(bytes: Uint8Array, at: number): number {
  const length = bytes.length;
  for (let index = at; index < length; index += 1) {
    const byte = bytes[index];
    if (byte === QUOTE) return index + 1;
    if (byte < 0x20) return -1;
    if (byte !== BACKSLASH) continue;
    const escape = ESCAPES[bytes[index + 1]];
    if (escape === 0) return -1;
    index += 1;
    if (escape === 2) {
      for (let digit = 1; digit <= 4; digit += 1)
        if (HEX_DIGITS[bytes[index + digit]] !== 1) return -1;
      index += 4;
    }
  }
  return -1;
}

// Checks the strings of a body chunk by chunk as it arrives, with the same rules as JsonBytes.
// Outside strings it only tracks quotes; the walk that reads the body checks structure.
export class StringCheck {
  // 0 outside a string, 1 inside, 2 after a backslash, 3 to 6 within \u's hex digits.
  private state = 0;
  private failed = false;

  push(chunk: Uint8Array): void {
    if (this.failed) return;
    let state = this.state;
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];
      if (state === 1) {
        if (byte === QUOTE) state = 0;
        else if (byte === BACKSLASH) state = 2;
        else if (byte < 0x20) return this.fail();
      } else if (state === 0) {
        if (byte === QUOTE) state = 1;
      } else if (state === 2) {
        const escape = ESCAPES[byte];
        if (escape === 0) return this.fail();
        state = escape === 1 ? 1 : 3;
      } else {
        if (HEX_DIGITS[byte] !== 1) return this.fail();
        state = state === 6 ? 1 : state + 1;
      }
    }
    this.state = state;
  }

  // Marks the whole body as checked when every string in it closed well-formed.
  finish(body: Uint8Array): void {
    if (!this.failed && this.state === 0) checkedStrings.add(body);
  }

  private fail(): void {
    this.failed = true;
  }
}

// The named top-level fields of a body, each parsed whole (they must be small), or null when the
// body is not a JSON object. Absent fields are absent; a repeated key's last value wins.
export function topLevelFields(
  body: Uint8Array,
  keys: ReadonlySet<string>,
): Record<string, unknown> | null {
  const json = new JsonBytes(body);
  const fields: Record<string, unknown> = {};
  const valid = json.eachTopLevelMember((key, value) => {
    if (!keys.has(key)) return undefined;
    const span = json.span(value);
    if (span !== null) fields[key] = json.parse(span);
    return span?.end ?? -1;
  });
  return valid ? fields : null;
}
