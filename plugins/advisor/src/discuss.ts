// The first message a "Discuss" thread is seeded with. It is only a draft in
// BB's own new-thread composer: nothing is sent, and no agent starts, until
// Erwin submits it. The discussion is a separate thread; the Advisor never
// writes to the watched one.

import type { FindingView } from "./views.js";

const EXCERPT_MAX = 2000;
const clip = (text: string) => (text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}\n… (${text.length - EXCERPT_MAX} more characters)` : text);
const fence = (label: string, text: string) => `${label}:\n\`\`\`\n${clip(text)}\n\`\`\``;

export function discussionPrompt(f: FindingView, thread: { threadId: string; title: string | null }): string {
  const c = f.citation;
  const lines = (side: { lines: number[]; path: string | null } | null) =>
    side ? `${side.path ?? "?"}${side.lines.length === 2 ? ` L${side.lines[0]}${side.lines[1] !== side.lines[0] ? `–${side.lines[1]}` : ""}` : ""}` : "";
  return [
    "Let's talk through this BB Advisor finding. It is advisory, not an instruction, and it may be wrong. Do not message, steer or change the watched thread or its files unless I ask.",
    `Finding: ${f.severity} · ${f.category} · ${f.subject} (${f.subjectStatus === "verified" ? "subject verified" : f.subjectStatus})${f.preview ? " · PREVIEW from the fake reviewer, not a judgment" : ""}`,
    `Summary: ${f.summary}`,
    `Watched thread: ${thread.title ? `"${thread.title}" ` : ""}(${thread.threadId})${f.initiative ? ` · Initiative ${f.initiative.name}, ${f.initiative.label}` : ""}`,
    c.requirement ? `Requirement ${c.requirement.ref}${c.requirement.status ? ` (${c.requirement.status})` : ""}: "${c.requirement.quote}"` : null,
    c.before ? fence(`Before · ${lines(c.before)}`, c.before.text) : null,
    c.after ? fence(`After · ${lines(c.after)}`, c.after.text) : null,
    c.claim ? fence("Claim", c.claim) : null,
    c.command ? fence("Command evidence", c.command) : null,
    f.badges.length ? `Notes: ${f.badges.join("; ")}` : null,
    `Source: review ${f.reviewId} (${f.route}${f.model ? `, ${f.model}` : ""}), as of event #${f.asOfSeq ?? "?"}, requirement coverage ${f.coverage}, evidence ${f.evidence}. More: \`bb advisor findings ${thread.threadId}\`.`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}
