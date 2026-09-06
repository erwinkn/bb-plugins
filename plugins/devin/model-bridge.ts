import { z } from "zod";
import { createBridgeIo, experimental_defineProviderBridge, modelListParamsSchema, reasoningLevelSchema } from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderBridgeEntry } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { FAMILY_PREFIX } from "./models";
import { loadDevinModels } from "./model-probe";

const selectionSchema = z.object({ model: z.string(), reasoningLevel: reasoningLevelSchema.optional(), serviceTier: z.enum(["default", "fast"]).optional(), providerOptions: z.object({ acpLaunchSpec: experimental_acpLaunchSpecSchema }) });
const selectionMethods = new Set(["thread/start", "thread/resume", "thread/fork", "turn/start"]);
export function withDevinModels(acp: ProviderBridgeEntry, load = loadDevinModels, write?: (line: string) => void): ProviderBridgeEntry {
  const io = createBridgeIo({ write });
  const abort = new AbortController();
  // Reuse a single in-flight lookup, but never retain a failed catalog.
  const pending = new Set<{ threadId: unknown; cancelled: boolean }>();
  const cache = new Map<string, { until: number; value: ReturnType<typeof load> }>();
  function catalog(command: string, refresh = false) {
    const cached = cache.get(command);
    if (!refresh && cached && cached.until > Date.now()) return cached.value;
    const value = load(command, abort.signal);
    const entry = { until: Date.now() + 60_000, value };
    cache.set(command, entry);
    void value.catch(() => { if (cache.get(command) === entry) cache.delete(command); });
    return value;
  }
  function close() { abort.abort(); cache.clear(); }
  return experimental_defineProviderBridge({
    start: acp.start,
    onClose() { close(); return acp.onClose?.(); },
    onSigterm() { close(); return acp.onSigterm?.(); },
    onSigint() { close(); return acp.onSigint?.(); },
    handleLine(line) {
      let message;
      try { message = JSON.parse(line); } catch { acp.handleLine(line); return; }
      if (message?.jsonrpc !== "2.0" || (typeof message.id !== "string" && typeof message.id !== "number")) { acp.handleLine(line); return; }
      if (message.method === "thread/stop" || message.method === "thread/discard") {
        for (const request of pending) if (request.threadId === message.params?.threadId) request.cancelled = true;
      }
      const isList = message.method === "model/list";
      const isSelection = selectionMethods.has(message.method) && typeof message.params?.options?.model === "string" && message.params.options.model.startsWith(FAMILY_PREFIX);
      if (!isList && !isSelection) { acp.handleLine(line); return; }
      const request = { threadId: message.params?.threadId, cancelled: false };
      if (isSelection) pending.add(request);
      void (async () => {
        if (isList) {
          const params = modelListParamsSchema.parse(message.params);
          const launch = experimental_acpLaunchSpecSchema.parse((params.providerOptions as Record<string, unknown> | undefined)?.acpLaunchSpec);
          const { models, selectedOnlyModels } = await catalog(launch.command, true);
          if (!abort.signal.aborted) io.sendResult(message.id, { models, selectedOnlyModels });
        } else {
          const options = selectionSchema.parse(message.params.options);
          const models = await catalog(options.providerOptions.acpLaunchSpec.command);
          if (request.cancelled) throw new Error("Devin model selection was cancelled.");
          const model = models.resolve(options.model, options.reasoningLevel, options.serviceTier);
          const next = { ...message.params.options, model };
          delete next.reasoningLevel;
          delete next.serviceTier;
          if (!abort.signal.aborted) acp.handleLine(JSON.stringify({ ...message, params: { ...message.params, options: next } }));
        }
      })().catch(error => {
        if (!abort.signal.aborted) io.sendError(message.id, -32602, error instanceof z.ZodError ? "Invalid Devin model parameters." : error.message);
      }).finally(() => pending.delete(request));
    },
  });
}
