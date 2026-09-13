import { Worker } from "node:worker_threads";
import { ToolError } from "./config";
import { errorView, type Store } from "./store";
import { approveInteraction, getOp, runOp } from "./ops";
import { SDK_METHODS, SDK_VERSION, SIGNAL_PATHS as SIGNAL_PATH_LIST } from "./sdk-api";

export const EXECUTE_TOOL = "bb_execute";
export const READ_TOOL = "bb_read";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_CALLS = 500;
const MAX_LOG_BYTES = 8000;
const MAX_LOG_LINES = 100;
const MAX_RESULT_BYTES = 256 * 1024;

// bb_read only serves non-mutating methods: clients can auto-approve it.
const READ_VERBS = new Set([
  "get", "list", "count", "search", "output", "wait", "read", "status", "paths", "pathsExist",
  "catalog", "detail", "entries", "models", "version", "usageLimits", "providerStates",
  "providerCliStatus", "cliSkillsStatus", "attention", "defaultExecutionOptions", "executionOptions",
  "sidebarBootstrap", "promptHistory", "fileContent", "files", "branches", "commands",
  "listRunning", "cloneDefaultPath", "installPlan", "listUpdateResults", "checkUpdates", "getSource",
  "diff", "diffFile", "diffFiles", "diffBranches", "diffPatch", "pullRequest", "conversationOutline",
  "childSummary", "resolveMentions", "timeline", "timelineTurnSummaryDetails",
  "storageFiles", "storageLocation", "storagePaths", "render", "directory", "getContent", "listFiles",
  "repositoryStars",
  // 0.43.x: thread context usage, plugin metadata reads, environment and
  // machine provider catalogs, desktop browser inspection. machineEnvironment
  // lists variable names only — BB redacts values server-side.
  "context", "getPluginMetadata", "listProviders", "experimental_listProviders", "machineEnvironment",
  "listInstances", "listTabs", "listImportSources", "captureTab",
]);
// Reads whose verb is a mutation elsewhere (interactions.resolve) are listed
// by full path.
const READ_PATHS = new Set(["theme.resolve"]);
// Reads that still leak credentials or host configuration stay execute-only.
const READ_BLOCKED = new Set(["plugins.token", "plugins.getSettings", "system.config"]);
export function isReadPath(path: string): boolean {
  if (READ_BLOCKED.has(path)) return false;
  return READ_PATHS.has(path) || READ_VERBS.has(path.split(".").at(-1)!);
}

// The per-call signal overrides the request signal: runCode passes its
// execution controller; ops.run inner calls pass null — durable dispatch must
// survive the client disconnecting mid-operation.
export type Dispatch = (path: string, args: unknown, signal?: AbortSignal | null) => Promise<unknown>;

// threads.spawn callers that omit permissionMode get a resolved default: the
// project's configured execution default, else "full" clamped to the system
// permission ceiling. Never silently "accept-edits" — that default annoyed
// orchestrators that wanted unattended threads. Send/fork/queue inherit the
// thread's stored execution options when omitted; forcing "full" there can
// fail on threads without a stored execution model.
const PERMISSION_DEFAULT_PATHS = new Set(["threads.spawn"]);
const PERMISSION_RANK: Record<string, number> = { "accept-edits": 0, auto: 1, full: 2 };

// BB silently drops caller-supplied execution fields unless executionInputSources
// marks each one "explicit" — the SDK's create/send/edit/queue schemas all
// carry it. Marking supplied fields is a no-op when BB already honors them.
// threads.fork is deliberately absent: its SDK args schema is strict and does
// not declare executionInputSources, so injecting it would break forks.
const EXEC_SOURCE_PATHS = new Set(["threads.spawn", "threads.send", "threads.editMessage", "threads.queuedMessages.create"]);
const EXEC_SOURCE_FIELDS = ["providerId", "model", "reasoningLevel", "serviceTier", "permissionMode"];

// Methods whose args declare `signal?: AbortSignal` in the bundled SDK types.
// Injecting it anywhere else fails strict arg validation (files.write rejected
// the key). Generated into sdk-api.ts by `npm run sdk-api`.
const SIGNAL_PATHS = new Set(SIGNAL_PATH_LIST);

// Lookup failures propagate: spawning with a guessed mode is worse than
// erroring — BB's own default may be a remembered "accept-edits".
async function resolvePermissionMode(sdk: unknown, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  let mode: unknown;
  if (typeof args.projectId === "string")
    mode = (await sdkCall(sdk, "projects.defaultExecutionOptions", { projectId: args.projectId }, signal) as { permissionMode?: unknown } | undefined)?.permissionMode;
  let resolved = typeof mode === "string" ? mode : "full";
  const ceiling = (await sdkCall(sdk, "system.executionOptions", {}, signal) as { permissionCeiling?: unknown } | undefined)?.permissionCeiling;
  if (typeof ceiling === "string" && ceiling in PERMISSION_RANK && (PERMISSION_RANK[resolved] ?? PERMISSION_RANK.full) > PERMISSION_RANK[ceiling]) resolved = ceiling;
  return resolved;
}

// Resolves "threads.interactions.list"-style paths into bb.sdk calls. Paths are
// whitelisted against the declared SDK surface first — without that check the
// walker below could reach host-realm members (fn.constructor, subscribe).
// The request's abort `signal` is injected into plain-object args only for
// paths whose SDK args declare it (SIGNAL_PATHS) — everywhere else strict arg
// validation would reject the unknown key.
// Reflect.apply, not fn.call: proxy-based SDK facades treat property access as
// a method path, so reading fn.call would resolve a bogus "<path>.call".
export async function sdkCall(sdk: unknown, path: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!SDK_PATH_SET.has(path)) throw new ToolError("not_found", `Unknown BB method "${path}".`);
  const parts = path.split(".");
  let node: unknown = sdk;
  for (const p of parts.slice(0, -1)) {
    if (node === null || (typeof node !== "object" && typeof node !== "function")) throw new ToolError("not_found", `Unknown BB method "${path}".`);
    node = (node as Record<string, unknown>)[p];
  }
  const fn = node !== null && (typeof node === "object" || typeof node === "function") ? (node as Record<string, unknown>)[parts.at(-1)!] : undefined;
  if (typeof fn !== "function") throw new ToolError("not_found", `Unknown BB method "${path}".`);
  const callArgs = args !== null && typeof args === "object" && !Array.isArray(args)
    ? (SIGNAL_PATHS.has(path) ? { ...args, signal } : { ...(args as Record<string, unknown>) })
    : args;
  if (EXEC_SOURCE_PATHS.has(path) && callArgs !== null && typeof callArgs === "object") {
    const a = callArgs as Record<string, unknown>;
    const sources = a.executionInputSources !== null && typeof a.executionInputSources === "object" ? { ...(a.executionInputSources as Record<string, unknown>) } : {};
    for (const f of EXEC_SOURCE_FIELDS) if (a[f] !== undefined && sources[f] === undefined) sources[f] = "explicit";
    if (PERMISSION_DEFAULT_PATHS.has(path) && a.permissionMode === undefined) {
      // A failed lookup is pre-commit: the ledger must record "failed", not
      // "outcome_unknown" — spawn was never invoked.
      try { a.permissionMode = await resolvePermissionMode(sdk, a, signal); }
      catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError("precondition_failed", `Could not resolve the permissionMode default: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (sources.permissionMode === undefined) sources.permissionMode = "client-preference";
    }
    if (Object.keys(sources).length) a.executionInputSources = sources;
  }
  if (signal?.aborted) throw new ToolError("execution_aborted", "The request was cancelled.");
  return Reflect.apply(fn as (a: unknown) => Promise<unknown>, node, [callArgs]);
}

// One choke point for every host-bound call — audit log, then the read-only
// gate, then the SDK (or the approve helper built on it). Ledgered calls go
// through the same gate via their inner callback, deliberately without the
// request signal: durable dispatch must survive client disconnects.
export function makeDispatch(sdk: unknown, store: Store, log: (path: string) => void, signal?: AbortSignal, readOnly = false): Dispatch {
  const hostCall = (name: string, input: unknown, sig?: AbortSignal | null): Promise<unknown> => {
    log(name);
    if (readOnly && !isReadPath(name))
      throw new ToolError("not_read_method", `"${name}" can mutate; bb_read only serves read methods. Use bb_execute.`);
    const effective = sig === undefined ? signal : sig ?? undefined;
    // approve's inner calls must inherit the caller's raw signal, not the
    // normalized one — a ledgered approve passes null (durable), and
    // forwarding it as undefined would re-attach the request signal.
    return name === "approve" ? approveInteraction(input, (p, a) => hostCall(p, a, sig)) : sdkCall(sdk, name, input, effective);
  };
  return async (name, input, sig) => {
    if (name === "ops.get") { log(name); return getOp(store, input, readOnly ? p => READ_BLOCKED.has(p) : undefined); }
    if (name === "ops.run") {
      log(name);
      if (readOnly) throw new ToolError("not_read_method", "Durable dispatch can mutate; bb_read only serves read methods. Use bb_execute.");
      return runOp(store, input, (p, a) => hostCall(p, a, null), p => READ_BLOCKED.has(p));
    }
    return hostCall(name, input, sig);
  };
}

// Runs inside the worker thread. Plain CommonJS; the only bridge back to the
// host is parentPort. Dotted tool paths become nested `bb` members.
const WORKER_SRC = `"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { Buffer } = require("node:buffer");
const { webcrypto } = require("node:crypto");
const { code, paths, maxCalls, maxLogBytes, maxLogLines, maxResultBytes } = workerData;
const pending = new Map();
let seq = 0, calls = 0, logBytes = 0;
const logs = [];
const record = (...values) => {
  if (logBytes >= maxLogBytes || logs.length >= maxLogLines) return;
  const line = values.map(v => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } }).join(" ").slice(0, 2000);
  logBytes += line.length;
  logs.push(line);
};
parentPort.on("message", m => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.result);
  else p.reject(Object.assign(new Error(m.error && m.error.message ? m.error.message : "Call failed."), { code: m.error && m.error.code }));
});
const invoke = (path, args) => {
  if (++calls > maxCalls) return Promise.reject(new Error("More than " + maxCalls + " bb calls in one execution."));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try { parentPort.postMessage({ call: true, id, path, args: args === undefined ? {} : args }); }
    catch { pending.delete(id); reject(Object.assign(new Error("Call arguments must be structured-cloneable data."), { code: "invalid_arguments" })); }
  });
};
const bb = {};
for (const path of paths) {
  const parts = path.split(".");
  let node = bb;
  for (const p of parts.slice(0, -1)) node = node[p] || (node[p] = {});
  node[parts[parts.length - 1]] = args => invoke(path, args);
}
const context = vm.createContext({
  bb,
  console: { log: record, info: record, warn: record, error: record, debug: record },
  setTimeout, clearTimeout,
  Buffer, btoa, atob, TextEncoder, TextDecoder, crypto: webcrypto,
});
const finish = msg => {
  if (msg.done) {
    // Serialize in the worker: the result crossing the bridge is already valid
    // JSON, measured in UTF-8 bytes, or a clean failure message.
    let json;
    try { json = JSON.stringify(msg.result === undefined ? null : msg.result); }
    catch { return finish({ failed: true, message: "The returned value cannot be serialized as JSON (BigInt, circular reference). Reduce it inside the sandbox." }); }
    if (Buffer.byteLength(json, "utf8") > maxResultBytes) return finish({ failed: true, message: "Result exceeds " + maxResultBytes + " bytes. Filter, page or aggregate inside the sandbox before returning." });
    msg = { done: true, resultJson: json };
  }
  try { parentPort.postMessage({ ...msg, logs }); }
  catch { try { parentPort.postMessage({ failed: true, message: "The returned value could not be serialized.", logs }); } catch {} }
};
let compiled, firstErr;
// Compile the code as an expression first: compilation never executes, so a
// program is never run twice and a bare call returns its result instead of
// erroring after dispatching. If it does not parse, the code is
// statement-shaped — compile it once as an async function body. Leading
// comments/directives that break expression parsing are stripped and retried.
const stripped = code.replace(/^(?:\\s+|\\/\\/[^\\n]*(?:\\n|$)|\\/\\*[\\s\\S]*?\\*\\/|(["'])(?:\\\\[\\s\\S]|(?!\\1)[\\s\\S])*\\1\\s*;?)+/, "");
for (const source of stripped === code ? [code] : [code, stripped]) {
  try { compiled = new vm.Script("(\\n" + source + "\\n)"); break; }
  catch (e) { if (!firstErr) firstErr = e; }
}
if (!compiled) {
  try { compiled = new vm.Script("(async function __main__() {\\n" + code + "\\n})"); }
  catch (e) { finish({ failed: true, message: firstErr && firstErr.message ? firstErr.message : String(e) }); }
}
if (compiled) {
  try {
    const value = compiled.runInContext(context, { timeout: 5000 });
    Promise.resolve(typeof value === "function" ? value() : value).then(
      result => finish({ done: true, result }),
      e => finish({ failed: true, message: e && e.message ? e.message : String(e) }));
  } catch (e) { finish({ failed: true, message: e && e.message ? e.message : String(e) }); }
}`;

const MAX_CONCURRENT = 8;
let active = 0;
type Waiter = { signal?: AbortSignal; resolve: () => void; reject: (e: ToolError) => void; onAbort: () => void };
const waiters: Waiter[] = [];
const abortedError = () => new ToolError("execution_aborted", "The MCP request was cancelled.");
const promote = () => {
  while (active < MAX_CONCURRENT && waiters.length) {
    const w = waiters.shift()!;
    w.signal?.removeEventListener("abort", w.onAbort);
    if (w.signal?.aborted) { w.reject(abortedError()); continue; }
    active++;
    w.resolve();
  }
};
const acquire = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(abortedError()); return; }
  const w: Waiter = { signal, resolve, reject, onAbort: () => {
    const i = waiters.indexOf(w);
    if (i >= 0) { waiters.splice(i, 1); reject(abortedError()); }
  } };
  signal?.addEventListener("abort", w.onAbort, { once: true });
  waiters.push(w); promote();
});
const release = () => { active--; promote(); };

export async function runCode(opts: { code: string; paths: string[]; dispatch: Dispatch; timeoutMs?: number; signal?: AbortSignal }): Promise<{ result: unknown; logs: string[] }> {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  await acquire(opts.signal);
  // The slot is held until the worker is gone, not just settled — releasing
  // early lets a burst of cancelled calls stack live workers past the cap.
  let slotHeld = true, slotOwned = false;
  const releaseSlot = () => { if (slotHeld) { slotHeld = false; release(); } };
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { code: opts.code, paths: opts.paths, maxCalls: MAX_CALLS, maxLogBytes: MAX_LOG_BYTES, maxLogLines: MAX_LOG_LINES, maxResultBytes: MAX_RESULT_BYTES },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
      });
      let settled = false, timedOut = false;
      // Every worker-bound call carries this signal: cancellation or timeout
      // aborts in-flight host calls, and sdkCall refuses new dispatches.
      const ctrl = new AbortController();
      const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); };
      const finish = (fn: () => void) => { if (settled) return; settled = true; slotOwned = true; cleanup(); void worker.terminate().finally(releaseSlot); fn(); };
      // Abort the execution signal only when the run is being torn down —
      // after a clean `done` an unawaited call should still commit, not race.
      const onAbort = () => { ctrl.abort(); finish(() => reject(new ToolError("execution_aborted", "The MCP request was cancelled."))); };
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); void worker.terminate(); }, timeoutMs);
      if (opts.signal?.aborted) { onAbort(); return; }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      worker.on("message", (m: { call?: boolean; id?: number; path?: string; args?: unknown; done?: boolean; failed?: boolean; resultJson?: string; logs?: string[]; message?: string }) => {
        if (m.call) {
          if (settled) return;
          // Deferred invocation: a synchronous throw from dispatch must still
          // become an error reply, never an unhandled exception in the handler.
          Promise.resolve().then(() => opts.dispatch(m.path!, m.args, ctrl.signal)).then(
            result => {
              try { worker.postMessage({ id: m.id, ok: true, result }); }
              catch {
                try { worker.postMessage({ id: m.id, ok: false, error: { code: "unserializable_result", message: `"${m.path}" returned a value that cannot cross the sandbox bridge (live handle, function or stream).` } }); } catch { /* worker gone */ }
              }
            },
            (e: unknown) => { try { worker.postMessage({ id: m.id, ok: false, error: errorView(e) }); } catch { /* worker gone */ } },
          );
        } else if (m.done) finish(() => resolve({ result: m.resultJson === undefined ? null : JSON.parse(m.resultJson), logs: m.logs ?? [] }));
        else if (m.failed) finish(() => reject(new ToolError("execution_failed", String(m.message).slice(0, 1000))));
      });
      worker.on("error", e => finish(() => reject(new ToolError("execution_failed", e.message.slice(0, 500)))));
      worker.on("exit", code => finish(() => reject(new ToolError(timedOut ? "execution_timeout" : "execution_failed",
        timedOut ? `Execution exceeded ${timeoutMs} ms and was terminated.` : `Code worker exited (${String(code)}).`))));
    });
  } finally { if (!slotOwned) releaseSlot(); }
}

// The method listing is generated into sdk-api.ts from @get-bb/plugin-sdk's
// bundled bb-plugin-sdk.d.ts (`npm run sdk-api` after `bb plugin types`); the
// sandbox exposes exactly those paths plus bb.ops and bb.approve.
// tests/codemode.test.ts "SDK surface coverage" fails when it drifts.
export const SDK_API = `${SDK_METHODS}
interface OperationResult {
  id: string; kind: string; projectId: string | null; hostId: string | null;
  threadId: string | null; related?: { threadId: string; projectId: string; hostId: string | null }[];
  state: "pending" | "accepted" | "outcome_unknown"; createdAt: number; updatedAt: number;
  response: Record<string, unknown> | null; error?: { code: string; message: string };
}
interface BbOps {
  /** Durable dispatch: dedupe by key, record the outcome, recover with ops.get after disconnects. Use for creates/sends and other non-idempotent work. */
  run(args: { call: string; args?: unknown; key?: string; kind?: string; threadId?: string; projectId?: string }): Promise<OperationResult>;
  /** Read a stored ops.run receipt. outcome_unknown may have been accepted by BB; inspect BB before any new-key retry. */
  get(args: { operationId: string }): Promise<OperationResult>;
}
interface ApproveArgs {
  threadId: string;
  interactionId: string;
  decision: "allow_once" | "allow_for_session" | "deny";
  /** allow_* only; allow_for_session defaults to the request's sessionGrant. */
  grantedPermissions?: { fileSystem?: { read: string[]; write: string[] } | null; network?: { enabled: boolean | null } | null } | null;
}
declare const bb: BbSdk & { ops: BbOps; approve(args: ApproveArgs): Promise<unknown> };
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;`;

// Overloads (theme.set) declare one path twice; the sandbox exposes it once.
export const SDK_PATHS = [...new Set(SDK_API.split("\n")
  .map(line => line.match(/^([\w.]+)\(/)?.[1])
  .filter((p): p is string => !!p))]
  .concat(["ops.run", "ops.get", "approve"]);
export { SDK_VERSION };

// The dispatch whitelist: only declared SDK methods can be invoked through
// sdkCall — anything else (constructor, toString, subscribe, ad-hoc function
// members) is rejected before the path walker touches the object graph.
const SDK_PATH_SET = new Set(SDK_PATHS.filter(p => !p.startsWith("ops.") && p !== "approve"));

export const EXECUTE_DESCRIPTION = `Run JavaScript against the complete BB SDK in an isolated worker: compose calls, loop, and filter server-side so only the returned value crosses the wire. Trusted callers only — the worker is a reliability boundary (timeouts, memory caps, log capture), not a security sandbox; code it runs has the token's full owner-level access.

\`code\` must evaluate to an async function: \`async () => { ...; return result; }\`. Anything else runs once as a bare function body (statements ending in \`return\`).

Global \`bb\` mirrors the BB SDK method-for-method (bb.threads.get calls sdk.threads.get, and so on). Each resolves to the SDK result or throws an Error with a string \`.code\` (e.g. not_found, invalid_arguments, bb_error). Argument and result types are the BB SDK's own; BB validates server-side and errors are descriptive. \`bb.guide.render()\` returns BB's usage guide. Methods returning live handles (e.g. \`subscribe\`) are not exposed. Args accept the SDK's standard \`signal\` option implicitly: cancelling this call aborts inner waits.

The SDK has no durable dispatch, so \`bb.ops\` adds it:
- ops.run({ call: "threads.spawn", args, key?, kind?, threadId?, projectId? }) runs one SDK call inside a recorded receipt. Reusing \`key\` with the same call+args replays the stored receipt instead of dispatching again; a different payload is idempotency_conflict. state "outcome_unknown" means BB may have committed; inspect BB (threads.get/list) before retrying under a new key. Calls that return credentials or configuration (plugins.token, plugins.getSettings, system.config) are refused — call them directly; a receipt would only persist the secret. When the call is threads.spawn or threads.fork, the new thread's bb-mcp plugin-metadata namespace is seeded with { operationId } merged over any \`args.pluginMetadata\` you pass (your keys are kept; operationId is set by the plugin), so \`bb.threads.getPluginMetadata({ threadId })\` recovers the receipt id from the thread itself.
- ops.get({ operationId }) reads a stored receipt.

\`bb.approve({ threadId, interactionId, decision, grantedPermissions? })\` resolves a pending permission approval — the code-mode equivalent of \`bb thread approve\` / \`bb thread grant --scope session\`. It verifies the interaction is still a pending approval — including its \`status\` and \`expiresAt\` when present — checks the decision is in its \`availableDecisions\`, and builds the resolution BB expects (\`grantedPermissions\` is a required-but-nullable key on allow_*; omitting it fails with "Invalid discriminator value"; deny takes none). \`allow_for_session\` defaults \`grantedPermissions\` to the request's offered \`sessionGrant\`. For user_question and plugin-form interactions use \`threads.interactions.resolve\` directly with \`{ kind: "user_answer", answers }\` or \`{ kind: "request_answer", value }\` — inspect the interaction first for its contract.

console.* output returns in \`logs\`. Provided globals: setTimeout/clearTimeout, Buffer, btoa/atob, TextEncoder/TextDecoder, crypto.randomUUID/getRandomValues. No module imports. Limits: ${DEFAULT_TIMEOUT_MS} ms default timeout (${MAX_TIMEOUT_MS} ms max via timeoutMs), ${MAX_CALLS} bb calls, ${MAX_LOG_BYTES} B of logs, ${MAX_RESULT_BYTES} B returned result (UTF-8 JSON). A terminated or disconnected execution does not stop work BB already accepted.

Results are the SDK's raw shapes: list methods return bare arrays, reads return their documented objects — there is no per-call envelope beyond \`{data:{result,logs}}\`. Large SDK responses (e.g. providers.models) stay inside the sandbox fine; only the returned value crosses the wire, so filter/aggregate before returning.

Common argument shapes (BB validates server-side):
\`\`\`ts
threads.spawn(args: {
  projectId: string;
  input: { type: "text"; text: string; mentions?: Mention[] }[];
  title?: string;
  environment:
    | { type: "reuse"; environmentId: string }
    | { type: "host"; hostId?: string; workspace:
        | { type: "managed-worktree"; baseBranch: { kind: "default" } | { kind: "named"; name: string } }
        | { type: "personal" }
        | { type: "unmanaged"; path: string | null; branch?: { kind: "existing"; name: string } | { kind: "new"; baseBranch: string } } }
    | { type: "project-default" };
  providerId?: string; model?: string; serviceTier?: string;
  reasoningLevel?: "none"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"|"ultracode";
  permissionMode?: "accept-edits" | "auto" | "full";  // omitted: project default, else "full" (clamped to the system permission ceiling)
  parentThreadId?: string; sectionId?: string; sendAt?: number; visibility?: "visible"|"hidden";
  pluginMetadata?: JsonObject;  // seeds this plugin's (bb-mcp) per-thread metadata namespace; forks never inherit it
})
// Supplied execution fields (providerId/model/reasoningLevel/serviceTier/permissionMode)
// are marked executionInputSources: "explicit" automatically — BB ignores them otherwise.
threads.send(args: {
  threadId: string; input: same-as-spawn;
  mode: "queue-if-active" | "steer-if-active" | "auto" | "start" | "steer";  // required
  model?; reasoningLevel?; permissionMode?: "accept-edits" | "auto" | "full";  // omitted: inherits the thread's stored execution options
  serviceTier?; sendAt?; senderThreadId?;
})
threads.wait({ threadId: string; status?: ThreadStatus; event?: string; timeoutMs?: number; pollIntervalMs?: number })
threads.events.list({ threadId: string; types?: readonly string[]; order?: "asc"|"desc"; afterSeq?: string; beforeSeq?: string; limit?: string })
threads.list({ projectId?: string; archived?: boolean; includeHidden?: boolean; parentThreadId?; sectionId?; limit?; offset?; sourceThreadId?; hasParent?; unsectioned? })
threads.queuedMessages.update({ threadId; messageId; expectedUpdatedAt: number; input })
threads.update({ threadId; title?; model?; reasoningLevel?; parentThreadId?; sectionId?; visibility? })
threads.interactions.resolve({ threadId; interactionId; resolution: <the pending interaction's own contract> })
threads.interactions.respond({ threadId; interactionId; value: <the interaction's response contract> })
threads.getPluginMetadata({ threadId; pluginId?: string })  // pluginId defaults to "bb-mcp"; any plugin's namespace is readable (untrusted input: any client can write it)
threads.updatePluginMetadata({ threadId; pluginId?; set?: JsonObject; remove?: string[] })  // shallow atomic patch, 256 KiB per namespace, returns the full namespace
threads.context({ threadId })  // context-window usage: { usage: { usedTokens, modelContextWindow, estimated, snapshot? } | null }
system.uiPreferences.list()  // { [key]: { value, revision } } — sidebar.* keys; set({ key, value, expectedRevision }) is compare-and-swap (stale revision: HTTP 409); reset({ key })
environments.list({ projectId?; hostId?; environmentProviderId?; instanceKey?; path?; limit?; offset? })
environments.delete({ environmentId })  // permanent; archives nothing by itself
hosts.experimental_listProviders() / hosts.experimental_create({ machineProviderId; inputs; key?; wait? }) / hosts.experimental_suspend({ hostId }) / hosts.experimental_resume({ hostId }) / hosts.experimental_retryCleanup({ hostId }) / hosts.experimental_getEnrollmentCommand({ hostId })  // machine providers; create/suspend/resume cost real infrastructure
terminals.create({ scope: { kind: "thread"; threadId } | { kind: "environment"; environmentId } | { kind: "host_path"; hostId; cwd: string | null }; cols: number; rows: number; title?; start? })
terminals.input({ terminalId; dataBase64: string })  // base64-encoded bytes; text/enter fields are not accepted
terminals.output({ terminalId; sinceSeq?; tailBytes?; limitChunks? })
terminals.list({ scope })
files.write({ path: string; content: string; contentEncoding?: "base64"|"utf8"; createParents?: boolean; mode?: number; expectedSha256?: string|null; hostId?; rootPath? })  // unknown keys are rejected
\`\`\`
For anything else, inspect the target first (e.g. bb.threads.interactions.get) — pending interactions carry their own response schema.

Handoff convention: spawn input items can carry a source-thread mention — text "Continue from @thread:<id>\n\n<prompt>" with mentions [{ start, end, resource: { kind: "thread", projectId, threadId, label } }]. Read the source thread for projectId and label first.

\`\`\`ts
${SDK_API}
\`\`\`

Example — create work durably, wait for it, read the latest assistant text:
\`\`\`js
async () => {
  const op = await bb.ops.run({
    kind: "create", key: "ticket-42-start",
    call: "threads.spawn",
    args: {
      projectId: "proj_x",
      input: [{ type: "text", text: "Fix the failing tests", mentions: [] }],
      // permissionMode omitted: resolves to the project's configured default, else "full".
      // Do not supply "accept-edits" unless the work must pause for file approvals.
      environment: { type: "host", hostId: "host_x", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
    },
  });
  const threadId = op.threadId;
  await bb.threads.wait({ threadId, status: "idle", timeoutMs: 60000 });
  const events = await bb.threads.events.list({ threadId, order: "desc", limit: "5", types: ["item/completed"] });
  return events.map(e => e.data && e.data.item && e.data.item.text).filter(Boolean)[0] ?? null;
}
\`\`\``;

export const READ_DESCRIPTION = `Read-only variant of ${EXECUTE_TOOL}: identical sandbox and \`bb\` global, restricted to non-mutating methods (get/list/wait/status/search/diff/timeline/context/getPluginMetadata/uiPreferences.list and similar). Annotated read-only so MCP clients can auto-approve it; a mutating call fails with not_read_method — use ${EXECUTE_TOOL} for those. Credential-bearing reads (plugins.token, plugins.getSettings, system.config, hosts.experimental_getEnrollmentCommand) stay execute-only. Prefer this tool for monitoring, discovery and reporting flows.

\`\`\`ts
${SDK_API}
\`\`\``;
