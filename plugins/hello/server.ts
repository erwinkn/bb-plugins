import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({
      message: z.literal("Hello from the BB server!"),
      serverTime: z.iso.datetime(),
    }),
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    ping: () => ({
      message: "Hello from the BB server!" as const,
      serverTime: new Date().toISOString(),
    }),
  });
}
