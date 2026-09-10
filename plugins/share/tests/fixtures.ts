import type { TimelineRow } from "../server/timeline";

export const NOW = 1_780_000_000_000;
export function base(id: string, seq: number) {
  return { id, threadId: "t", turnId: "turn_1", createdAt: NOW + seq, startedAt: NOW + seq, sourceSeqStart: seq, sourceSeqEnd: seq };
}
export function message(seq: number, text = `Message ${seq}`): TimelineRow {
  return { ...base(`message_${seq}`, seq), kind: "conversation", role: "assistant", text, attachments: null, turnRequest: null };
}
export const command = {
  ...base("cmd", 3), kind: "work", workKind: "command", status: "completed", callId: "call_1", command: "npm test",
  cwd: "/workspace", output: "All tests passed\nAPI_TOKEN=abcdefghijklmnop", exitCode: 0, completedAt: NOW + 3,
  activityIntents: [], approvalStatus: null, source: null,
} satisfies TimelineRow;
export const rows: TimelineRow[] = [
  { ...base("user", 1), kind: "conversation", role: "user", text: "Please check **sharing**.", attachments: { imageUrls: ["https://example.com/private.png"], localFilePaths: ["/private.txt"], localFiles: 1, localImagePaths: [], localImages: 0, webImages: 1 },
    initiator: "user", mentions: [], senderThreadId: null, systemMessageKind: "unlabeled", systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" } },
  message(2, "It works.\n\n- Read only\n- [Documentation](https://example.com/docs)\n\n```txt\n<safe code>\n```"),
  command,
  { ...base("system", 4), kind: "system", systemKind: "debug", title: "SYSTEM PRIVATE", detail: "SYSTEM PRIVATE", status: null },
];
export function page(items: TimelineRow[] = rows, older: { anchorId: string; anchorSeq: number } | null = null) {
  return { rows: items, timelinePage: { kind: "latest" as const, hasOlderRows: older !== null, olderCursor: older, returnedSegmentCount: items.length, segmentLimit: 50 } };
}
