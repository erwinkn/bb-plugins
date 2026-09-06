import { definePluginApp, experimental_useProviders } from "@get-bb/plugin-sdk/app";
import mapping from "./providers.json";
import { parseBranding, type Branding, type BrandingConfig } from "./branding";

const config = parseBranding(mapping);

export function ProviderMark({ providerId, branding, className }: { providerId: string; branding: Branding; className?: string }) {
  const { providers } = experimental_useProviders();
  const provider = providers.find((entry) => entry.id === providerId);
  const label = branding.label ?? provider?.displayName ?? providerId;
  const mask = `url("${branding.icon}")`;
  return <span className={className} role="img" aria-label={label} title={label}
    style={{ display: "inline-block", backgroundColor: "currentColor", maskImage: mask,
      WebkitMaskImage: mask, maskSize: "contain", WebkitMaskSize: "contain",
      maskPosition: "center", WebkitMaskPosition: "center", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" }} />;
}

function ProviderDirectory() {
  const { providers, status } = experimental_useProviders();
  return <div className="space-y-4 text-sm">
    <p>Edit <code>providers.json</code> in the plugin source, then rebuild and install the new version.</p>
    <p>Icons use the optional label as a tooltip and accessible name. Native picker text stays under bb’s control. Use <code>bb provider-branding labels</code> to preview custom ACP name changes.</p>
    {config.warnings.map((warning) => <p role="alert" key={warning}>{warning}</p>)}
    {status === "loading" && <p>Loading providers…</p>}
    {status === "error" && <p role="alert">Could not load the provider catalog.</p>}
    {status === "ready" && <ul className="space-y-3">
      {providers.map((provider) => {
        const entry = config.entries[provider.id];
        return <li key={provider.id} className="flex items-start gap-3">
          {entry?.icon && <ProviderMark providerId={provider.id} branding={entry} className="mt-1 size-5 shrink-0" />}
          <div className="min-w-0 break-words">
            <p className="font-medium">{entry?.label ?? provider.displayName}</p>
            <p className="text-muted-foreground"><code>{provider.id}</code> · Native name: {provider.displayName} · {entry?.icon ? "Custom icon" : "Native icon"}</p>
          </div>
        </li>;
      })}
    </ul>}
    {status === "ready" && Object.keys(config.entries).filter((id) => !providers.some((provider) => provider.id === id)).map((id) => <p key={id}>{id}: configured, but not in the current catalog.</p>)}
  </div>;
}

export function createApp(brandingConfig: BrandingConfig) {
  return definePluginApp((app) => {
  for (const [providerId, branding] of Object.entries(brandingConfig.entries)) {
    // No override means bb retains its native icon, including other plugins' icons.
    if (!branding.icon) continue;
    app.slots.experimental_providerIcon({ providerId, icon: ({ className }) => <ProviderMark providerId={providerId} branding={branding} className={className} /> });
  }
  app.slots.settingsSection({ id: "providers", title: "Provider branding", component: ProviderDirectory });
  });
}

export default createApp(config);
