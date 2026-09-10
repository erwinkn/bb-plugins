import { describe, expect, it } from "vitest";
import { REDACTION_PATTERNS, redact } from "../lib/redact";

const fixtures: Record<string, string> = {
  pem: "-----BEGIN RSA PRIVATE KEY-----\nprivate\nbytes\n-----END RSA PRIVATE KEY-----",
  openai: "sk-abcdefghijklmnop_123", github: "ghp_abcdefghijklmnopqrst", "github-pat": "github_pat_abcdefghijklmnopqrst_123",
  aws: "AKIA1234567890ABCDEF", slack: "xoxb-1234567890-abcdefgh", bearer: "Bearer abcdefghijklmnop==", assignment: "API_KEY=abcdefghijklmnop",
};
describe("redaction", () => {
  it.each(REDACTION_PATTERNS)("redacts $name", ({ name }) => {
    expect(redact(fixtures[name]!)).toBe(name === "assignment" ? "API_KEY=[redacted]" : "[redacted]");
  });
  it.each(["KEY", "TOKEN", "SECRET", "PASSWORD", "MY_API_KEY", "MY_TOKEN", "APP_SECRET", "DB_PASSWORD"])("preserves the assignment key %s", (key) => {
    expect(redact(`  ${key}: abcdefghijklmnop\n${key}=abcdefghijklmnop`)).toBe(`  ${key}: [redacted]\n${key}=[redacted]`);
  });
  it.each(["b", "p", "o", "a", "s"])("redacts Slack xox%s", (letter) => { expect(redact(`xox${letter}-1234567890`)).toBe("[redacted]"); });
  it("preserves ordinary text and short values", () => {
    const text = "Hello world.\nKEY=short\nPATH=/long/ordinary/path\nSECRET: several words are not a token\nsk-short\nghp_short\nBearer short";
    expect(redact(text)).toBe(text);
  });
  it("redacts repeated values and multiple PEM blocks independently", () => {
    expect(redact(`${fixtures.pem}\nkeep\n${fixtures.pem}`)).toBe("[redacted]\nkeep\n[redacted]");
    expect(redact(`${fixtures.openai} ${fixtures.openai}`)).toBe("[redacted] [redacted]");
  });
});
