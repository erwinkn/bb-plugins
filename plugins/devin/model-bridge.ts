import { z } from "zod";
import { createBridgeIo, experimental_defineProviderBridge, modelListParamsSchema, reasoningLevelSchema } from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderBridgeEntry, ReasoningLevel, ServiceTier } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { buildDevinModels, FAMILY_PREFIX } from "./models";
import { fetchDevinCatalog } from "./model-probe";
import { devinIdentity, fileCatalogStore, FRESH_MS, MAX_AGE_MS, memoryCatalogStore, UNKNOWN_IDENTITY_TTL_MS } from "./model-cache";
import type { CatalogStore } from "./model-cache";

const selectionSchema = z.object({ model: z.string(), reasoningLevel: reasoningLevelSchema.optional(), serviceTier: z.enum(["default", "fast"]).optional(), providerOptions: z.object({ acpLaunchSpec: experimental_acpLaunchSpecSchema }) });
const selectionMethods = new Set(["thread/start", "thread/resume", "thread/fork", "turn/start"]);
type Catalog = ReturnType<typeof buildDevinModels>;
export interface DevinModelDeps { identity?: (command: string) => Promise<string | undefined>; now?: () => number }

export function withDevinModels(acp: ProviderBridgeEntry, fetch = fetchDevinCatalog, write?: (line: string) => void, deps: DevinModelDeps = {}): ProviderBridgeEntry {
  const io = createBridgeIo({ write });
  const abort = new AbortController();
  const identity = deps.identity ?? devinIdentity, now = deps.now ?? Date.now;
  // The persistent store arrives with start(); until then this process only.
  let store: CatalogStore = memoryCatalogStore();
  // Without a local identity nothing is persisted; this process still keeps
  // the last catalog briefly so one thread does not rerun the CLI per turn.
  const local = memoryCatalogStore();
  const pending = new Set<{ threadId: unknown; cancelled: boolean }>();
  // Reuse a single in-flight lookup per command and identity, but never
  // retain a failed one. A different identity must not join an older lookup.
  const inflight = new Map<string, Promise<Catalog>>();
  function live(command: string, id: string | undefined): Promise<Catalog> {
    const key = `${command}\0${id ?? ""}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const lookup = (async () => {
      const raw = await fetch(command, abort.signal);
      const catalog = buildDevinModels(raw);
      // The identity was read before the lookup: a sign-in change during the
      // lookup makes the entry unusable rather than trusted.
      if (!abort.signal.aborted) {
        await (id === undefined ? local : store).write({ version: 1, identity: id ?? "", fetchedAt: now(), catalog: raw })
          .catch(error => process.stderr.write(`Devin model catalog cache was not written: ${error instanceof Error ? error.message : String(error)}\n`));
      }
      return catalog;
    })().finally(() => inflight.delete(key));
    inflight.set(key, lookup);
    return lookup;
  }
  async function cached(id: string | undefined): Promise<{ catalog: Catalog; stale: boolean } | undefined> {
    const entry = await (id === undefined ? local : store).read();
    if (!entry || entry.identity !== (id ?? "")) return undefined;
    const age = now() - entry.fetchedAt;
    if (age < 0 || age >= (id === undefined ? UNKNOWN_IDENTITY_TTL_MS : MAX_AGE_MS)) return undefined;
    try { return { catalog: buildDevinModels(entry.catalog), stale: id !== undefined && age >= FRESH_MS }; } catch { return undefined; }
  }
  // Cached data resolves only an exact match. Anything else blocks for a live
  // lookup, which decides with the current catalog and never substitutes.
  async function resolve(command: string, model: string, reasoningLevel?: ReasoningLevel, serviceTier?: ServiceTier): Promise<string> {
    const id = await identity(command);
    const hit = await cached(id);
    if (hit) {
      try {
        const resolved = hit.catalog.resolve(model, reasoningLevel, serviceTier);
        if (hit.stale) void live(command, id).catch(() => {});
        return resolved;
      } catch { /* fall through to a live lookup */ }
    }
    return (await live(command, id)).resolve(model, reasoningLevel, serviceTier);
  }
  function close() { abort.abort(); inflight.clear(); }
  return experimental_defineProviderBridge({
    start(context) { store = fileCatalogStore(context.dataDir); return acp.start?.(context); },
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
          // Reloading the list always refreshes the shared catalog.
          const { models, selectedOnlyModels } = await live(launch.command, await identity(launch.command));
          if (!abort.signal.aborted) io.sendResult(message.id, { models, selectedOnlyModels });
        } else {
          const options = selectionSchema.parse(message.params.options);
          const model = await resolve(options.providerOptions.acpLaunchSpec.command, options.model, options.reasoningLevel, options.serviceTier);
          if (request.cancelled) throw new Error("Devin model selection was cancelled.");
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
