// Pure translations from Muse's vocabulary to bb's: item shapes and their
// presentation, item statuses, token usage, approvals, questions, models and
// subscription windows. Nothing here does I/O except reading an edit's patch
// document from Muse's own session directory.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type AvailableModel,
  type DeltaFileChange,
  type DeltaItemShape,
  type DeltaPresentation,
  type DynamicTool,
  type PendingInteractionApprovalDecision,
  type PendingInteractionPayload,
  type ProviderRateLimitState,
  type ProviderRecoveryKind,
  type ProviderUsageWindow,
  type ThreadDelta,
  type ThreadEventItemStatus,
  type ThreadEventTokenUsageBreakdown,
  experimental_COMPACTION_PRESENTATION as COMPACTION_PRESENTATION,
  experimental_fileReadPresentation as fileReadPresentation,
  experimental_presentationDetail as presentationDetail,
  experimental_presentationTitle as presentationTitle,
  experimental_searchPresentation as searchPresentation,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
  experimental_withTitle as withTitle,
  LOCAL_BASH_TASK_TYPE,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  MspAccountUsage,
  MspApproval,
  MspApprovalChoice,
  MspItem,
  MspModelList,
  MspTokenUsage,
  MspTurnError,
  MspUserInput,
} from "./protocol.js";
import { BB_MCP_SERVER_NAME, MUSE_PROVIDER_ID } from "./vocabulary.js";

const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export interface ItemContext {
  cwd: string;
  /** bb's injected tools for this session, by bare name. */
  bbTools: ReadonlyMap<string, DynamicTool>;
}

export interface ItemRow {
  shape: DeltaItemShape;
  presentation?: DeltaPresentation;
}

type Args = Record<string, unknown>;

/** Muse sends tool arguments as the model's raw JSON text, partial while streaming. */
export function parseArgs(raw: unknown): Args {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw as Args;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Args)
      : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** `mcp__<server>__<tool>`, as Muse names MCP tools (non-word chars become `_`). */
export function splitMcpTool(tool: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/u.exec(tool);
  return match === null ? null : { server: match[1] ?? "", tool: match[2] ?? "" };
}

const BB_MCP_SANITIZED = BB_MCP_SERVER_NAME.replace(/[^A-Za-z0-9_]/gu, "_");

/** Tools Muse renders elsewhere (todos, questions) or that are bookkeeping. */
const SUPPRESSED_TOOLS = new Set([
  "write_todos",
  "request_user_input",
  "snooze_reminder",
  "work_list",
  "get_goal",
]);

/** Item kinds bb has its own row for, or that are Muse-internal noise. */
export function isSkippedItemKind(kind: string): boolean {
  return kind === "userMessage" || kind === "reminderChild";
}

function genericPresentation(item: MspItem, fallback: string): DeltaPresentation {
  const label = item.displayLabel;
  const base =
    label?.active || label?.done
      ? {
          label: {
            pending: label.active ?? label.neutral ?? fallback,
            completed: label.done ?? label.neutral ?? fallback,
          },
          icon: { glyph: "Toolbox" },
        }
      : toolPresentation(fallback);
  return SUPPRESSED_TOOLS.has(item.tool ?? "") ? { ...base, suppress: true } : base;
}

/**
 * The bb row for a Muse item at any revision, or null when the item has no
 * row of its own (messages and reasoning stream separately; user messages and
 * reminder children are skipped). `terminal` adds results and outputs.
 */
export function describeItem(item: MspItem, ctx: ItemContext, terminal: boolean): ItemRow | null {
  switch (item.kind) {
    case "agentMessage":
    case "reasoning":
    case "userMessage":
    case "reminderChild":
      return null;
    case "toolCall":
      return item.background === true
        ? describeBackgroundTask(item, ctx, terminal)
        : describeToolCall(item, ctx, terminal);
    case "userShell":
      return {
        shape: {
          type: "command",
          command: item.commandText ?? "",
          cwd: ctx.cwd,
          ...(terminal ? commandResult(item) : {}),
        },
      };
    case "compaction":
      return { shape: { type: "compaction" }, presentation: COMPACTION_PRESENTATION };
    case "subagent":
    case "workflow": {
      const label =
        item.objective ?? item.fallbackText ?? (item.kind === "workflow" ? "Workflow" : "Subagent");
      const summary = item.result?.text ?? item.result?.summary ?? undefined;
      return {
        shape: {
          type: "delegation",
          childRef: item.childSessionId ?? item.subagentId ?? item.itemId,
          label,
          // Muse subagents and workflows outlive the turn that started them.
          background: true,
          ...(terminal && summary ? { summary } : {}),
        },
        presentation: withTitle(
          {
            label:
              item.kind === "workflow"
                ? { pending: "Running workflow", completed: "Ran workflow" }
                : { pending: "Running subagent", completed: "Ran subagent" },
            icon: { glyph: item.kind === "workflow" ? "Workflow" : "Bot" },
          },
          presentationTitle(label),
        ),
      };
    }
    default: {
      // webSearch, hookRun, sideChat, monitorFeed and future kinds.
      const name = item.kind;
      const text = item.fallbackText ?? undefined;
      return {
        shape: {
          type: "tool",
          tool: name,
          ...(terminal && text ? { result: text } : {}),
          ...(terminal && item.failureReason ? { error: item.failureReason } : {}),
        },
        presentation: {
          ...withTitle(toolPresentation(name), text ? presentationTitle(text) : undefined),
          ...(name === "hookRun" || name === "monitorFeed" ? { suppress: true } : {}),
        },
      };
    }
  }
}

function commandResult(item: MspItem): { aggregatedOutput?: string; exitCode?: number; durationMs?: number } {
  const raw = item.visibleOutput ?? "";
  // Completed bash calls carry a JSON envelope; running ones carry raw output.
  const envelope = parseArgs(raw);
  const output = typeof envelope.output === "string" ? envelope.output : raw;
  const exitCode =
    typeof envelope.exit_code === "number"
      ? envelope.exit_code
      : typeof item.exitCode === "number"
        ? item.exitCode
        : undefined;
  return {
    aggregatedOutput: output,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
  };
}

type SettledStatus = Exclude<ThreadEventItemStatus, "pending">;

const TASK_STATUS = {
  pending: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "stopped",
} as const;

/**
 * A tool call Muse sent to the background (`background: true`, set by an
 * `item/updated`): a bb background task, which outlives its turn and settles
 * when Muse completes the item.
 */
function describeBackgroundTask(item: MspItem, ctx: ItemContext, terminal: boolean): ItemRow {
  const { shape } = describeToolCall(item, ctx, false);
  const status = terminal ? (itemStatus(item.status) ?? "completed") : "pending";
  const output = terminal ? commandResult(item).aggregatedOutput : undefined;
  return {
    shape: {
      type: "backgroundTask",
      familyId: item.itemId,
      taskType: item.tool === "bash" ? LOCAL_BASH_TASK_TYPE : (item.tool ?? "tool"),
      description: shape.type === "command" ? shape.command : (item.displayLabel?.neutral ?? item.tool ?? "Background task"),
      status,
      taskStatus: TASK_STATUS[status],
      skipTranscript: false,
      ...(output ? { summary: output.slice(-4_000) } : {}),
      ...(terminal && item.failureReason ? { error: item.failureReason } : {}),
    },
  };
}

/** A row settled by the bridge rather than by Muse (a stop, a crash): its status wins. */
export function withSettledStatus(shape: DeltaItemShape, status: SettledStatus): DeltaItemShape {
  return shape.type === "backgroundTask" ? { ...shape, status, taskStatus: TASK_STATUS[status] } : shape;
}

function describeToolCall(item: MspItem, ctx: ItemContext, terminal: boolean): ItemRow {
  const tool = item.tool ?? "tool";
  const args = parseArgs(item.args);
  const output = item.visibleOutput ?? undefined;
  const failure = item.failureReason ?? undefined;

  switch (tool) {
    case "bash": {
      const command = str(args.command) ?? str(args.cmd) ?? "";
      const cwd = str(args.cwd) ?? str(args.workdir);
      return {
        shape: {
          type: "command",
          command,
          cwd: cwd ? absolute(ctx.cwd, cwd) : ctx.cwd,
          ...(terminal ? commandResult(item) : {}),
        },
      };
    }
    case "read_file": {
      const path = str(args.path) ?? str(args.file_path);
      if (path === undefined) break;
      const absolutePath = absolute(ctx.cwd, path);
      return {
        shape: { type: "fileRead", path: absolutePath },
        presentation: fileReadPresentation(absolutePath),
      };
    }
    case "search": {
      const query = str(args.pattern) ?? str(args.query);
      if (query === undefined) break;
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : [];
      const path = str(paths[0]) ?? str(args.path);
      return {
        shape: {
          type: "search",
          mode: "content",
          query,
          ...(path ? { path: absolute(ctx.cwd, path) } : {}),
        },
        presentation: searchPresentation({ mode: "content", query }),
      };
    }
    case "edit_file":
    case "write_file":
    case "apply_patch":
      return {
        shape: {
          type: "fileChange",
          changes: terminal ? terminalFileChanges(item, args, ctx) : plannedFileChanges(tool, args, ctx),
        },
      };
    case "web_search": {
      const query = str(args.query) ?? str(args.q);
      if (query === undefined) break;
      return { shape: { type: "webSearch", queries: [query] }, presentation: webSearchPresentation(query) };
    }
    case "web_fetch": {
      const url = str(args.url);
      if (url === undefined) break;
      return {
        shape: { type: "webFetch", url, prompt: str(args.prompt) ?? null, pattern: null },
        presentation: webFetchPresentation(url),
      };
    }
    default:
      break;
  }

  const mcp = splitMcpTool(tool);
  const result =
    terminal && failure === undefined && output !== undefined ? { result: output } : {};
  const error = terminal && failure !== undefined ? { error: failure } : {};
  if (mcp !== null) {
    const bbTool = mcp.server === BB_MCP_SANITIZED ? ctx.bbTools.get(mcp.tool) : undefined;
    if (bbTool !== undefined) {
      return {
        shape: { type: "tool", tool: mcp.tool, server: "bb", args, ...result, ...error },
        presentation: bbTool.presentation ?? toolPresentation(mcp.tool),
      };
    }
    return {
      shape: { type: "tool", tool: mcp.tool, server: mcp.server, args, ...result, ...error },
      presentation: toolPresentation(mcp.tool),
    };
  }
  return {
    shape: { type: "tool", tool, args, ...result, ...error },
    presentation: genericPresentation(item, tool),
  };
}

function plannedFileChanges(tool: string, args: Args, ctx: ItemContext): DeltaFileChange[] {
  const path = str(args.path) ?? str(args.file_path);
  if (path === undefined) return [];
  const content = tool === "write_file" ? str(args.content) : undefined;
  return [
    {
      path: absolute(ctx.cwd, path),
      kind: "update",
      ...(content === undefined ? {} : { newText: content }),
    },
  ];
}

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Muse's `tool_patch` document: per-file hunks of `-`/`+`/` ` lines. */
export function fileChangesFromPatch(document: unknown, cwd: string): DeltaFileChange[] | null {
  if (typeof document !== "object" || document === null) return null;
  const files = (document as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  const changes: DeltaFileChange[] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue;
    const path = str((file as { path?: unknown }).path);
    if (path === undefined) continue;
    const hunks = ((file as { hunks?: unknown }).hunks ?? []) as PatchHunk[];
    if (!Array.isArray(hunks)) continue;
    const added = hunks.length > 0 && hunks.every((h) => h.oldLines === 0 && h.oldStart === 0);
    const deleted = hunks.length > 0 && hunks.every((h) => h.newLines === 0 && h.newStart === 0);
    const diff = hunks
      .map(
        (h) =>
          `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines ?? []).join("\n")}`,
      )
      .join("\n");
    changes.push({
      path: absolute(cwd, path),
      kind: added ? "add" : deleted ? "delete" : "update",
      ...(diff.length > 0 ? { diff: `${diff}\n` } : {}),
    });
  }
  return changes;
}

function readPatchDocument(path: string): unknown {
  try {
    if (statSync(path).size > MAX_PATCH_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function terminalFileChanges(item: MspItem, args: Args, ctx: ItemContext): DeltaFileChange[] {
  const patchPath = item.patchRef?.path;
  if (patchPath) {
    const changes = fileChangesFromPatch(readPatchDocument(patchPath), ctx.cwd);
    if (changes !== null && changes.length > 0) return changes;
  }
  // No patch document (a failed or rejected edit): the planned change, with
  // the unified diff Muse printed when it has one.
  const planned = plannedFileChanges(item.tool ?? "", args, ctx);
  const output = item.visibleOutput ?? "";
  const diffStart = output.indexOf("--- ");
  const first = planned[0];
  if (first !== undefined && diffStart >= 0 && planned.length === 1) {
    return [{ ...first, diff: output.slice(diffStart) }];
  }
  return planned;
}

/** Muse's open item status set, read as bb's terminal item status. */
export function itemStatus(status: string): SettledStatus | null {
  switch (status) {
    case "inProgress":
      return null;
    case "completed":
      return "completed";
    case "cancelled":
      return "interrupted";
    default:
      // failed, rejected, timedOut, handedOff and future failure states.
      return "failed";
  }
}

/** Per-call usage in bb's breakdown (Claude convention: input excludes cache). */
export function callUsage(event: MspTokenUsage): ThreadEventTokenUsageBreakdown {
  const usage = event.usage;
  const prompt = event.promptTokens ?? usage.inputTokens ?? 0;
  const read = usage.cacheReadTokens ?? usage.cachedTokens ?? undefined;
  const write = usage.cacheWriteTokens ?? undefined;
  const output = usage.outputTokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - (read ?? 0) - (write ?? 0)),
    cachedInputTokens: (read ?? 0) + (write ?? 0),
    ...(read === undefined ? {} : { cacheReadInputTokens: read }),
    ...(write === undefined ? {} : { cacheWriteInputTokens: write }),
    outputTokens: output,
    reasoningOutputTokens: usage.reasoningTokens ?? 0,
    totalTokens: prompt + output,
  };
}

// ---------------------------------------------------------------- approvals

const BB_DECISIONS: readonly PendingInteractionApprovalDecision[] = [
  "allow_once",
  "allow_for_session",
  "deny",
];

const SCOPE_RANK: Record<string, number> = { once: 0, session: 1, localPersistent: 2 };

function choiceDecision(choice: MspApprovalChoice): PendingInteractionApprovalDecision | null {
  switch (choice.decision) {
    case "approved":
      return choice.scope === "session" ? "allow_for_session" : "allow_once";
    case "approvedForSession":
      return "allow_for_session";
    case "approvedPolicyAmendment":
      // A persistent policy amendment is broader than bb's session grant.
      return choice.scope === "session" ? "allow_for_session" : null;
    case "denied":
    case "deniedPolicyAmendment":
    case "abort":
      return "deny";
    default:
      return null;
  }
}

/**
 * The Muse choice that carries out a bb decision: the narrowest scope wins,
 * and a plain denial beats `abort` (which also stops the turn).
 */
export function choiceFor(
  choices: readonly MspApprovalChoice[],
  decision: PendingInteractionApprovalDecision,
): MspApprovalChoice | null {
  const matching = choices.filter((choice) => choiceDecision(choice) === decision);
  matching.sort((left, right) => {
    if (decision === "deny") {
      return Number(left.decision === "abort") - Number(right.decision === "abort");
    }
    return (SCOPE_RANK[left.scope ?? "once"] ?? 3) - (SCOPE_RANK[right.scope ?? "once"] ?? 3);
  });
  return matching[0] ?? null;
}

export function availableDecisions(
  choices: readonly MspApprovalChoice[],
): PendingInteractionApprovalDecision[] {
  return BB_DECISIONS.filter((decision) => choiceFor(choices, decision) !== null);
}

function approvalDetail(approval: MspApproval): string {
  const subject = approval.subject;
  const parts = [
    subject?.command ? `\`${subject.command}\`` : null,
    subject?.path ? `\`${subject.path}\`` : null,
    subject?.host ? `host \`${subject.host}\`` : null,
    subject?.target ? `\`${subject.target}\`` : null,
    approval.reason ?? null,
  ].filter((part): part is string => part !== null && part.length > 0);
  return presentationDetail(parts.join(" · ") || "Muse asks before it continues.");
}

const SUBJECT_LABEL: Record<string, string> = {
  fileAccess: "Access a file",
  network: "Use the network",
  unixSocket: "Open a socket",
  process: "Control a process",
  tool: "Run a tool",
};

/** A Muse approval as bb's approval payload, or null when it offers no choice bb can make. */
export function approvalPayload(
  approval: MspApproval,
  cwd: string,
): Extract<PendingInteractionPayload, { kind: "approval" }> | null {
  const decisions = availableDecisions(approval.availableChoices);
  if (decisions.length === 0) return null;
  const subject = approval.subject;
  const itemId = approval.itemId ?? approval.approvalId;
  const rawArgs = parseArgs(approval.rawArgs);
  const reason = approval.reason ?? null;
  if (subject?.kind === "shell") {
    const command = subject.command ?? str(rawArgs.command) ?? approval.toolName ?? "shell command";
    return {
      kind: "approval",
      subject: { kind: "command", itemId, command, cwd, actions: [], sessionGrant: null },
      reason,
      availableDecisions: decisions,
    };
  }
  if (subject?.kind === "fileAccess" && subject.access !== "read") {
    return {
      kind: "approval",
      subject: { kind: "file_change", itemId, writeScope: subject.path ?? null, sessionGrant: null },
      reason,
      availableDecisions: decisions,
    };
  }
  const tool = approval.toolName ?? subject?.kind ?? "tool";
  const label =
    subject?.kind === "fileAccess"
      ? "Read a file"
      : (SUBJECT_LABEL[subject?.kind ?? "tool"] ?? "Run a tool");
  return {
    kind: "approval",
    subject: {
      kind: "tool_use",
      itemId,
      tool,
      presentation: {
        label: { pending: label, completed: label },
        icon: { glyph: subject?.kind === "network" ? "Globe" : "Lock" },
        title: presentationTitle(tool) ?? tool,
        detail: approvalDetail(approval),
      },
    },
    reason,
    availableDecisions: decisions,
  };
}

// ---------------------------------------------------------------- questions

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_FREE_TEXT = 500;

export function questionPayload(
  input: MspUserInput,
): Extract<PendingInteractionPayload, { kind: "user_question" }> | null {
  const questions = input.questions.slice(0, MAX_QUESTIONS).flatMap((question) => {
    const prompt = question.question.trim();
    if (prompt.length === 0) return [];
    const seen = new Set<string>();
    const options = (question.options ?? [])
      .filter((option) => {
        const label = option.label.trim();
        if (label.length === 0 || seen.has(label)) return false;
        seen.add(label);
        return true;
      })
      .slice(0, MAX_OPTIONS)
      .map((option) => ({
        value: option.label.trim(),
        label: option.label.trim(),
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      }));
    const header = question.header?.trim();
    return [
      {
        id: question.id,
        prompt,
        ...(header ? { shortLabel: header } : {}),
        multiSelect: question.selection?.mode === "multiple",
        ...(options.length > 0 ? { options } : {}),
        allowFreeText: true,
      },
    ];
  });
  if (questions.length === 0) return null;
  return { kind: "user_question", questions };
}

export function museAnswers(
  input: MspUserInput,
  answers: Record<string, { selected: string[]; freeText?: string | undefined }>,
): Array<Record<string, unknown>> {
  return input.questions.flatMap((question): Array<Record<string, unknown>> => {
    const answer = answers[question.id];
    if (answer === undefined) return [];
    const freeText = answer.freeText?.trim().slice(0, MAX_FREE_TEXT);
    const multiple = question.selection?.mode === "multiple";
    if (answer.selected.length === 0) {
      return freeText ? [{ questionId: question.id, freeText }] : [];
    }
    // bb's form does not know Muse's selection bounds.
    const max = question.selection?.maxSelections;
    const selected = typeof max === "number" && max > 0 ? answer.selected.slice(0, max) : answer.selected;
    return [
      {
        questionId: question.id,
        ...(multiple
          ? { selectedLabels: selected }
          : { selectedLabel: selected[0] }),
        ...(freeText ? { note: freeText } : {}),
      },
    ];
  });
}

// ------------------------------------------------------------------- models

/** bb reasoning levels Muse also speaks (`minimal` has no bb counterpart). */
const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
type MuseReasoning = (typeof REASONING_LEVELS)[number];

function isReasoning(value: unknown): value is MuseReasoning {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

const REASONING_COPY: Record<MuseReasoning, string> = {
  none: "No extended reasoning",
  low: "Quick answers",
  medium: "Balanced",
  high: "Thorough (Muse's default)",
  xhigh: "Deep analysis",
  max: "Maximum effort",
  ultra: "Beyond maximum",
};

/** `muse-wonder-1.0` → `Muse Wonder 1.0`. */
export function modelDisplayName(modelId: string, label?: string | null): string {
  const source = label && label !== modelId ? label : modelId;
  return source
    .split("-")
    .map((part) => (/^\d/u.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

export function availableModels(list: MspModelList): AvailableModel[] {
  const seen = new Set<string>();
  const models: AvailableModel[] = [];
  for (const model of list.models) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    const variants = Array.isArray(model.variants) ? model.variants.filter(isReasoning) : [];
    const levels: MuseReasoning[] = variants.length > 0 ? variants : ["low", "medium", "high", "xhigh", "max"];
    const notes = new Map(
      (model.reasoningEffortVariants ?? []).map((variant) => [variant.tier, variant.description]),
    );
    const fallbackDefault = levels.includes("high") ? "high" : (levels[levels.length - 1] ?? "high");
    const defaultReasoningEffort = isReasoning(model.defaultReasoningEffort) && levels.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : fallbackDefault;
    const window = typeof model.contextLimit === "number" ? model.contextLimit : null;
    models.push({
      id: model.modelId,
      model: model.modelId,
      displayName: modelDisplayName(model.modelId, model.displayLabel),
      description:
        model.description ??
        (window === null ? "Muse Code model" : `${Math.round(window / 1000)}k-token context`),
      supportedReasoningEfforts: levels.map((level) => ({
        reasoningEffort: level,
        description: notes.get(level) ?? REASONING_COPY[level],
      })),
      defaultReasoningEffort,
      isDefault: model.isDefault === true,
    });
  }
  if (models.length > 0 && !models.some((model) => model.isDefault)) {
    const first = models[0];
    if (first !== undefined) models[0] = { ...first, isDefault: true };
  }
  return models;
}

/** bb's reasoning level as Muse's effort tier (`ultracode` is codex-only). */
export function museReasoningEffort(level: string | undefined): MuseReasoning | undefined {
  if (level === "ultracode") return "max";
  return isReasoning(level) ? level : undefined;
}

// ------------------------------------------------------------------- usage

function windowLabel(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || minutes <= 0) return "Session window";
  return minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoOrNull(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function usageWindows(usage: MspAccountUsage): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  if (usage.window) {
    windows.push({
      label: windowLabel(usage.window.windowDurationMins),
      usedPercent: clampPercent(usage.window.usedPercent),
      resetsAt: isoOrNull(usage.window.resetsAtMs),
    });
  }
  if (usage.weekly) {
    windows.push({
      label: "Weekly",
      usedPercent: clampPercent(usage.weekly.usedPercent),
      resetsAt: isoOrNull(usage.weekly.resetsAtMs),
    });
  }
  return windows;
}

const WARNING_PERCENT = 80;

function windowStatus(percent: number): "allowed" | "warning" | "blocked" {
  return percent >= 100 ? "blocked" : percent >= WARNING_PERCENT ? "warning" : "allowed";
}

export function rateLimitState(usage: MspAccountUsage): ProviderRateLimitState | null {
  const windows = [
    usage.window ? { key: "window", label: windowLabel(usage.window.windowDurationMins), value: usage.window } : null,
    usage.weekly ? { key: "weekly", label: "Weekly", value: usage.weekly } : null,
  ].filter((entry) => entry !== null);
  if (windows.length === 0) return null;
  const statuses = windows.map((entry) => windowStatus(entry.value.usedPercent));
  const status = statuses.includes("blocked") ? "blocked" : statuses.includes("warning") ? "warning" : "allowed";
  const blocked = windows.find((entry) => entry.value.usedPercent >= 100);
  return {
    providerId: MUSE_PROVIDER_ID,
    status,
    kind: "subscription-window",
    windows: windows.map((entry) => ({
      providerKey: entry.key,
      label: entry.label,
      status: windowStatus(entry.value.usedPercent),
      resetsAtMs: typeof entry.value.resetsAtMs === "number" ? entry.value.resetsAtMs : null,
    })),
    reachedReason: blocked ? `Muse ${blocked.label.toLowerCase()} limit reached` : null,
    overageStatus: null,
    overageReason: null,
  };
}

type ProviderErrorInfo = NonNullable<Extract<ThreadDelta, { kind: "provider.error" }>["errorInfo"]>;

/**
 * A provider error's classification as bb stores it (W545). bb keeps `errorInfo` with the
 * error, where `turn.failed` listeners (provider-retry, Adventures' reviewer fallback) read it;
 * a bare `category` on the delta is dropped.
 */
export const errorInfo = (category: ProviderErrorInfo["category"], httpStatusCode: number | null = null): ProviderErrorInfo => ({
  category,
  httpStatusCode,
  providerCode: null,
});

/** A failed Muse turn in bb's terms: the message, an error classification, a recovery hint. */
export function describeTurnFailure(
  error: MspTurnError | null,
  reason: string | null,
): {
  message: string;
  errorInfo: ProviderErrorInfo | null;
  recovery: ProviderRecoveryKind | null;
} {
  const raw = error?.message ?? reason ?? "Muse reported a failed turn";
  const usageLimited =
    error?.quota != null || (/\b429\b/u.test(raw) && /quota|usage limit/iu.test(raw));
  if (usageLimited) {
    const resetsAt = error?.quota?.resetsAtMs;
    const when = typeof resetsAt === "number" ? ` It resets at ${new Date(resetsAt).toISOString()}.` : "";
    return { message: `Muse usage limit reached: ${raw}.${when}`, errorInfo: errorInfo("rate-limit", 429), recovery: "rateLimited" };
  }
  if (error?.kind === "authRequired") {
    return {
      message: `Muse needs you to sign in again: ${raw}. Run \`muse login\` on this machine.`,
      errorInfo: null,
      recovery: "authRequired",
    };
  }
  if (error?.kind === "configError" || error?.kind === "mcpLinkError") {
    return { message: `Muse ${error.kind}: ${raw}`, errorInfo: errorInfo("bad-request"), recovery: null };
  }
  return { message: error?.kind ? `Muse ${error.kind}: ${raw}` : raw, errorInfo: null, recovery: null };
}
