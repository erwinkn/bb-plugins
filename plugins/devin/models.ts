import { z } from "zod";
import type { AvailableModel, ReasoningLevel, ServiceTier } from "@get-bb/plugin-sdk/provider-bridge";

export const FAMILY_PREFIX = "devin-family:";
const variantSchema = z.object({ model_uid: z.string().min(1), label: z.string().min(1), max_context_tokens: z.number().int().positive().optional() });
const catalogSchema = z.object({ families: z.array(z.object({
  family_uid: z.string().min(1), family_label: z.string().min(1), variants: z.array(variantSchema).min(1),
})).min(1) });
type Variant = z.infer<typeof variantSchema>;
const efforts: Record<string, ReasoningLevel> = {
  "No Thinking": "none", None: "none", Low: "low", Medium: "medium", High: "high",
  XHigh: "xhigh", "X-High": "xhigh", Max: "max", Thinking: "medium",
  "Low Thinking": "low", "Medium Thinking": "medium", "High Thinking": "high",
  "XHigh Thinking": "xhigh", "Max Thinking": "max",
};
const ladder: ReasoningLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];
interface Choice { variant: Variant; effort?: ReasoningLevel; fast: boolean }
interface Group { name: string; choices: Choice[] }
function rawModel(v: Variant): AvailableModel {
  return { id: v.model_uid, model: v.model_uid, displayName: v.label, description: "Native Devin variant.",
    isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] };
}

export function buildDevinModels(input: unknown) {
  const { families } = catalogSchema.parse(input);
  const groups = new Map<string, Group>();
  const raw = new Map<string, AvailableModel>();
  const labels = new Map(families.map(f => [f.family_label, f]));
  for (const family of families) {
    // Some CLI families split Fast into its own family. Join only an exact
    // named peer; Lightning and context sizes are distinct model choices.
    const base = family.family_label.endsWith(" Fast") ? labels.get(family.family_label.slice(0, -5)) ?? family : family;
    for (const variant of family.variants) {
      if (raw.has(variant.model_uid)) throw new Error("Duplicate Devin model ID.");
      raw.set(variant.model_uid, rawModel(variant));
      if (!variant.label.startsWith(base.family_label)) continue;
      let tail = variant.label.slice(base.family_label.length).trim();
      const contextLabel = tail.endsWith("1M") ? " 1M" : "";
      if (contextLabel) tail = tail.slice(0, -2).trim();
      const fast = tail === "Fast" || tail.endsWith(" Fast");
      if (fast) tail = tail.slice(0, -4).trim();
      // Unknown values (for example Minimal) stay as native rows, never
      // silently equated with a different effort.
      if (tail !== "" && efforts[tail] === undefined) continue;
      const key = FAMILY_PREFIX + encodeURIComponent(JSON.stringify([base.family_uid, variant.max_context_tokens, contextLabel]));
      const group = groups.get(key) ?? { name: base.family_label + contextLabel, choices: [] };
      group.choices.push({ variant, fast, effort: efforts[tail] });
      groups.set(key, group);
    }
  }
  const models: AvailableModel[] = [];
  const routes = new Map<string, { choices: Choice[]; defaultEffort: ReasoningLevel }>();
  const grouped = new Set<string>();
  for (const [id, group] of groups) {
    if (group.choices.length < 2) continue;
    const binaryThinking = group.choices.some(c => c.variant.label.replace(/ 1M$/, "").endsWith(" Thinking"))
      && group.choices.some(c => c.effort === undefined);
    const choices = group.choices.map(c => ({ ...c, effort: c.effort ?? (binaryThinking ? "none" : undefined) }));
    // A missing effort beside explicit levels is ambiguous; keep all rows.
    if (choices.some(c => c.effort === undefined) && choices.some(c => c.effort !== undefined)) continue;
    const cells = choices.map(c => `${c.effort}:${c.fast}`);
    if (new Set(cells).size !== cells.length) continue;
    const normal = choices.filter(c => !c.fast);
    if (!normal.length) continue;
    const defaultChoice = normal.find(c => c.effort === "medium") ?? normal[0];
    const defaultEffort = defaultChoice.effort ?? "medium";
    const levels = ladder.filter(level => choices.some(c => c.effort === level));
    models.push({ id, model: id, displayName: group.name,
      description: choices.some(c => c.fast) ? "Fast mode is available for supported effort levels." : "Fast mode is not available.",
      defaultReasoningEffort: defaultEffort, isDefault: false,
      supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort, description: `Devin ${reasoningEffort} effort.` })) });
    routes.set(id, { choices, defaultEffort });
    for (const c of choices) grouped.add(c.variant.model_uid);
  }
  models.push(...[...raw.values()].filter(m => !grouped.has(m.id)));
  models.unshift({ id: "default", model: "default", displayName: "Devin default", description: "Use the default model configured in Devin CLI.",
    defaultReasoningEffort: "medium", supportedReasoningEfforts: [], isDefault: true });
  return {
    models,
    // Existing threads keep their exact variant; they are not new picker rows.
    selectedOnlyModels: [...raw.values()].filter(m => grouped.has(m.id)),
    resolve(model: string, reasoningLevel?: ReasoningLevel, serviceTier?: ServiceTier) {
      if (!model.startsWith(FAMILY_PREFIX)) return model;
      const route = routes.get(model);
      if (!route) throw new Error("This Devin model group is no longer available. Reload the model list.");
      const effort = reasoningLevel ?? route.defaultEffort;
      const choice = route.choices.find(c => (c.effort === undefined || c.effort === effort) && c.fast === (serviceTier === "fast"));
      if (!choice) throw new Error("Devin does not offer this effort and Fast combination. Select another effort or turn Fast off.");
      return choice.variant.model_uid;
    },
  };
}
