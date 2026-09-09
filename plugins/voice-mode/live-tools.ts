import { z } from "zod";

const id = z.string().min(1).max(256);
const ids = z.array(id).min(1).max(30);
export const liveToolArgs = {
  find_targets: z.object({ query: z.string().max(200), include_children: z.boolean().optional(), include_archived: z.boolean().optional() }).strict(),
  read_threads: z.object({ thread_ids: ids, what: z.enum(["status", "output", "receipts", "updates"]) }).strict(),
  message_thread: z.object({ thread_id: id, body: z.string().min(1).max(16000), mode: z.enum(["normal", "steer"]) }).strict(),
  spawn_worker: z.object({ profile: z.string().min(1).max(64), title: z.string().min(1).max(200), task: z.string().min(1).max(24000).describe("Task, context, constraints, and expected result."), project_id: id, host_id: id.optional() }).strict(),
  create_thread: z.object({ project_id: id, title: z.string().min(1).max(200), body: z.string().min(1).max(24000), host_id: id.optional() }).strict(),
  prepare_draft: z.object({ thread_id: id.optional(), project_id: id.optional(), text: z.string().max(24000), mode: z.enum(["append", "replace"]) }).strict(),
  control_ui: z.object({ action: z.enum(["open_thread", "open_project", "preview_file", "show_voice"]), thread_id: id.optional(), project_id: id.optional(), path: z.string().min(1).max(4096).optional(), source: z.enum(["workspace", "thread-storage"]).optional() }).strict(),
  stop_thread: z.object({ thread_id: id }).strict(),
  subscriptions: z.object({ op: z.enum(["list", "subscribe", "unsubscribe"]), thread_id: id.optional() }).strict(),
  prepare_archive: z.object({ thread_ids: ids }).strict(),
  archive_threads: z.object({ preview_id: id }).strict(),
  answer_interaction: z.object({ thread_id: id, interaction_id: id, answer: z.json().optional(), decision: z.enum(["allow_once", "allow_for_session", "deny"]).optional() }).strict(),
  remain_silent: z.object({ updates: z.enum(["defer", "dismiss"]).optional() }).strict(),
  end_call: z.object({}).strict(),
};
export type LiveTool = keyof typeof liveToolArgs;
export const LIVE_EFFECTS = new Set<LiveTool>(["message_thread", "spawn_worker", "create_thread", "prepare_draft", "control_ui", "stop_thread", "archive_threads", "answer_interaction"]);
const descriptions: Record<LiveTool, string> = {
  find_targets: "Find threads and projects by description. Defaults to non-archived parents. Includes this conversation's tasks. Resolve names before acting.",
  read_threads: "Read status, output tail, receipts, pending interactions, or updates for several threads. Evidence has timestamps and truncation flags.",
  message_thread: "Deliver a message now. Normal queues if active; steer joins the active turn. Automatically watches. Sending at a future time is unsupported and returns an error.",
  spawn_worker: "Start a hidden background worker using a configured profile, explicit project, and destination machine. Supply context, constraints, and expected result in task. Returns launch status, not completion.",
  create_thread: "Create a visible root thread with the given body as its prompt. Automatically watches. Returns launch status.",
  prepare_draft: "Write to the exact thread or project composer on the call owner device. Never submit. Append unless replacement was requested.",
  control_ui: "Navigate on the call owner device. Open a thread or project, preview a file, or show Voice. Background updates cannot navigate.",
  stop_thread: "Request a stop on explicit user intent. Acceptance does not prove every process exited. Automatically watches.",
  subscriptions: "List watches, explicitly subscribe or re-enable one, or disable updates without stopping work. A later send does not re-enable updates.",
  prepare_archive: "Preview the requested threads, all children, active work, and queued messages. Explain the list aloud and ask once before archive_threads.",
  archive_threads: "Archive only the unused preview after it was spoken and drained and a later utterance confirms it. Changed scope requires a fresh preview.",
  answer_interaction: "Answer a pending native question or approval that was spoken in this call. Requires a later user utterance after drain. For approvals say the subject and reason first. Never invent consent.",
  remain_silent: "End without speech. Defer updates by default, or dismiss redundant updates. Critical items remain pending.",
  end_call: "Hang up after the current response drains, only on clear user intent.",
};
export function liveToolSchemas() {
  return (Object.keys(liveToolArgs) as LiveTool[]).map(name => ({ type: "function" as const, name, description: descriptions[name], parameters: z.toJSONSchema(liveToolArgs[name]) }));
}
