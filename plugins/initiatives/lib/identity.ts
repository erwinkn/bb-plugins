/**
 * This plugin was installed as `projects` until the rename to `initiatives`.
 * BB cannot re-stamp a thread's `originPluginId`, so every thread the plugin
 * created before the rename keeps `projects` forever. Their metadata was
 * copied to this plugin's namespace by the one-time import.
 */
export const PLUGIN_ID = "initiatives";
const LEGACY_PLUGIN_ID = "projects";

/** True when a thread's origin is this plugin, under its current or former ID. */
export const isOwnOrigin = (ownId: string, origin: string | null | undefined) =>
  origin === ownId || origin === LEGACY_PLUGIN_ID;
