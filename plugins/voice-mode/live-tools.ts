import { z } from "zod";

const id = z.string().min(1).max(256);
const ids = z.array(id).min(1).max(30);
export const liveToolArgs = {
  find_targets: z.object({ query: z.string().max(200), include_children: z.boolean().optional(), include_archived: z.boolean().optional(), parent_id: id.optional().describe("List the children of this thread, newest first, filtered by query.") }).strict(),
  read_threads: z.object({ thread_ids: ids, what: z.enum(["status", "output", "receipts", "updates"]) }).strict(),
  message_thread: z.object({ thread_id: id, body: z.string().min(1).max(16000), mode: z.enum(["normal", "steer"]) }).strict(),
  spawn_worker: z.object({ profile: z.string().min(1).max(64).optional().describe("A configured profile name. Omit for the default profile."), title: z.string().min(1).max(200), task: z.string().min(1).max(24000).describe("Task, context, constraints, and expected result."), project_id: id.optional().describe("Only when the task needs that repository's files. Omit to run outside any project."), host_id: id.optional() }).strict(),
  create_thread: z.object({ project_id: id, title: z.string().min(1).max(200), body: z.string().min(1).max(24000), host_id: id.optional() }).strict(),
  prepare_draft: z.object({ thread_id: id.optional(), project_id: id.optional(), text: z.string().max(24000), mode: z.enum(["append", "replace"]) }).strict(),
  control_ui: z.object({ action: z.enum(["open_thread", "open_project", "preview_file", "show_voice"]), thread_id: id.optional(), project_id: id.optional(), path: z.string().min(1).max(4096).optional(), source: z.enum(["workspace", "thread-storage"]).optional() }).strict(),
  stop_thread: z.object({ thread_id: id }).strict(),
  rename_thread: z.object({ thread_id: id, title: z.string().trim().min(1).max(200).describe("The new title, in the user's words.") }).strict(),
  subscriptions: z.object({ op: z.enum(["list", "subscribe", "unsubscribe"]), thread_id: id.optional() }).strict(),
  prepare_archive: z.object({ thread_ids: ids }).strict(),
  archive_threads: z.object({ preview_id: id }).strict(),
  answer_interaction: z.object({ thread_id: id, interaction_id: id, answer: z.json().optional(), decision: z.enum(["allow_once", "allow_for_session", "deny"]).optional() }).strict(),
  remain_silent: z.object({ updates: z.enum(["defer", "dismiss"]).optional() }).strict(),
  end_call: z.object({}).strict(),
};
export type LiveTool = keyof typeof liveToolArgs;
export const LIVE_EFFECTS = new Set<LiveTool>(["message_thread", "spawn_worker", "create_thread", "prepare_draft", "control_ui", "stop_thread", "rename_thread", "archive_threads", "answer_interaction"]);
const descriptions: Record<LiveTool, string> = {
  find_targets: "Find threads and projects from an approximate spoken description. Results are ranked with a match score from 0 to 1; all projects are returned ranked. Defaults to non-archived parents; include_children for child threads, parent_id for the children of one thread. Includes this conversation's tasks. Resolve names before acting.",
  read_threads: "Read status, output tail, receipts, pending interactions, or updates for several threads. Evidence has timestamps and truncation flags. receipts are the stored results of this call's earlier actions, for recovery after an interruption; a send result that already returned needs no confirmation.",
  message_thread: "Deliver a message now. Normal queues if active; steer joins the active turn. The result is the receipt: sent and queued are both final delivery, and status running means the thread is working on it. The thread's reply, failure, or question is reported to you automatically in this call. Sending at a future time is unsupported and returns an error.",
  spawn_worker: "Start a hidden background worker. It runs outside any project on the primary machine by default and can inspect every BB project and thread; give project_id only when the task needs that repository's files. Supply context, constraints, and expected result in task. Returns launch status, not completion; the result, failure, or question is reported to you automatically in this call. Hidden only means it is not listed in the sidebar.",
  create_thread: "Create a visible root thread with the given body as its prompt. Returns launch status; the result, failure, or question is reported to you automatically in this call.",
  prepare_draft: "Write to the exact thread or project composer on the call owner device. Never submit. Append unless replacement was requested.",
  control_ui: "Navigate on the call owner device. Open a thread or project, preview a file, or show Voice. Background updates cannot navigate.",
  stop_thread: "Request a stop on explicit user intent. Acceptance does not prove every process exited. The outcome is reported to you automatically in this call.",
  rename_thread: "Give a thread a new title on explicit user intent. Use the user's words. The receipt carries the previous and the new title.",
  subscriptions: "List watches, explicitly subscribe or re-enable one, or disable updates without stopping work. A later send does not re-enable updates.",
  prepare_archive: "Preview the requested threads, all children, active work, and queued messages. Explain the list aloud and ask once before archive_threads.",
  archive_threads: "Archive only the unused preview after it was spoken and drained and a later utterance confirms it. Changed scope requires a fresh preview.",
  answer_interaction: "Answer a pending native question or approval that was spoken in this call. Requires a later user utterance after drain. For approvals say the subject and reason first. Never invent consent.",
  remain_silent: "End without speech. Defer updates by default, or dismiss redundant updates. Critical items remain pending.",
  end_call: "Hang up after the current response drains, only on clear user intent.",
};
export interface ProfileChoice { name: string; instructions: string }
export interface LiveToolOptions { profiles?: ProfileChoice[]; defaultProfile?: string }
const summary = (text: string) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > 90 ? `${line.slice(0, 87)}...` : line; };
/** The model only knows the values it is shown; configured profile names become an enum and a description. */
export function liveToolSchemas(options: LiveToolOptions = {}) {
  const names = (options.profiles ?? []).map(p => p.name);
  return (Object.keys(liveToolArgs) as LiveTool[]).map(name => {
    let description = descriptions[name], schema: z.ZodType = liveToolArgs[name];
    if (name === "spawn_worker" && names.length > 0) {
      const fallback = options.defaultProfile && names.includes(options.defaultProfile) ? options.defaultProfile : names[0];
      description += ` Profiles: ${options.profiles!.map(p => `${p.name} (${summary(p.instructions)})`).join("; ")}. Default: ${fallback}.`;
      schema = liveToolArgs.spawn_worker.extend({ profile: z.enum(names as [string, ...string[]]).optional().describe(`A configured profile name. Omit for ${fallback}.`) }).strict();
    }
    return { type: "function" as const, name, description, parameters: z.toJSONSchema(schema) };
  });
}
