/**
 * Wire shapes shared by the host sampler, the server, and the frontend. The
 * host contract carries one sample per call; the RPC contract adds the host
 * list, the server-side history, and the user's settings.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const bytes = z.number().nonnegative();
const rate = z.number().nonnegative().nullable();

const processSchema = z.object({
  pid: z.number().int(),
  name: z.string(),
  /** Full command line, or the name when the kernel hides it. */
  command: z.string(),
  /** Share of one core, like top: 250 means two and a half cores. Null without a baseline. */
  cpuPercent: z.number().nonnegative().nullable(),
  memoryBytes: bytes,
});

const diskSchema = z.object({
  mountPoint: z.string(),
  device: z.string(),
  fsType: z.string(),
  totalBytes: bytes,
  usedBytes: bytes,
  /** Space an unprivileged user can still write, as `df` reports it. */
  availableBytes: bytes,
});

export const sampleSchema = z.object({
  /** The host's clock on the wire; the server replaces it with its own receive time. */
  takenAt: z.number(),
  platform: z.string(),
  hostname: z.string(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  cpu: z.object({
    count: z.number().int().positive(),
    /** Whole-machine busy share, 0–100. Null on the first reading. */
    percent: z.number().min(0).max(100).nullable(),
    cores: z.array(z.number().min(0).max(100)).nullable(),
  }),
  memory: z.object({
    totalBytes: bytes,
    availableBytes: bytes,
    swapTotalBytes: bytes,
    swapUsedBytes: bytes,
  }),
  load: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  disks: z.array(diskSchema),
  io: z.object({
    diskReadBps: rate,
    diskWriteBps: rate,
    netReceiveBps: rate,
    netSendBps: rate,
  }),
  processes: z
    .object({ byCpu: z.array(processSchema), byMemory: z.array(processSchema) })
    .nullable(),
});

export type Sample = z.infer<typeof sampleSchema>;
export type Disk = z.infer<typeof diskSchema>;
export type ProcessSummary = z.infer<typeof processSchema>;

export const hostContract = defineRpcContract({
  sample: {
    input: z.object({ processes: z.boolean() }).strict(),
    output: sampleSchema,
  },
});

const historyPointSchema = z.object({
  t: z.number(),
  cpu: z.number().nullable(),
  memory: z.number(),
  diskRead: rate,
  diskWrite: rate,
  netReceive: rate,
  netSend: rate,
});

export type HistoryPoint = z.infer<typeof historyPointSchema>;

const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  /** The machine the BB server itself runs on. */
  primary: z.boolean(),
});

export type Machine = z.infer<typeof machineSchema>;

export const settingsSchema = z.object({
  refreshMs: z.number().int().positive(),
  warningPercent: z.number(),
  criticalPercent: z.number(),
});

export type LoadSettings = z.infer<typeof settingsSchema>;

export const loadResultSchema = z.object({
  machines: z.array(machineSchema),
  /** The machine this answer is about: the requested one, else the primary. */
  machineId: z.string().nullable(),
  sample: sampleSchema.nullable(),
  /** Points newer than the request's `since`, oldest first. */
  history: z.array(historyPointSchema),
  error: z.string().nullable(),
  settings: settingsSchema,
});

export type LoadResult = z.infer<typeof loadResultSchema>;

export const loadRpcContract = defineRpcContract({
  load: {
    input: z
      .object({
        machineId: z.string().min(1).nullable(),
        since: z.number().nonnegative(),
        processes: z.boolean(),
      })
      .strict(),
    output: loadResultSchema,
  },
});
