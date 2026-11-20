import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PROVIDER_ID = "acp-antigravity";

export const signInFlowSchema = z.object({
  id: z.string(),
  phase: z.enum(["starting", "waiting", "verifying", "succeeded", "failed"]),
  authorizationUrl: z.string().nullable(),
  message: z.string().nullable(),
  active: z.boolean(),
});

export type SignInFlow = z.infer<typeof signInFlowSchema>;

export const statusSchema = z.object({
  installed: z.boolean(),
  signedIn: z.boolean(),
  email: z.string().nullable(),
  flow: signInFlowSchema.nullable(),
});

export type Status = z.infer<typeof statusSchema>;

export const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});

export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    accountEmail: z.string().nullable(),
    windows: z.array(usageWindowSchema),
    fetchedAt: z.string(),
  }),
  z.object({ status: z.literal("not_installed") }),
  z.object({ status: z.literal("unauthenticated") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

export type UsageState = z.infer<typeof usageSchema>;

export const appContract = defineRpcContract({
  status: {
    input: z.object({}).strict(),
    output: statusSchema,
  },
  usage: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: usageSchema,
  },
  signInStart: {
    input: z.object({}).strict(),
    output: statusSchema,
  },
  signInSubmit: {
    input: z.object({ flowId: z.string().min(1), response: z.string() }).strict(),
    output: statusSchema,
  },
  signInCancel: {
    input: z.object({ flowId: z.string().min(1) }).strict(),
    output: statusSchema,
  },
  signOut: {
    input: z.object({}).strict(),
    output: statusSchema,
  },
});
