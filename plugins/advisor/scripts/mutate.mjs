// Mutation guard: the A160 reference reverted one rule at a time and required
// its raw regressions to fail (fixtures/mutate.py, 47 reversions); A170 added
// one and the A228/A230 fixes add one per new rule. This script
// applies the same reversions to the TypeScript rules in a temporary copy, runs
// the suite, and requires at least one assertion failure per mutant (an import
// crash does not count). Usage: node scripts/mutate.mjs [out.json]
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// [name, file, [[from, to], ...]]; every `from` must occur in the source.
const M = [
  ["M1 regex literals not blanked", "src/rules/scope.ts", [["s = s.replace(REGEX_LIT,", "s = s; void s.replace(REGEX_LIT,"], ["|| REGEX_START.test(s)", "|| false"]]],
  ["M1 cross-hunk side binding dropped", "src/rules/validate.ts", [["if (hIdx !== hi && !moved) return fail(", "if (false) return fail("]]],
  ["M1 incompatible pair accepted", "src/rules/validate.ts", [['if (rel === "different") return fail("subject-incompatible");\n      if (rel === "same" || rel === "same-edited") {', 'if (rel === "same" || rel === "same-edited" || rel === "different") {']]],
  ["M1 mid-line close ignored (line-level pop)", "src/rules/scope.ts", [
    ["        while (stack.length > 0 && depth <= stack[stack.length - 1]!.base) stack.pop();\n", ""],
    ["      }\n    }\n  }\n  return pick(stack);", "      }\n    }\n    while (stack.length > 0 && depth <= stack[stack.length - 1]!.base && stack[stack.length - 1]!.decl !== l) stack.pop();\n  }\n  return pick(stack);"],
  ]],
  ["M2 snapshot not compared", "src/rules/snapshot.ts", [
    ['const t = both(dispatch.thread, completion.thread, "thread", unknown);', "const t: any = null;"],
    ["const x = both(dispatch[k], completion[k], k, unknown);", "const x: any = null;"],
    ['const m = both(dispatch.membership, completion.membership, "membership", unknown);', "const m: any = null;"],
  ]],
  ["M2 progress treated as stale", "src/rules/snapshot.ts", [["if (PROGRESS_STATES.has(cv.state)) notes.push", "if (false) notes.push"]]],
  ["M3 rejection ignored", "src/rules/requests.ts", [['r.state = t === "turn/input/accepted" ? "accepted" : "rejected";', 'r.state = t === "turn/input/accepted" ? "accepted" : "requested";']]],
  ["M3 no receipt sweep", "src/rules/requests.ts", [["const receipt = sweep.rows.find(", "const receipt = ([] as EventRow[]).find("]]],
  ["M3 pending before stale", "src/rules/snapshot.ts", [['  if (staleU.length > 0) return { state: "stale"', '  if (unknown.length > 0) return { state: "unknown", reasons: unknown, notes, reads: READS_LABEL };\n  if (staleU.length > 0) return { state: "stale"']]],
  ["M4 work input clears every pause", "src/rules/pause.ts", [['this.reasons.delete("interrupted"); // the watched work resumed', "this.reasons.clear(); // the watched work resumed"]]],
  ["M5 no card reserve", "src/rules/packet.ts", [["const reserve = CARD_ENC_CAP + CARD_ID_MAX + 64;", "const reserve = 0;"]]],
  ["M5 no partial trimming", "src/rules/packet.ts", [["    if (room >= MIN_PARTIAL) {\n      kept.push", "    if (false) {\n      kept.push"]]],
  ["M6 title-only issue key", "src/rules/findings.ts", [
    ["const issue = issueKey(watch, category, shown.locator);", 'const issue = issueKey(watch, category, shown.subject.split(" › ").at(-1)!);'],
    ["const occ = occurrenceId(watch, category, shown.locator, finding);", 'const occ = occurrenceId(watch, category, shown.subject.split(" › ").at(-1)!, finding);'],
  ]],
  ["M7 no clipping", "src/rules/retain.ts", [["if (total <= RETAIN_CAP) {", "if (true) {"]]],
  ["M7 pruned unreviewed silently", "src/store/store.ts", [["for (const [w, seqs] of unreviewed) {", "for (const [w, seqs] of new Map<string, number[]>()) {"]]],
  ["P1a status from value (A144)", "src/rules/snapshot.ts", [[
    'return read.ok ? { status: "ok", value: pick(read.value) } : { status: "missing", why: read.why };',
    'const v: any = read.ok ? pick(read.value) : null;\n  const bad = v === null || (typeof v === "object" && Object.values(v).includes(null));\n  return (bad ? { status: "missing", why: "value-null" } : { status: "ok", value: v }) as Comp<U>;',
  ]]],
  ["P1b row-only assignment diff (A144)", "src/rules/snapshot.ts", [["  for (const ref of Object.keys(drow.refs).sort()) {\n    const de", "  for (const ref of Object.keys(drow.refs).sort()) {\n    if (!(ref in crow.refs)) {\n      stale.push(`${ref}-no-longer-current`);\n      continue;\n    }\n    const de"]]],
  ["P1b missing ref read as cancellation", "src/rules/snapshot.ts", [['unknown.push(`${ref}-${readOf(ce) !== "ok" ? readOf(ce) : readOf(de)}`); // never implicit cancellation', "stale.push(`${ref}-cancelled`);"]]],
  ["P1c verified-moved restored (A144)", "src/rules/validate.ts", [['      pairing = "claimed-moved";\n    } else if (bs && as) {', '      pairing = "claimed-moved";\n      if (bs && as && bs.declKind === "-" && as.declKind === "+") {\n        status = "verified";\n        subj = as;\n      }\n    } else if (bs && as) {']]],
  ["P2a no final one-card re-check (A144)", "src/rules/packet.ts", [["const over = size(kept, iss, cards.slice(0, 1), omitted) - cap;", "const over = 0;"]]],
  ["P2a unbounded omission line (A144)", "src/rules/packet.ts", [["const named = omitted.slice(0, OMIT_NAMED).map((r) => r.slice(0, REF_MAX));", "const named = [...omitted];"]]],
  ["P2b mark excluded from card join (A144)", "src/rules/packet.ts", [
    ['enc([...cur, h].map(rendered).join("\\n")) > cap', 'enc([...cur, h].map(hunkText).join("\\n")) > cap'],
    ["      if (cur.length > 0) {\n        parts.push(cur);\n        cur = [];\n      }\n      parts.push([h]);\n      continue;\n", ""],
  ]],
  ["P2c mute suppresses unverified locator (A144)", "src/rules/findings.ts", [["return subjectVerified\n      ? {", "return true\n      ? {"]]],
  ["P2d positional rename verified (A144)", "src/rules/validate.ts", [['status = "rename-or-replacement";\n        pairing = "positional";', 'status = "verified";\n        subj = as;']]],
  ["P2d same-name reorder rejected (A144)", "src/rules/scope.ts", [['return sameName ? "same-name" : "different";\n  }\n  const run =', 'return "different";\n  }\n  const run =']]],
  ["P2e authority frozen at ingest (A144)", "src/rules/requests.ts", [
    ['          createdAt: typeof row.createdAt === "number" ? row.createdAt : null,\n', '          createdAt: typeof row.createdAt === "number" ? row.createdAt : null,\n          frozen: authority(d.initiator ?? null, d.senderThreadId ?? null, this.parent, this.coordinator, this.member),\n'],
    ["return authority(r.initiator, r.sender, this.parent, this.coordinator, this.member);", "return (r as any).frozen;"],
  ]],
  ["P2f oldest rows seeded (A144)", "src/rules/requests.ts", [['const newest = await readPages(src, { types: REQUEST_TYPES }, "desc", before, SEED_PAGES, SEED_BYTES);', 'const newest = await readPages(src, { types: REQUEST_TYPES }, "asc", null, SEED_PAGES, SEED_BYTES);\n    newest.rows.reverse();']]],
  ["P3 join between reads ignored (A144)", "src/rules/snapshot.ts", [['if (dv === null && cv !== null) stale.push("membership-joined");', "if (dv === null && cv !== null) void 0;"]]],
  ["F1 page limit 500 (A152)", "src/rules/events.ts", [["let limit = EVENT_PAGE_MAX;", "let limit = 500;"]]],
  ["F1 non-progress page accepted", "src/rules/events.ts", [["if (behind || unordered) return", "if (false) return"]]],
  ["F1 read cap ignored", "src/rules/events.ts", [["if (reads >= maxPages) return", "if (false) return"]]],
  ["F1 byte bound ignored", "src/rules/events.ts", [["if (used > maxBytes) return", "if (false) return"]]],
  ["F1 413 not retried smaller", "src/rules/events.ts", [["if (status === 413 && limit > 1) {", "if (false) {"]]],
  ["F1 truncated sweep silent", "src/rules/requests.ts", [['if (sweep.status !== "complete" && sweep.status !== "stopped") this.gaps.push(', "if (false) this.gaps.push("]]],
  ["F1 drain non-progress accepted", "src/runtime/drain.ts", [["if (page.length > limits.rows || seqs[0]! <= cursor || seqs.some((s, i) => i > 0 && s <= seqs[i - 1]!)) {", "if (false) {"]]],
  ["F2 historic without proof (A152)", "src/rules/requests.ts", [['if (proven) return ["former-parent", "native-parent-at-acceptance"];', 'if (true) return ["former-parent", "native-parent-at-acceptance"];']]],
  ["F2 labels not rendered (A152)", "src/rules/packet.ts", [["export function label(r: Requirement): string {\n", 'export function label(r: Requirement): string {\n  if (r) return "";\n']]],
  ["F2 historic missed-requirement accepted", "src/rules/validate.ts", [['if (finding.category === "missed-requirement") return fail("historic-requirement-not-missable");', 'if (false) return fail("historic-requirement-not-missable");']]],
  ["F2 member trusts any native parent (A152)", "src/rules/requests.ts", [['if (member) return sender === coordinator ? "coordinator" : "peer";', 'if (member) return sender === coordinator ? "coordinator" : sender === parent ? "parent" : "peer";']]],
  ["F2 parent anchor trusted before drain", "src/rules/requests.ts", [["return this.anchorOk ? this.anchor : UNKNOWN;", "return this.anchor;"]]],
  ["F2 malformed ownership row ignored", "src/rules/requests.ts", [["if (seq === null || seq < this.knownFrom || this.malformed.length > 0) return UNKNOWN;", "if (seq === null || seq < this.knownFrom) return UNKNOWN;"]]],
  ["F3 sender-less shown as user (A152)", "src/rules/packet.ts", [['if (k === "unattributed") return "UNATTRIBUTED: user or plugin";', 'if (k === "unattributed") return "user";']]],
  ["F3 no brief match (A152)", "src/rules/requests.ts", [[".filter((ref) => this.briefs[ref]!.text === parts[0]!.text);", ".filter(() => false);"]]],
  ["F3 normalized brief match", "src/rules/requests.ts", [[".filter((ref) => this.briefs[ref]!.text === parts[0]!.text);", '.filter((ref) => this.briefs[ref]!.text.split(/\\s+/u).filter(Boolean).join(" ") === String(parts[0]!.text).split(/\\s+/u).filter(Boolean).join(" "));']]],
  ["F4 k-th pair ignores scope (A152)", "src/rules/scope.ts", [['return unique && sameEnclosing(hunk, rb, b.decl, a.decl) ? "same-edited" : "same-name";', 'return unique ? "same-edited" : "same-name";']]],
  ["F4 indentation only", "src/rules/scope.ts", [["return lead(b) === lead(a) && prefixKeepsScope(hunk, run, b) && prefixKeepsScope(hunk, run, a);", "return lead(b) === lead(a);"]]],
  ["R lopsided pair capped at half", "src/rules/retain.ts", [["const small = new Set(names.filter((s) => utf8(sides[s]!) <= Math.floor(budget / Math.max(1, names.length))));", "const small = new Set<string>();"]]],
  ["A170 fork copies not inherited (T95)", "src/rules/requests.ts", [['if (this.inheritance(r) !== "own") return "inherited";', 'if (r.seq < 0) return "inherited";']]],
  // A228 (observer, storage, authority, evidence lifecycle)
  ["A228#1 preview writes issue state", "src/store/store.ts", [["      if (o.preview) {\n        if (existing) return { stored: false, notify: null };\n        this.insertOccurrence(o);\n        return { stored: true, notify: null };\n      }\n", ""]]],
  ["A228#1 preview shares real ids", "src/runtime/reviewer.ts", [["id: review.preview ? `pv:${reviewId}:${a.id}` : a.id,", "id: a.id,"]]],
  ["A228#2 former member dispatched", "src/runtime/context.ts", [['if (m.status === "ok" && m.value?.former) {', "if (false) {"]]],
  ["A228#3 failed context reads not gated", "src/runtime/context.ts", [["return gaps.length > 0 ? `context read failed", "return false && gaps.length > 0 ? `context read failed"]]],
  ["A228#4 held packet re-dispatched", "src/runtime/advisor.ts", [["      const held = this.d.store.heldFor(w.id);", "      const held = null as { id: string; heldAt: number | null } | null;"]]],
  ["A228#4 held never expires", "src/runtime/reviewer.ts", [["} else if (lim.heldExpiryMs !== null && end - (review.heldAt ?? end) >= lim.heldExpiryMs) {", "} else if (false) {"]]],
  ["A228#4 untyped completion read", "src/runtime/reviewer.ts", [['readPages(src, { types: COMPLETION_TYPES }, "asc"', 'readPages(src, {}, "asc"']]],
  ["A228#4 rechecks per pass unbounded", "src/runtime/advisor.ts", [["this.d.store.heldReviews(this.resolved.config.held.rechecksPerPass)", "this.d.store.heldReviews()"]]],
  ["A228#4 held reviews pruned", "src/store/store.ts", [["DELETE FROM reviews WHERE state != 'held' AND finished_at", "DELETE FROM reviews WHERE finished_at"]]],
  ["A228#5 delivered assignment filtered to active", "src/runtime/projects.ts", [["      const delivered = m.assignment;", '      const delivered = m.assignment && (m.assignment.phase === "pending" || m.assignment.phase === "active") ? m.assignment : null;']]],
  ["A228#6 reversal ignored at admission", "src/rules/findings.ts", [["  if (reversed) return { notify:", "  if (false) return { notify:"]]],
  ["A228#6 reversal never observed", "src/rules/reversal.ts", [["  if (card.seq <= c.evidenceSeq || !card.hunks || card.path === null) return false;", "  return false;"]]],
  ["A228#7 resolved without proof", "src/runtime/reviewer.ts", [['      else if (!reverses(later, change, w.rootPath)) reason = "evidence-does-not-remove-the-cited-lines";', ""]]],
  ["A228#8 Projects 503 read as absence", "src/runtime/projects.ts", [["if (res.status === 404) throw new Unavailable(", "if (res.status === 404 || res.status === 503) throw new Unavailable("]]],
  ["A228#9 root path never retried", "src/runtime/advisor.ts", [["    else await this.readRoot(w, signal);\n", ""]]],
  ["A228#9 shell attribution without a root", "src/runtime/checkpoints.ts", [["  const rootKnown = w.rootPath !== null;", "  const rootKnown = true;"]]],
  ["A228#10 project scope failure swallowed", "src/runtime/advisor.ts", [["      this.scopeError = `project scope:", "      void `project scope:"]]],
  ["A228#11 user Stop not wired", "src/runtime/advisor.ts", [["      pause.projectsRead(m.value?.userStopped ?? false);\n", ""]]],
  ["A228#12 paid results dropped on reload", "src/store/store.ts", [['        if (parsed && typeof parsed === "object") {', "        if (false) {"]]],
  // A230 (transports, budgets, Settings)
  ["A230#1 fetch on an aborted signal", "src/transport/http.ts", [['  if (parent.aborted) return { kind: "not-sent", reason: reasonOf(parent) };\n', ""]]],
  ["A230#2 Jev body cap ignored", "src/rules/jev.ts", [["      if (bodyBytes({ ...state, hunks: next }, n + 1) > cap) {", "      if (false) {"]]],
  ["A230#3 stream read through the JSON cap", "src/transport/transports.ts", [["pinned: LUNA_MODEL, sse }", "pinned: LUNA_MODEL }"]]],
  ["A230#3 stream total unbounded", "src/transport/http.ts", [["      if (total > o.totalCap) return cut(", "      if (false) return cut("]]],
  ["A230#4 zone change opens a fresh day", "src/runtime/ledger.ts", [["  return carry && now < carry.until ? Math.min(start, carry.start) : start;", "  return start;"]]],
  ["A230#5 invalid stored value defaulted", "src/config/settings.ts", [["  const invalid = invalidStored(stored);", "  const invalid = [] as ReturnType<typeof invalidStored>;"]]],
  // A242 (invalid stored numbers reach the plugin through the host read)
  ["A242 invalid value runs raw", "src/config/settings.ts", [["  for (const bad of invalid) delete raw[bad.key];\n", ""]]],
  ["A242 pruning on an invalid retention value", "src/runtime/advisor.ts", [["    const retentionValid = !RETENTION_KEYS.some((k) => this.resolved.invalidKeys.includes(k));", "    const retentionValid = true;"]]],
  ["A242 held expiry on an invalid value", "src/runtime/advisor.ts", [['heldExpiryMs: this.resolved.invalidKeys.includes("heldExpiryMinutes") ? null :', "heldExpiryMs: false ? null :"]]],
];

const out = process.argv[2];
// MUTANTS=<regex> runs only the matching mutants (for example after a focused change).
const only = process.env.MUTANTS ? new RegExp(process.env.MUTANTS, "u") : null;
const results = {};
let undetected = 0;
const selected = only ? M.filter(([name]) => only.test(name)) : M;
for (const [name, file, subs] of selected) {
  const dir = mkdtempSync(join(tmpdir(), "advisor-mut-"));
  try {
    for (const p of ["src", "tests", "server.ts", "package.json", "tsconfig.json", "vitest.config.ts"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    let text = readFileSync(join(dir, file), "utf8");
    for (const [from, to] of subs) {
      if (!text.includes(from)) throw new Error(`${name}: pattern not found in ${file}: ${from.slice(0, 80)}`);
      text = text.replace(from, to);
    }
    writeFileSync(join(dir, file), text);
    const report = join(dir, "report.json");
    try {
      execFileSync("npx", ["vitest", "run", "--exclude", "tests/app.test.tsx", "--reporter=json", `--outputFile=${report}`], { cwd: dir, stdio: "ignore", timeout: 300_000 });
    } catch {
      // a failing run exits non-zero; the report says what failed
    }
    const r = JSON.parse(readFileSync(report, "utf8"));
    const crashed = r.testResults.filter((f) => f.status === "failed" && f.assertionResults.length === 0).map((f) => f.name.replace(dir + "/", ""));
    const failing = r.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => a.title));
    results[name] = { failing, crashed };
    const ok = failing.length > 0;
    if (!ok) undetected++;
    console.log(`${ok ? "detected" : "UNDETECTED"} ${name}: ${failing.length} failing${crashed.length ? `, ${crashed.length} suites crashed` : ""} -> ${failing.slice(0, 4).join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (out) writeFileSync(out, JSON.stringify({ mutants: selected.length, filter: process.env.MUTANTS ?? null, undetected, results }, null, 1));
console.log(`${selected.length - undetected}/${selected.length} mutants detected by assertion${only ? ` (filter ${only.source})` : ""}`);
process.exit(undetected === 0 ? 0 : 1);
