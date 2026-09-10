import { z } from "zod";

/** Client-reported context only. It cannot identify or authorize a BB host. */
export const callDeviceSchema = z.object({
  platform: z.string().max(64),
  mobile: z.boolean(),
  browser: z.string().max(128),
  runtime: z.string().max(64),
}).strict();
