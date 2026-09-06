import type { BbPluginApi } from "@get-bb/plugin-sdk";
import mapping from "./providers.json";
import { parseBranding, planLabels } from "./branding";

export default function plugin(bb: BbPluginApi) {
  const config = parseBranding(mapping);
  for (const warning of config.warnings) bb.log.warn(warning);
  bb.cli.register({
    name: "provider-branding",
    summary: "Preview or apply display labels to configured custom ACP providers.",
    commands: [
      { name: "labels", usage: "labels", summary: "Preview custom ACP display-name changes." },
      { name: "apply-labels", usage: "apply-labels", summary: "Apply the previewed custom ACP display names." },
    ],
    async run(argv) {
      if (argv.length !== 1 || !["labels", "apply-labels"].includes(argv[0]!)) {
        return { exitCode: 1, stderr: "Usage: bb provider-branding labels | apply-labels\n" };
      }
      const args = { pluginId: "provider-acp" };
      const settings = await bb.sdk.plugins.getSettings(args);
      const raw = settings.values.customAgents;
      let plan;
      try { plan = planLabels(raw, config.entries); }
      catch { return { exitCode: 1, stderr: "Cannot read ACP customAgents. No settings changed.\n" }; }
      if (argv[0] === "apply-labels" && plan.changes.length) {
        const current = await bb.sdk.plugins.getSettings(args);
        if (current.values.customAgents !== raw) return { exitCode: 1, stderr: "ACP settings changed. Preview again before applying.\n" };
        await bb.sdk.plugins.updateSettings({ ...args, values: { customAgents: plan.next } });
      }
      // Never return the source configuration: it can contain launch credentials.
      return { exitCode: 0, stdout: JSON.stringify({ applied: argv[0] === "apply-labels", changes: plan.changes }, null, 2) + "\n" };
    },
  });
}
