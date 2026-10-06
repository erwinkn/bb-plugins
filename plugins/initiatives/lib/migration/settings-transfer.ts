/** Settings in the shape `bb plugin config <id> --json` prints. */
export interface SavedSettings {
  schema: Record<string, { default?: unknown }>;
  values: Record<string, unknown>;
}

export type SettingsStep = { op: "set"; key: string; value: string } | { op: "unset"; key: string };

/**
 * The `bb plugin config` steps that give a plugin the saved settings: a value
 * equal to its default is unset (so later default changes still apply),
 * anything else is set; fields already equal need nothing.
 */
export function settingsSteps(saved: SavedSettings, current: Record<string, unknown>): SettingsStep[] {
  return Object.entries(saved.values)
    .filter(([key, value]) => current[key] !== value)
    .map(([key, value]): SettingsStep =>
      value === saved.schema[key]?.default ? { op: "unset", key } : { op: "set", key, value: String(value) },
    );
}

/** Saved fields the plugin does not hold after applying them. */
export const settingsMismatches = (saved: SavedSettings, current: Record<string, unknown>) =>
  Object.keys(saved.values).filter((key) => current[key] !== saved.values[key]);
