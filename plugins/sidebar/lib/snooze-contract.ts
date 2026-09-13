import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod/mini";
import { snoozePresetsDocSchema } from "./snooze-presets";
import { snoozeDocSchema } from "./snooze-schema";

const threadId = z.string().check(z.minLength(1));

// Server-side only. Frontend code imports `snoozeContract` as a type.
export const snoozeContract = defineRpcContract({
  getSnoozes: { input: z.null(), output: snoozeDocSchema },
  // Every mutation returns the stored document so the caller can apply it
  // without waiting for the realtime signal.
  snooze: {
    input: z.object({
      threadId,
      /** Wake time, epoch milliseconds; must be in the future. */
      until: z.number().check(z.int(), z.positive()),
    }),
    output: snoozeDocSchema,
  },
  unsnooze: {
    input: z.object({ threadId }),
    output: snoozeDocSchema,
  },
  /** Clears the woke flag once the thread has been opened. */
  acknowledge: {
    input: z.object({ threadId }),
    output: snoozeDocSchema,
  },
  // The preset list lives in the plugin's settings section; the popover,
  // the row menu, and the CLI all read the same document.
  getSnoozePresets: { input: z.null(), output: snoozePresetsDocSchema },
  saveSnoozePresets: {
    // Validated by `normalizePresets` for readable messages; the schema
    // here only shapes the transport.
    input: z.object({ presets: z.array(z.unknown()) }),
    output: snoozePresetsDocSchema,
  },
});
