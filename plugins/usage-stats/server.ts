// Usage stats: the server reads the Account Pooler's ledger sums over RPC, names threads,
// projects and Initiatives from BB, and hands the page one model per request.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { bbDirectory } from "./src/directory";
import { pageInputSchema, pageSchema } from "./src/model";
import { buildPage } from "./src/page";
import { poolerClient } from "./src/pooler";

export const rpcContract = defineRpcContract({
  page: { input: pageInputSchema, output: pageSchema },
});

export default function plugin(bb: BbPluginApi): void {
  const deps = { pooler: poolerClient(bb.sdk), directory: bbDirectory(bb), now: Date.now };
  bb.rpc.register(rpcContract, {
    page: (input) => buildPage(input, deps),
  });
}
