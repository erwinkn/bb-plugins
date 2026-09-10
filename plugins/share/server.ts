import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { REALTIME_CHANNEL, rpcContract, expiryDaysSchema } from "./lib/model";
import { ShareStore, MIGRATIONS } from "./server/store";
import { ShareService, baseUrlSchema, configuration } from "./server/service";
import type { AccessVerifier } from "./server/access-jwt";
import { registerCli } from "./server/cli";

export default async function plugin(bb: BbPluginApi, options: { verifyAccess?: AccessVerifier; now?: () => number } = {}) {
  const settings = bb.settings.define({
    publicBaseUrl: { type: "string", default: "", label: "Public base URL", description: "The http(s) origin serving share links, such as https://bb.erwinkn.com, with no path.", experimental_schema: baseUrlSchema },
    publicLinksEnabled: { type: "boolean", default: true, label: "Allow public links", description: "Allow creation and viewing of public links; disabling this hides all existing public links immediately." },
    defaultExpiryDays: { type: "number", default: 0, label: "Default expiry in days (0 = never)", description: "The lifetime of new links in days unless overridden, where zero means never expire.", experimental_schema: expiryDaysSchema },
    accessTeamDomain: { type: "string", default: "", label: "Cloudflare Access team domain", description: "Your Cloudflare Access team hostname, for example equisafe.cloudflareaccess.com, without https:// or a path.", experimental_schema: z.string().refine((value) => !value.trim() || /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value.trim()), "Use a DNS hostname without a scheme or path.") },
    accessAudience: { type: "string", default: "", label: "Cloudflare Access application AUD", description: "The audience tag of the Access application protecting the gated share route." },
    requireAccessJwt: { type: "boolean", default: true, label: "Require Access JWT on gated links", description: "Verify Cloudflare Access identity on gated links; disable only for local loopback testing, which displays an unverified banner." },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const service = new ShareService(new ShareStore(db), {
    settings: () => settings.get(), threads: bb.sdk.threads, log: bb.log,
    publish: (signal) => bb.realtime.publish(REALTIME_CHANNEL, signal), ...options,
  });
  bb.rpc.register(rpcContract, {
    share_status: () => service.status(), share_list: ({ threadId }) => service.list(threadId),
    share_create: (input) => service.create(input), share_update: (input) => service.update(input), share_revoke: (input) => service.revoke(input),
  });
  for (const [path, mode] of [["/s", "access"], ["/p", "public"]] as const) {
    bb.http.route("GET", path, (context) => {
      // Hono adapters may provide a Node incoming request; the SDK does not promise it.
      const address: unknown = context.env?.incoming?.socket?.remoteAddress;
      return service.handle(context.req.raw, mode, typeof address === "string" ? address : undefined);
    }, { auth: "none" });
  }
  registerCli(bb, service);
  bb.events.on("thread.deleted", ({ thread }) => service.revokeThread(thread.id));
  function reportConfiguration(values: Awaited<ReturnType<typeof settings.get>>) {
    if (!configuration(values).configured) bb.status.needsConfiguration("Set publicBaseUrl to enable thread sharing.");
  }
  settings.onChange(reportConfiguration);
  reportConfiguration(await settings.get());
  bb.onDispose(() => service.limiter.clear());
}
