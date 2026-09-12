import { Worker } from "node:worker_threads";
import { ToolError } from "./config";
import { errorView, type Store } from "./store";
import { approveInteraction, getOp, runOp } from "./ops";

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
]);
// Reads that still leak credentials or host configuration stay execute-only.
const READ_BLOCKED = new Set(["plugins.token", "plugins.getSettings", "system.config"]);
export function isReadPath(path: string): boolean {
  if (READ_BLOCKED.has(path)) return false;
  return READ_VERBS.has(path.split(".").at(-1)!);
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
// the key). Regenerate from bb-plugin-sdk.d.ts when the SDK version changes.
const SIGNAL_PATHS = new Set(["environments.diff","environments.diffBranches","environments.diffFile","environments.diffFiles","environments.diffPatch","environments.get","environments.pullRequest","environments.paths","environments.status","files.read","files.list","files.listPaths","files.createPreview","hosts.directory","hosts.get","hosts.cloneDefaultPath","hosts.list","hosts.pathsExist","hosts.pickFolder","hosts.providerCliStatus","projects.attachments.read","projects.branches","projects.commands","projects.defaultExecutionOptions","projects.fileContent","projects.files","projects.get","projects.list","projects.paths","projects.promptHistory","projects.sidebarBootstrap","plugins.checkUpdates","plugins.catalog.installPlan","plugins.catalog.search","plugins.catalog.status","plugins.marketplaces.list","plugins.marketplaces.refresh","plugins.getSettings","plugins.getSource","plugins.list","plugins.listUpdateResults","providers.list","providers.models","skills.getContent","skills.list","skills.listFiles","skills.registry.detail","skills.registry.entries","skills.registry.get","skills.registry.repositoryStars","skills.registry.search","status.get","system.attention","system.config","system.executionOptions","system.cliSkillsStatus","system.transcribeVoice","system.providerStates","system.usageLimits","system.version","terminals.get","terminals.list","terminals.output","theme.get","theme.catalog","threadSections.list","threads.childSummary","threads.conversationOutline","threads.count","threads.defaultExecutionOptions","threads.events.list","threads.events.wait","threads.get","threads.queue.list","threads.interactions.get","threads.interactions.list","threads.list","threads.listRunning","threads.output","threads.promptHistory","threads.queuedMessages.list","threads.resolveMentions","threads.search","threads.tabs.get","threads.timeline","threads.timelineTurnSummaryDetails","threads.storageFiles","threads.storageLocation","threads.storagePaths","threads.wait"]);

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
      const finish = (fn: () => void) => { if (settled) return; settled = true; slotOwned = true; ctrl.abort(); cleanup(); void worker.terminate().finally(releaseSlot); fn(); };
      const onAbort = () => finish(() => reject(new ToolError("execution_aborted", "The MCP request was cancelled.")));
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

// Generated from @get-bb/plugin-sdk's bundled bb-plugin-sdk.d.ts. Regenerate if
// the SDK version changes; the sandbox exposes exactly these paths plus bb.ops.
// tests/codemode.test.ts "SDK surface coverage" fails when this drifts.
export const SDK_API = `
environments.archiveThreads(args: EnvironmentActionArgs): Promise<EnvironmentArchiveThreadsResult>;
environments.commit(args: EnvironmentCommitArgs): Promise<EnvironmentCommitResult>;
environments.diff(args: EnvironmentDiffArgs): Promise<EnvironmentDiffResult>;
environments.diffBranches(args: EnvironmentDiffBranchesArgs): Promise<EnvironmentDiffBranchesResult>;
environments.diffFile(args: EnvironmentDiffFileArgs): Promise<EnvironmentDiffFileResult>;
environments.diffFiles(args: EnvironmentDiffArgs): Promise<EnvironmentDiffFilesResult>;
environments.diffPatch(args: EnvironmentDiffPatchArgs): Promise<EnvironmentDiffPatchResult>;
environments.get(args: EnvironmentGetArgs): Promise<EnvironmentGetResult>;
environments.pullRequest(args: EnvironmentGetArgs): Promise<EnvironmentPullRequestResult>;
environments.markPullRequestDraft(args: EnvironmentActionArgs): Promise<EnvironmentMarkPullRequestDraftResult>;
environments.markPullRequestReady(args: EnvironmentActionArgs): Promise<EnvironmentMarkPullRequestReadyResult>;
environments.mergePullRequest(args: EnvironmentPullRequestMergeArgs): Promise<EnvironmentMergePullRequestResult>;
environments.paths(args: EnvironmentPathsArgs): Promise<EnvironmentPathsResult>;
environments.status(args: EnvironmentStatusArgs): Promise<EnvironmentStatusResult>;
environments.update(args: EnvironmentUpdateArgs): Promise<EnvironmentUpdateResult>;
files.read(args: FileReadArgs): Promise<FileReadResult>;
files.write(args: FileWriteArgs): Promise<FileWriteResult>;
files.list(args: FileListArgs): Promise<FileListResult>;
files.listPaths(args: PathListArgs): Promise<PathListResult>;
files.mkdir(args: FileMkdirArgs): Promise<FileMkdirResult>;
files.move(args: FileMoveArgs): Promise<FileMoveResult>;
files.remove(args: FileRemoveArgs): Promise<FileRemoveResult>;
files.createPreview(args: FilePreviewArgs): Promise<FilePreviewResult>;
hosts.createJoinCode(): Promise<HostCreateJoinCodeResult>;
hosts.delete(args: HostDeleteArgs): Promise<HostDeleteResult>;
hosts.directory(args: HostDirectoryArgs): Promise<HostDirectoryResult>;
hosts.get(args: HostGetArgs): Promise<HostGetResult>;
hosts.cloneDefaultPath(args: HostCloneDefaultPathArgs): Promise<HostCloneDefaultPathResult>;
hosts.installProviderCli(args: HostProviderCliInstallArgs): Promise<HostProviderCliInstallResult>;
hosts.list(args?: HostListArgs): Promise<HostListResult>;
hosts.pathsExist(args: HostPathsExistArgs): Promise<HostPathsExistResult>;
hosts.pickFolder(args: HostPickFolderArgs): Promise<HostPickFolderResult>;
hosts.providerCliStatus(args: HostGetArgs): Promise<HostProviderCliStatusResult>;
hosts.retryUpdate(args: HostRetryUpdateArgs): Promise<HostRetryUpdateResult>;
hosts.update(args: HostUpdateArgs): Promise<HostUpdateResult>;
projects.attachments.copy(args: ProjectAttachmentCopyArgs): Promise<void>;
projects.attachments.read(args: ProjectAttachmentReadArgs): Promise<ProjectAttachmentReadResult>;
projects.attachments.upload(args: ProjectAttachmentUploadArgs): Promise<ProjectAttachmentUploadResult>;
projects.branches(args: ProjectBranchesArgs): Promise<ProjectBranchesResult>;
projects.commands(args: ProjectCommandsArgs): Promise<ProjectCommandsResult>;
projects.create(args: ProjectCreateArgs): Promise<ProjectCreateResult>;
projects.defaultExecutionOptions(args: ProjectDefaultExecutionOptionsArgs): Promise<ProjectDefaultExecutionOptionsResult>;
projects.delete(args: ProjectDeleteArgs): Promise<ProjectDeleteResult>;
projects.fileContent(args: ProjectFileContentArgs): Promise<ProjectFileContentResult>;
projects.files(args: ProjectFilesArgs): Promise<ProjectFilesResult>;
projects.get(args: ProjectGetArgs): Promise<ProjectGetResult>;
projects.list(args?: ProjectListArgs): Promise<ProjectListResult>;
projects.paths(args: ProjectPathsArgs): Promise<ProjectPathsResult>;
projects.promptHistory(args: ProjectPromptHistoryArgs): Promise<ProjectPromptHistoryResult>;
projects.reorder(args: ProjectReorderArgs): Promise<ProjectReorderResult>;
projects.sidebarBootstrap(args?: ProjectSidebarBootstrapArgs): Promise<ProjectSidebarBootstrapResult>;
projects.sources.add(args: ProjectSourceAddArgs): Promise<ProjectSourceAddResult>;
projects.sources.delete(args: ProjectSourceDeleteArgs): Promise<ProjectSourceDeleteResult>;
projects.sources.update(args: ProjectSourceUpdateArgs): Promise<ProjectSourceUpdateResult>;
projects.update(args: ProjectUpdateArgs): Promise<ProjectUpdateResult>;
plugins.applyUpdate(args: PluginIdArgs): Promise<PluginApplyUpdateResult>;
plugins.checkUpdates(args?: PluginCheckUpdatesArgs): Promise<PluginCheckUpdatesResult>;
plugins.catalog.install(args: PluginCatalogInstallArgs): Promise<PluginInstallResult>;
plugins.catalog.installPlan(args: PluginCatalogInstallPlanArgs): Promise<PluginCatalogInstallPlanResult>;
plugins.catalog.search(args: PluginCatalogSearchArgs): Promise<PluginCatalogSearchResult>;
plugins.catalog.status(args?: PluginCatalogStatusArgs): Promise<PluginCatalogStatusResult>;
plugins.marketplaces.add(args: PluginMarketplaceAddArgs): Promise<PluginMarketplaceAddResult>;
plugins.marketplaces.list(args?: PluginMarketplaceListArgs): Promise<PluginMarketplaceListResult>;
plugins.marketplaces.refresh(args?: PluginMarketplaceRefreshArgs): Promise<PluginMarketplaceRefreshResult>;
plugins.marketplaces.remove(args: PluginMarketplaceRemoveArgs): Promise<PluginMarketplaceRemoveResult>;
plugins.disable(args: PluginIdArgs): Promise<PluginDisableResult>;
plugins.enable(args: PluginIdArgs): Promise<PluginEnableResult>;
plugins.getSettings(args: PluginGetSettingsArgs): Promise<PluginGetSettingsResult>;
plugins.getSource(args: PluginGetSourceArgs): Promise<PluginGetSourceResult>;
plugins.install(args: PluginInstallArgs): Promise<PluginInstallResult>;
plugins.list(args?: PluginListArgs): Promise<PluginListResult>;
plugins.listUpdateResults(args?: PluginListUpdateResultsArgs): Promise<PluginCheckUpdatesResult>;
plugins.reload(args?: PluginReloadArgs): Promise<PluginReloadResult>;
plugins.remove(args: PluginIdArgs): Promise<PluginRemoveResult>;
plugins.token(args: PluginTokenArgs): Promise<PluginTokenResult>;
plugins.updateSettings(args: PluginSettingsUpdateArgs): Promise<PluginUpdateSettingsResult>;
providers.list(args?: ProviderListArgs): Promise<ProviderListResult>;
providers.models(args?: ProviderModelsArgs): Promise<ProviderModelsResult>;
skills.getContent(args: SkillContentArgs): Promise<SkillContentResponse>;
skills.list(args: SkillListArgs): Promise<SkillListResponse>;
skills.listFiles(args: SkillIdentityArgs): Promise<SkillFilesResponse>;
skills.registry.detail(args: RegistrySkillSourceArgs): Promise<RegistrySkillDetail>;
skills.registry.entries(args: RegistrySkillEntriesArgs): Promise<RegistrySkillEntriesResponse>;
skills.registry.get(args: RegistrySkillIdArgs): Promise<RegistrySkill>;
skills.registry.install(args: RegistrySkillInstallArgs): Promise<RegistrySkillInstallResponse>;
skills.registry.repositoryStars(args: RegistryRepositoryArgs): Promise<RegistryRepositoryStars>;
skills.registry.search(args?: RegistrySkillsSearchArgs): Promise<RegistrySkillsPage>;
skills.remove(args: SkillDeleteArgs): Promise<{ deletedPath: string }>;
skills.update(args: SkillUpdateArgs): Promise<{ filePath: string; revision: string }>;
status.get(args?: StatusGetArgs): Promise<StatusResult>;
system.attention(args?: SystemAttentionArgs): Promise<SystemAttentionResult>;
system.config(args?: SystemConfigArgs): Promise<SystemConfigResult>;
system.executionOptions(args?: SystemExecutionOptionsArgs): Promise<SystemExecutionOptionsResult>;
system.cliSkillsStatus(args?: SystemCliSkillsStatusArgs): Promise<SystemCliSkillsStatusResult>;
system.installCliSkills(args: SystemInstallCliSkillsArgs): Promise<SystemInstallCliSkillsResult>;
system.reloadConfig(): Promise<SystemReloadConfigResult>;
system.transcribeVoice(args: SystemVoiceTranscriptionArgs): Promise<SystemVoiceTranscriptionResult>;
system.updateExperiments(args: Experiments): Promise<SystemUpdateExperimentsResult>;
system.updateGeneralSettings(args: AppSettings): Promise<SystemUpdateGeneralSettingsResult>;
system.updateKeyboardSettings(args: AppKeybindingOverrides): Promise<SystemUpdateKeyboardSettingsResult>;
system.providerStates(args?: SystemProviderStatesArgs): Promise<SystemProviderStatesResult>;
system.usageLimits(args?: SystemUsageLimitsArgs): Promise<SystemUsageLimitsResult>;
system.version(args?: SystemVersionArgs): Promise<SystemVersionResult>;
terminals.close(args: TerminalCloseArgs): Promise<TerminalCloseResult>;
terminals.create(args: TerminalCreateArgs): Promise<TerminalCreateResult>;
terminals.get(args: TerminalGetArgs): Promise<TerminalGetResult>;
terminals.input(args: TerminalInputArgs): Promise<TerminalInputResult>;
terminals.list(args: TerminalListArgs): Promise<TerminalListResult>;
terminals.output(args: TerminalOutputArgs): Promise<TerminalOutputResult>;
terminals.rename(args: TerminalRenameArgs): Promise<TerminalRenameResult>;
terminals.restart(args: TerminalRestartArgs): Promise<TerminalRestartResult>;
terminals.resize(args: TerminalResizeArgs): Promise<TerminalResizeResult>;
theme.get(args?: ThemeGetArgs): Promise<ThemeGetResult>;
theme.catalog(args?: ThemeCatalogArgs): Promise<ThemeCatalogResult>;
theme.set(selection: ThemeSetInput): Promise<ThemeSetResult>;
threadSections.create(args: CreateThreadSectionRequest): Promise<ThreadSectionCreateResult>;
threadSections.delete(args: DeleteThreadSectionRequest): Promise<ThreadSectionDeleteResult>;
threadSections.list(args?: ThreadSectionListArgs): Promise<ThreadSectionListResult>;
threadSections.update(args: UpdateThreadSectionRequest): Promise<ThreadSectionUpdateResult>;
threads.archive(args: ThreadActionArgs): Promise<ThreadArchiveResult>;
threads.archiveAll(args: ThreadActionArgs): Promise<ThreadArchiveAllResult>;
threads.childSummary(args: ThreadStatusArgs): Promise<ThreadChildSummaryResult>;
threads.compact(args: ThreadActionArgs): Promise<ThreadCompactResult>;
threads.cancelPlan(args: ThreadActionArgs): Promise<ThreadBannerActionResult>;
threads.clearContext(args: ThreadActionArgs): Promise<ThreadBannerActionResult>;
threads.clearGoal(args: ThreadActionArgs): Promise<ThreadBannerActionResult>;
threads.conversationOutline(args: ThreadStatusArgs): Promise<ThreadConversationOutlineResult>;
threads.count(args?: ThreadCountArgs): Promise<ThreadCountResult>;
threads.defaultExecutionOptions(args: ThreadStatusArgs): Promise<ThreadDefaultExecutionOptionsResult>;
threads.delete(args: ThreadDeleteArgs): Promise<ThreadDeleteResult>;
threads.editMessage(args: ThreadEditMessageArgs): Promise<ThreadEditMessageResult>;
threads.events.list(args: ThreadEventsListArgs): Promise<ThreadEventsListResult>;
threads.events.wait(args: ThreadEventWaitArgs): Promise<ThreadEventWaitResult>;
threads.fork(args: ThreadForkArgs): Promise<ThreadForkResult>;
threads.get(args: ThreadGetArgs): Promise<ThreadGetResult>;
threads.queue.list(args?: ThreadQueueListArgs): Promise<ThreadQueueListResult>;
threads.interactions.cancel(args: ThreadInteractionTargetArgs): Promise<ThreadInteractionCancelResult>;
threads.interactions.get(args: ThreadInteractionGetArgs): Promise<ThreadInteractionGetResult>;
threads.interactions.list(args: ThreadInteractionListArgs): Promise<ThreadInteractionListResult>;
threads.interactions.resolve(args: ThreadInteractionResolveArgs): Promise<ThreadInteractionResolveResult>;
threads.interactions.respond(args: ThreadInteractionRespondArgs): Promise<ThreadInteractionRespondResult>;
threads.list(args?: ThreadListArgs): Promise<ThreadListResult>;
threads.listRunning(args?: { signal?: AbortSignal }): Promise<ThreadRunningResult>;
threads.markRead(args: ThreadActionArgs): Promise<ThreadReadStateResult>;
threads.markUnread(args: ThreadActionArgs): Promise<ThreadReadStateResult>;
threads.open(args: ThreadOpenArgs): Promise<ThreadOpenResult>;
threads.paneAction(args: ThreadPaneActionArgs): Promise<ThreadPaneActionResult>;
threads.output(args: ThreadOutputArgs): Promise<ThreadOutputResponse>;
threads.pin(args: ThreadActionArgs): Promise<ThreadMutationResult>;
threads.promptHistory(args: ThreadPromptHistoryArgs): Promise<ThreadPromptHistoryResult>;
threads.queuedMessages.create(args: ThreadQueuedMessageCreateArgs): Promise<ThreadQueuedMessageCreateResult>;
threads.queuedMessages.delete(args: ThreadQueuedMessageTargetArgs): Promise<ThreadQueuedMessageDeleteResult>;
threads.queuedMessages.list(args: ThreadQueuedMessageArgs): Promise<ThreadQueuedMessagesResult>;
threads.queuedMessages.reorder(args: ThreadQueuedMessageReorderArgs): Promise<ThreadQueuedMessageReorderResult>;
threads.queuedMessages.send(args: ThreadQueuedMessageSendArgs): Promise<ThreadQueuedMessageSendResult>;
threads.queuedMessages.setGroupBoundary(args: ThreadQueuedMessageGroupBoundaryArgs): Promise<ThreadQueuedMessageGroupBoundaryResult>;
threads.queuedMessages.update(args: ThreadQueuedMessageUpdateArgs): Promise<ThreadQueuedMessageUpdateResult>;
threads.reorderPinned(args: ThreadPinOrderArgs): Promise<ThreadPinOrderResult>;
threads.resolveMentions(args: ThreadResolveMentionsArgs): Promise<ThreadResolveMentionsResult>;
threads.retry(args: ThreadRetryArgs): Promise<ThreadRetryResult>;
threads.search(args: ThreadSearchArgs): Promise<ThreadSearchResult>;
threads.send(args: ThreadSendArgs): Promise<ThreadSendResult>;
threads.spawn(args: ThreadSpawnArgs): Promise<ThreadSpawnResult>;
threads.stop(args: ThreadActionArgs): Promise<ThreadStopResult>;
threads.tabs.get(args: ThreadStatusArgs): Promise<ThreadTabsResult>;
threads.tabs.update(args: ThreadTabsUpdateArgs): Promise<ThreadTabsUpdateResult>;
threads.timeline(args: ThreadTimelineArgs): Promise<ThreadTimelineResult>;
threads.timelineTurnSummaryDetails(args: ThreadTimelineTurnSummaryDetailsArgs): Promise<ThreadTimelineTurnSummaryDetailsResult>;
threads.storageFiles(args: ThreadStorageFilesArgs): Promise<ThreadStorageFilesResult>;
threads.storageLocation(args: ThreadStatusArgs): Promise<ThreadStorageLocationResult>;
threads.storagePaths(args: ThreadStoragePathsArgs): Promise<ThreadStoragePathsResult>;
threads.unarchive(args: ThreadActionArgs): Promise<ThreadUnarchiveResult>;
threads.unpin(args: ThreadActionArgs): Promise<ThreadMutationResult>;
threads.update(args: ThreadUpdateArgs): Promise<ThreadMutationResult>;
threads.wait(args: ThreadWaitArgs): Promise<ThreadWaitResult>;
guide.render(args?: GuideRenderArgs): GuideRenderResult;
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

export const SDK_PATHS = SDK_API.split("\n")
  .map(line => line.match(/^([\w.]+)\(/)?.[1])
  .filter((p): p is string => !!p)
  .concat(["ops.run", "ops.get", "approve"]);

// The dispatch whitelist: only declared SDK methods can be invoked through
// sdkCall — anything else (constructor, toString, subscribe, ad-hoc function
// members) is rejected before the path walker touches the object graph.
const SDK_PATH_SET = new Set(SDK_PATHS.filter(p => !p.startsWith("ops.") && p !== "approve"));

export const EXECUTE_DESCRIPTION = `Run JavaScript against the complete BB SDK in an isolated worker: compose calls, loop, and filter server-side so only the returned value crosses the wire. Trusted callers only — the worker is a reliability boundary (timeouts, memory caps, log capture), not a security sandbox; code it runs has the token's full owner-level access.

\`code\` must evaluate to an async function: \`async () => { ...; return result; }\`. Anything else runs once as a bare function body (statements ending in \`return\`).

Global \`bb\` mirrors the BB SDK method-for-method (bb.threads.get calls sdk.threads.get, and so on). Each resolves to the SDK result or throws an Error with a string \`.code\` (e.g. not_found, invalid_arguments, bb_error). Argument and result types are the BB SDK's own; BB validates server-side and errors are descriptive. \`bb.guide.render()\` returns BB's usage guide. Methods returning live handles (e.g. \`subscribe\`) are not exposed. Args accept the SDK's standard \`signal\` option implicitly: cancelling this call aborts inner waits.

The SDK has no durable dispatch, so \`bb.ops\` adds it:
- ops.run({ call: "threads.spawn", args, key?, kind?, threadId?, projectId? }) runs one SDK call inside a recorded receipt. Reusing \`key\` with the same call+args replays the stored receipt instead of dispatching again; a different payload is idempotency_conflict. state "outcome_unknown" means BB may have committed; inspect BB (threads.get/list) before retrying under a new key.
- ops.get({ operationId }) reads a stored receipt. Calls that return credentials or configuration (plugins.token, plugins.getSettings, system.config) are refused — call them directly; a receipt would only persist the secret.

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

export const READ_DESCRIPTION = `Read-only variant of ${EXECUTE_TOOL}: identical sandbox and \`bb\` global, restricted to non-mutating methods (get/list/wait/status/search/diff/timeline and similar). Annotated read-only so MCP clients can auto-approve it; a mutating call fails with not_read_method — use ${EXECUTE_TOOL} for those. Prefer this tool for monitoring, discovery and reporting flows.

\`\`\`ts
${SDK_API}
\`\`\``;
