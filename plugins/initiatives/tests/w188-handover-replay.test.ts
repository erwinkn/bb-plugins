import { beforeAll, describe, expect, it } from "vitest";
import { captureHandoverSnapshot } from "../lib/handover-snapshot";
import { handoverPacket, PACKET_MAX, type HandoverSnapshot } from "../lib/handover-packet";
import type { Store } from "../lib/store";
import { redactCredentials } from "../lib/redact";
import { fixtureStrings, loadCase, replayCases, replayDestination, replaySdk, replayStore, type ReplayCase } from "./handover-replay";

/**
 * W188: the nine handovers of Oct 7, replayed from fixtures (W191 audit). Each packet must
 * carry the facts the real handovers missed: the user's instructions, every live worker with
 * its owner and status, no closed question reopened, and completed work not shown as undone.
 * Deterministic: no Luna, no network; the fixture answers every native read.
 */
interface Built { fx: ReplayCase; store: Store; snapshot: HandoverSnapshot; packet: string }
const built = new Map<string, Built>();
const packet = (name: string) => built.get(name)!.packet;

beforeAll(async () => {
  for (const name of replayCases()) {
    const fx = loadCase(name);
    const store = replayStore(fx);
    const snapshot = await captureHandoverSnapshot(replaySdk(fx), store, fx.projectId, { now: fx.replacementAt, destination: replayDestination(fx) });
    built.set(name, { fx, store, snapshot, packet: handoverPacket(store, fx.projectId, snapshot, null) });
  }
}, 60_000);

describe("W188 replay: every case", () => {
  it("has all nine cases", () => {
    expect(replayCases()).toEqual(["ai-config", "bb-plugins", "coffre", "equisafe", "erwinkn.com", "marbre-craie", "marginalia", "red-metal", "solera"]);
  });

  it.each(replayCases())("%s: dated, bounded, and every fact it could not read says so", name => {
    const { fx, snapshot } = built.get(name)!;
    const p = packet(name);
    expect(p.length).toBeLessThanOrEqual(PACKET_MAX);
    expect(p).toContain(`Snapshot captured at ${new Date(fx.replacementAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    // A failed read is shown as unavailable, never as an empty list.
    for (const [ref, w] of Object.entries(snapshot.workers))
      if (!w.status.ok) expect(p).toMatch(new RegExp(`### ${ref} [^]*?native status: unavailable`));
    expect(p).not.toMatch(/\[awaiting_acceptance\]|\[accepted\]/);
  });

  it.each(replayCases())("%s: every live worker with its owner, native status, current work and latest report", name => {
    const { store, fx } = built.get(name)!;
    const p = packet(name);
    for (const w of store.workers(fx.projectId).filter(w => w.state !== "retired")) {
      const block = p.slice(p.indexOf(`### ${w.ref} "`));
      expect(block, w.ref).toMatch(new RegExp(`^### ${w.ref} "[^\\n]*\\nThread ${w.threadId ?? "none"}; native status: `));
      const last = store.assignments(fx.projectId).filter(a => a.workerNum === w.num && a.report).at(-1);
      if (last) expect(block).toContain(`Latest report ${last.ref}`);
    }
  });

  it.each(replayCases())("%s: the user's last ten messages are all there", name => {
    const { snapshot } = built.get(name)!;
    const p = packet(name);
    const users = snapshot.conversation.ok ? snapshot.conversation.value.messages.filter(m => m.from === "user").slice(-10) : [];
    for (const m of users) expect(p, m.text.slice(0, 80)).toContain(m.text.replace(/^#{1,6}[ \t]+/gm, "").trim().slice(0, 60));
  });

  it.each(replayCases())("%s: no closed, answered, withdrawn or superseded question is listed as open", name => {
    const { store, fx } = built.get(name)!;
    const p = packet(name);
    const closed = store.refStatuses(fx.projectId, Array.from({ length: 400 }, (_, i) => i + 1)).filter(r => r.status !== "active");
    for (const r of closed) expect(p).not.toContain(`Open question D${r.num} `);
    // Every ref the packet mentions has its current status listed (K# is the old name of D#).
    for (const r of closed) if (new RegExp(`\\b[DK]${r.num}\\b`).test(p.slice(0, p.indexOf("## Current status")))) expect(p).toMatch(new RegExp(`- D${r.num}( \\(also written K${r.num}\\))?: [^\\n]*not open`));
  });
});

describe("W188 replay: the misses the audit found", () => {
  it("Marbre: the user's go-ahead, W50/W51's current work and the 429, and the Mac threads (MC1–MC7)", () => {
    const p = packet("marbre-craie");
    expect(p).toContain("keep going without me");
    expect(p).toContain("We should stick to Claude models");
    expect(p).toContain("Cloudflare is just my preference");
    for (const ref of ["W50", "W51"]) {
      const block = p.slice(p.indexOf(`### ${ref} "`), p.indexOf("\n### ", p.indexOf(`### ${ref} "`) + 5));
      expect(block).toMatch(new RegExp(`Its latest messages: \\n  - \\[[^\\]]+ · ${ref}\\]`));
      expect(block).toContain("No Account Pooler account is currently eligible");
    }
    expect(p).toMatch(/## Other threads under the coordinator[^]*thr_bfausz4ram "Craie A[^]*thr_egccvbj3nr "Craie B[^]*thr_kzywcpgid2 "Perf investigator/);
    // MC2/MC3: what W50 and W51 were actually building, not their old design reports.
    expect(p).toContain("From W50: #90 merged (merge commit d43d9ff");
    expect(p).toContain("PR #92 (kit) awaits review");
    expect(p).toContain("**#93 is the new Comments plugin:**");
    expect(p).toContain("· W50] Writing the pane: chat's artifacts list");
    expect(p).toContain("From W51: the #91 fixes are pushed at 5f92edc");
  });

  it("Coffre: #165 merged, the Doppler token deleted, the 0.4.1 rebuild (C1, C3, C4)", () => {
    const p = packet("coffre");
    expect(p).toMatch(/- T44 \[reported, still open\][^\n]*It is not merged[^\n]*\(as of 2026-10-05[^\n]*\n {2}Newer, from the coordinator \(2026-10-06[^\n]*merged as #165 and shipped in 0\.4\.0/);
    // The user's Doppler instruction carries its answer, and the task that did it reads as done.
    expect(p).toMatch(/· User\] Yeah we should move\. If everything works with Coffre, we should delete the Doppler token[^\n]*\n {2}Answered \(2026-10-06 09:16 UTC\): W38 is on it \(T60\)/);
    expect(p).toContain('- T60 "erwinkn.com off Doppler: scripts and guidance on coffre, DOPPLER_TOKEN deleted": done, closed 2026-10-06 09:28 UTC.');
    expect(p).toMatch(/- T40 [^\n]*0\.4\.1/);
  });

  it("Solera: the P8 amendment at the end of a long reply, and every one of P1–P14 explained (SO1, SO2)", () => {
    const p = packet("solera");
    expect(p).toContain("**Proposed amendment to P8:** keep `held` only for untrusted progress");
    // The reply the user asked for keeps its room: each proposal's origin and meaning, not a cut middle.
    const start = p.indexOf("Here's where each of P1–P14 comes from");
    const reply = p.slice(start, p.indexOf("\n\n[2026", start));
    for (let n = 1; n <= 14; n++) expect(reply, `P${n}`).toMatch(new RegExp(`\\*\\*P${n}\\b[^\\n]*\\n?[^\\n]{40,}`));
    expect(reply).toContain("Ours or the review's:** P12, P13 as narrowed, P14");
  });

  it("Equisafe: W104 running, the word budget removed, K1 superseded, W84's A104 report (E1–E5)", () => {
    const p = packet("equisafe");
    expect(p).toMatch(/### W104 "#2069: new simplify-review skill"[^\n]*\nThread thr_4yx2dmbvmb; native status: active\.\nCurrent work: A134 \(running, since 2026-10-06 23:30 UTC\)/);
    expect(p).toContain("or we remove the word budget");
    expect(p).toContain("The word budget is removed as a gate");
    expect(p).toMatch(/- D1 \(also written K1\): superseded by D\d+; not open/);
    expect(p).not.toMatch(/D339|D340/);
    // E5: A104's actual findings, not only its heading.
    const w84 = p.slice(p.indexOf("### W84 "), p.indexOf("\n### ", p.indexOf("### W84 ") + 5));
    expect(w84).toContain("Latest report A104 (done");
    for (const finding of ["P1 slot collision at slot.sh:31-38", "P1 fail-open image diff at capture.sh:119-122", "P2 fail-open scan", "P2 startup cleanup", "P2 dirty manifest", "Shared Postgres/Redis"])
      expect(w84, finding).toContain(finding);
  });

  it("erwinkn.com: #48 merged after the reports that say it is open; K5 superseded (ER1, ER3)", () => {
    const p = packet("erwinkn.com");
    expect(p).toMatch(/\[2026-10-06 10:35 UTC · Coordinator\] PR #48 is merged/);
    expect(p).toMatch(/- D5 \(also written K5\): superseded by D\d+; not open/);
  });

  it("erwinkn.com: the automation was already updated after the report asking for it (ER2)", () => {
    const p = packet("erwinkn.com");
    // A23 (10:32) asks for the version-agnostic prompt; a minute later the coordinator ran the update.
    // The packet shows that as evidence to mention, not as proof (W194 #6).
    expect(p).toContain("Latest report A23 (done, 2026-10-06 10:32 UTC)");
    expect(p).toMatch(/## Commands the old coordinator ran that changed things outside the Initiative[^]*- \[2026-10-06 10:33 UTC\] [^\n]*grep -c 'whatever version it names'[^\n]*bb automation update auto_p2lqvuqhvfy[^\n]*\(ran, exit 0, not verified\)/);
  });

  it("Red Metal: the destination checkout, 542 commits behind with 152 changes (RM1)", () => {
    const p = packet("red-metal");
    // Outgoing and destination stay distinct: the old coordinator ran on the VM.
    expect(p).toContain("## Destination checkout (where the new coordinator runs)\nThe outgoing coordinator ran in /home/exedev/Code/red-metal on host the exedev VM. The new coordinator runs in a different checkout:\n/home/erwin/Code/red-metal on host erwin's Linux machine");
    expect(p).toContain("0 ahead, 542 behind");
    expect(p).toContain("Working tree: 152 changed files");
  });

  it("marginalia: D5 is the open question (MG1)", () => {
    expect(packet("marginalia")).toMatch(/- Open question D5 \(asked [^)]+\): Which app should marginalia integrate into first/);
  });

  it("AI config: W1's review app from its own messages; K1/K2 closed, not to be asked again (A1, A2)", () => {
    const p = packet("ai-config");
    expect(p).toMatch(/### W1 [^]*Its latest messages: [^]*· W1\] The review app is running/);
    expect(p).toContain("- D1 (also written K1): closed by the user without an answer; not open, don't ask again.");
    expect(p).toContain("- D2 (also written K2): closed by the user without an answer; not open, don't ask again.");
  });

  it("bb-plugins: the go-ahead, the completed transfer, live and committed, W189 idle (B1–B3)", () => {
    const p = packet("bb-plugins");
    expect(p).toContain("· User] yes let's go");
    expect(p).toContain("All 9 coordinators are being replaced");
    expect(p).toContain("Live and committed. Now running the handover preview.");
    expect(p).toMatch(/### W189 "[^\n]*\nThread thr_i23pj37xk9; native status: idle\./);
  });
});

describe("W188 replay fixtures carry nothing credential-like", () => {
  // The same shapes the fixture builder redacts; a new fixture must pass them too.
  const SHAPES: [string, RegExp][] = [
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["OpenAI/Anthropic key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/],
    ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
    ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
    ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
    ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/],
    ["Doppler token", /\bdp\.(?:st|pt|sa|ct|scim|audit)\.[A-Za-z0-9_.-]{16,}/],
    ["bearer token", /\bBearer\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{16,}/],
    ["URL password", /:\/\/[^/\s:@"]+:(?!\[redacted)[^@\s/"]{6,}@/],
    ["assigned secret", /(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)\s*[:=]\s*["'`]?(?!\[redacted)[A-Za-z0-9_\-./+=]{16,}/i],
    ["quoted token", /\b(?:token|secret|password|passphrase|api[ _-]?key|credential)s?\b[^\n`'"]{0,40}`(?!\[redacted)[A-Za-z0-9_\-./+=]{12,}`/i],
    ["SSH fingerprint", /\bSHA256:[A-Za-z0-9+/]{43}\b/],
  ];
  it.each(replayCases())("%s", name => {
    const strings = fixtureStrings(name);
    for (const [label, shape] of SHAPES) expect(strings.map(text => shape.exec(text)?.[0]).find(Boolean) ?? null, label).toBeNull();
    // The plugin's own redactor finds nothing left: the builder and lib/redact.ts agree.
    expect(strings.find(text => redactCredentials(text) !== text) ?? null).toBeNull();
  });
});
