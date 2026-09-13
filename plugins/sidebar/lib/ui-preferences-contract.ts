import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";
import {
  syncedPreferenceEntrySchema,
  syncedPreferenceWriteSchema,
  syncedPreferencesSchema,
} from "./ui-preferences-schema";

// Server-side only. Frontend code imports `uiPreferencesContract` as a type.
export const uiPreferencesContract = defineRpcContract({
  // The five BB sidebar preferences this plugin mirrors, with their revisions.
  "uiPreferences.read": { input: z.null(), output: syncedPreferencesSchema },
  // Compare-and-swap on the key's revision. A stale revision rejects; the
  // caller reloads and retries against the fresh entry.
  "uiPreferences.write": {
    input: syncedPreferenceWriteSchema,
    output: syncedPreferenceEntrySchema,
  },
});
