import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// W194: every loop in the redactor terminates. A synchronous infinite loop cannot be timed out
// inside this process, so the inputs run in a child process with a hard time limit.
const redact = pathToFileURL(fileURLToPath(new URL("../lib/redact.ts", import.meta.url))).href;

/** A small seeded generator, so a failure names a reproducible input. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "password", '"password"', "api_key", "token", "DB_PASSWORD", "secret.ts:12", "[x](token.ts:4)",
  ":", "=", ": ", " = ", " ", "\t", "\\", " \\", "\n", "\n\n", "\n  ",
  "<<EOF", "<<'EOF'", '<<"EOF"', "<<-EOF", "EOF", "\tEOF", "<<", "<<-",
  "gh secret set X", "bb secret set Y", "doppler secrets set Z", "export K=",
  '"', "'", "`", "{", "[", "|", ">", "|-", ",", "value123", "Abc123Def456Ghi789", "/", "\\\\",
  "Bearer ", "https://a:b@c", "?token=", "sk-ant-", "-----BEGIN RSA PRIVATE KEY-----",
];

function cases(count: number, seed: number) {
  const next = generator(seed);
  return Array.from({ length: count }, () => {
    const length = 3 + Math.floor(next() * 60);
    return Array.from({ length }, () => PIECES[Math.floor(next() * PIECES.length)]).join("");
  });
}

function runInChild(inputs: string[], timeoutMs: number) {
  const script = `import { redactCredentials } from ${JSON.stringify(redact)};
let input = "";
process.stdin.on("data", d => (input += d)).on("end", () => {
  let max = 0, worst = -1;
  JSON.parse(input).forEach((text, i) => {
    const t = performance.now();
    redactCredentials(text);
    const ms = performance.now() - t;
    if (ms > max) { max = ms; worst = i; }
  });
  process.stdout.write(JSON.stringify({ max, worst }));
});`;
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
    input: JSON.stringify(inputs), timeout: timeoutMs, encoding: "utf8",
  });
}

describe("W194: the redactor terminates on adversarial input", () => {
  it("W194's repro: a heredoc command with a continuation line", () => {
    const repro = "gh secret set DEPLOY_KEY <<'EOF' \\\n  --repo erwinkn/coffre\nsecret-body\nEOF\nafter";
    const run = runInChild([repro], 10_000);
    expect(run.signal, run.stderr).toBeNull();
    expect(run.status, run.stderr).toBe(0);
  });

  it("400 random combinations of the trigger tokens each finish quickly", () => {
    const inputs = [...cases(400, 188), ...cases(20, 194).map(c => c.repeat(200))];
    const run = runInChild(inputs, 20_000);
    expect(run.signal, `killed: a loop did not terminate (stderr: ${run.stderr})`).toBeNull();
    expect(run.status, run.stderr).toBe(0);
    const { max, worst } = JSON.parse(run.stdout) as { max: number; worst: number };
    expect(max, `slowest input #${worst}: ${JSON.stringify(inputs[worst]?.slice(0, 200))}`).toBeLessThan(50);
  }, 30_000);
});
