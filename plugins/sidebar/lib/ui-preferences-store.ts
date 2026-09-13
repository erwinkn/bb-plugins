import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { uiPreferencesContract } from "./ui-preferences-contract";
import {
  SYNCED_KEYS,
  UI_PREFERENCES_CHANNEL,
  syncedPreferencesSchema,
  type SyncedPreferenceEntry,
  type SyncedPreferences,
} from "./ui-preferences-schema";

// BB's synced UI preferences are only reachable from the backend SDK, and the
// core `ui-preferences-changed` realtime notification does not reach plugin
// frontends. These RPCs expose the represented keys; the frontend re-reads on
// focus and reconnect for changes made outside the plugin.
export function registerUiPreferences(bb: BbPluginApi) {
  bb.rpc.register(uiPreferencesContract, {
    "uiPreferences.read": async (): Promise<SyncedPreferences> => {
      const { preferences } = await bb.sdk.system.uiPreferences.list();
      const picked = Object.fromEntries(
        SYNCED_KEYS.map((key) => [key, preferences[key]]),
      );
      return syncedPreferencesSchema.parse(picked);
    },
    "uiPreferences.write": async (input): Promise<SyncedPreferenceEntry> => {
      const result = await bb.sdk.system.uiPreferences.set(input);
      const entry = {
        key: result.key,
        revision: result.revision,
        value: result.value,
      } as SyncedPreferenceEntry;
      // Other clients of this plugin follow immediately; BB's own clients
      // already receive the core notification.
      bb.realtime.publish(UI_PREFERENCES_CHANNEL, entry);
      return entry;
    },
  });
}
