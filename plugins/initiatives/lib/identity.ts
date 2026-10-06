import type { Sdk } from "./bb";

/**
 * This plugin was installed as `projects` until the rename to `initiatives`.
 * BB cannot re-stamp a thread's `originPluginId`, so every thread the plugin
 * created before the rename keeps `projects` forever, and its metadata stays
 * under the `projects` namespace until the one-time import copies it.
 */
export const PLUGIN_ID = "initiatives";
export const LEGACY_PLUGIN_ID = "projects";

/** True when a thread's origin is this plugin, under its current or former ID. */
export const isOwnOrigin = (ownId: string, origin: string | null | undefined) =>
  origin === ownId || origin === LEGACY_PLUGIN_ID;

/** The origin IDs a receipt scan lists: this plugin's own first, then the former one. */
export const ownOrigins = (ownId: string) =>
  ownId === LEGACY_PLUGIN_ID ? [ownId] : [ownId, LEGACY_PLUGIN_ID];

/**
 * A thread's metadata under this plugin's namespace, falling back to the
 * former namespace while a thread has not been migrated yet. An empty own
 * namespace is "not migrated", never "cleared": the plugin never empties it.
 */
export async function ownMetadata(sdk: Sdk, ownId: string, threadId: string) {
  const own = await sdk.threads.getPluginMetadata({ threadId, pluginId: ownId });
  if (Object.keys(own).length || ownId === LEGACY_PLUGIN_ID) return own;
  return sdk.threads.getPluginMetadata({ threadId, pluginId: LEGACY_PLUGIN_ID });
}
