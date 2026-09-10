import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { namedWorkerSettingsSchema, namedWorkerProfileSchema, workerProfileSchema, type NamedWorkerProfile, type NamedWorkerSettings as Settings } from "./worker-profiles.ts";
import type { WorkerCatalog } from "./provider-catalog.ts";
import { Button } from "./components/ui/button";

const inputClass = "block w-full min-w-0 max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-60";

export function WorkerSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [catalog, setCatalog] = useState<WorkerCatalog | null>(null);
  const [hostId, setHostId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const current = useRef({ dirty: false });
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  current.current.dirty = dirty;
  const refresh = useCallback(() => {
    const request = ++generation.current;
    void rpc.call("getWorkerSettings", null).then(next => {
      if (request !== generation.current) return;
      setSaved(next);
      if (!current.current.dirty) setSettings(next);
    }, cause => { if (request === generation.current) setError(String(cause)); });
  }, [rpc]);
  useEffect(() => { refresh(); return () => { generation.current++; }; }, [refresh]);
  useRealtime("worker-profiles-changed", refresh);
  useEffect(() => {
    let active = true;
    setLoadingCatalog(true);
    void rpc.call("listWorkerProviders", hostId ? { hostId } : {}).then(next => {
      if (active) { setCatalog(next); setLoadingCatalog(false); setError(null); }
    }, cause => { if (active) { setCatalog(previous => previous ? { ...previous, hostId: null, providers: [], models: [] } : null); setError(String(cause)); setLoadingCatalog(false); } });
    return () => { active = false; };
  }, [rpc, hostId, catalogRevision]);

  const edit = (next: Settings) => { setSettings(next); setNotice(null); setError(null); };
  const update = (index: number, patch: Partial<NamedWorkerProfile>) => {
    if (!settings) return;
    const old = settings.profiles[index];
    edit({ ...settings, defaultProfile: patch.name !== undefined && settings.defaultProfile === old.name ? patch.name : settings.defaultProfile,
      profiles: settings.profiles.map((profile, i) => i === index ? { ...profile, ...patch } : profile) });
  };
  const add = () => {
    if (!settings) return;
    let n = 1;
    while (settings.profiles.some(profile => profile.name === `profile-${n}`)) n++;
    const template = settings.profiles.find(profile => profile.name === settings.defaultProfile) ?? settings.profiles[0];
    edit({ ...settings, profiles: [...settings.profiles, { ...template, name: `profile-${n}` }] });
  };
  async function save() {
    if (!settings || !catalog?.hostId || busy) return;
    setBusy(true); generation.current++;
    try {
      const next = await rpc.call("setWorkerSettings", { settings: namedWorkerSettingsSchema.parse(settings), hostId: catalog.hostId });
      setSaved(next); setSettings(next); setError(null); setNotice("Profiles saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const validation = settings ? namedWorkerSettingsSchema.safeParse(settings) : null;
  const disabled = !settings || busy;
  return <div className="@container min-w-0 space-y-5" aria-label="Worker profiles" aria-busy={!settings || busy}>
    <p className="text-sm text-muted-foreground">Choose a profile for each background task. Each profile has its own model and instructions. Existing work keeps its model.</p>
    <label className="block min-w-0 space-y-1 text-sm">Preview models on machine
      <select aria-label="Worker catalog machine" className={inputClass} disabled={busy || loadingCatalog} value={hostId ?? catalog?.hostId ?? ""} onChange={event => setHostId(event.target.value || undefined)}>
        {!catalog?.hosts.length ? <option value="">No connected machine</option> : null}
        {catalog?.hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}
      </select>
    </label>
    <p className="text-xs text-muted-foreground">Save checks every profile on this machine. This does not choose where a task runs. The destination machine is checked again at launch.</p>
    {error ? <div role="alert" className="break-words text-sm text-destructive">{error} <Button variant="outline" size="sm" onClick={() => { refresh(); setCatalogRevision(value => value + 1); }} disabled={busy}>Reload settings</Button></div> : null}
    {!settings ? <p role="status" className="text-sm text-muted-foreground">Loading profiles...</p> : <>
      <label className="block min-w-0 space-y-1 text-sm">Default profile
        <select aria-label="Default profile" className={inputClass} disabled={disabled} value={settings.defaultProfile} onChange={event => edit({ ...settings, defaultProfile: event.target.value })}>
          {settings.profiles.map((profile, index) => <option key={index} value={profile.name}>{profile.name || "Unnamed profile"}</option>)}
        </select>
      </label>
      <div className="min-w-0 space-y-4">
        {settings.profiles.map((profile, index) => {
          const prefix = profile.name || `Profile ${index + 1}`;
          const provider = catalog?.providers.find(p => p.id === profile.providerId);
          const models = catalog?.models.filter(m => m.providerId === profile.providerId) ?? [];
          const model = profile.model ? models.find(m => m.model === profile.model || m.id === profile.model) : models.find(m => m.isDefault);
          const isDefault = settings.defaultProfile === profile.name;
          return <fieldset key={index} aria-label={`Profile ${prefix}`} disabled={disabled} className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4">
            <legend className="max-w-full break-words px-1 text-sm font-medium">{prefix}{isDefault ? " · Default" : ""}</legend>
            <div className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2">
              <label className="block min-w-0 space-y-1 text-sm">Name
                <input aria-label={`${prefix} name`} className={inputClass} maxLength={64} value={profile.name} onChange={event => update(index, { name: event.target.value })} />
              </label>
              <label className="block min-w-0 space-y-1 text-sm">Provider
                <select aria-label={`${prefix} provider`} className={inputClass} disabled={loadingCatalog || !catalog?.hostId} value={profile.providerId} onChange={event => update(index, { providerId: event.target.value, model: null, reasoningLevel: null, serviceTier: "default" })}>
                  {!provider ? <option value={profile.providerId} disabled>{profile.providerId} (unavailable)</option> : null}
                  {catalog?.providers.map(p => <option key={p.id} value={p.id} disabled={!p.available}>{p.displayName}{p.available ? "" : " (unavailable)"}</option>)}
                </select>
              </label>
              <label className="block min-w-0 space-y-1 text-sm">Model
                <select aria-label={`${prefix} model`} className={inputClass} disabled={loadingCatalog || !provider?.available} value={profile.model ?? ""} onChange={event => update(index, { model: event.target.value || null, reasoningLevel: null })}>
                  <option value="" disabled={!models.some(m => m.isDefault)}>Provider default model</option>
                  {profile.model && !model ? <option value={profile.model} disabled>{profile.model} (unavailable)</option> : null}
                  {models.map(m => <option key={m.id} value={m.model}>{m.displayName}</option>)}
                </select>
              </label>
              <label className="block min-w-0 space-y-1 text-sm">Reasoning level
                <select aria-label={`${prefix} reasoning level`} className={inputClass} disabled={loadingCatalog || !model} value={profile.reasoningLevel ?? ""} onChange={event => update(index, { reasoningLevel: event.target.value ? workerProfileSchema.shape.reasoningLevel.parse(event.target.value) : null })}>
                  <option value="">Model default</option>
                  {profile.reasoningLevel && !model?.reasoningLevels.some(level => level.id === profile.reasoningLevel) ? <option value={profile.reasoningLevel} disabled>{profile.reasoningLevel} (unsupported)</option> : null}
                  {model?.reasoningLevels.map(level => <option key={level.id} value={level.id}>{level.label}</option>)}
                </select>
              </label>
            </div>
            <label className="block min-w-0 space-y-1 text-sm">Permission mode
              <select aria-label={`${prefix} permission mode`} className={inputClass} value={profile.permissionMode} onChange={event => update(index, { permissionMode: namedWorkerProfileSchema.shape.permissionMode.parse(event.target.value) })}>
                <option value="accept-edits">Accept edits</option>
                <option value="auto">Auto</option>
                <option value="full">Full</option>
              </select>
              <span className="block text-xs text-muted-foreground">Investigate and review profiles usually keep accept-edits.</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" aria-label={`${prefix} Fast`} checked={profile.serviceTier === "fast"} disabled={loadingCatalog || (!provider?.serviceTiers.some(t => t.id === "fast") && profile.serviceTier !== "fast")} onChange={event => update(index, { serviceTier: event.target.checked ? "fast" : "default" })} />Fast
              {!provider?.serviceTiers.some(t => t.id === "fast") ? <span className="text-xs text-muted-foreground">Unavailable on this machine</span> : null}
            </label>
            <label className="block min-w-0 space-y-1 text-sm">Instructions
              <textarea aria-label={`${prefix} instructions`} className={`${inputClass} resize-y leading-relaxed`} rows={4} maxLength={16000} value={profile.instructions} onChange={event => update(index, { instructions: event.target.value })} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" aria-label={`Delete ${prefix}`} disabled={isDefault} onClick={() => edit({ ...settings, profiles: settings.profiles.filter((_, i) => i !== index) })}>Delete profile</Button>
              {isDefault ? <p className="text-xs text-muted-foreground">Choose another default before deleting this profile.</p> : null}
            </div>
          </fieldset>;
        })}
      </div>
      <Button variant="outline" disabled={disabled || settings.profiles.length >= 64} onClick={add}>Add profile</Button>
      <label className="block min-w-0 space-y-1 text-sm">Maximum active or unconfirmed workers
        <input type="number" aria-label="Maximum Voice workers" min={1} max={64} className={inputClass} disabled={disabled} value={settings.maxActiveWorkers} onChange={event => edit({ ...settings, maxActiveWorkers: Number(event.target.value) })} />
      </label>
      <p className="text-xs text-muted-foreground">BB applies the selected permission mode. An unconfirmed launch keeps its worker slot.</p>
      {dirty && validation && !validation.success ? <p role="alert" className="break-words text-sm text-destructive">{validation.error.issues[0].message}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={disabled || loadingCatalog || !catalog?.hostId || !dirty || !validation?.success} onClick={() => void save()}>{busy ? "Saving..." : "Save profiles"}</Button>
        <Button variant="outline" disabled={disabled || !dirty} onClick={() => { setSettings(saved); setError(null); setNotice(null); }}>Cancel</Button>
        {notice ? <span role="status" className="text-xs text-muted-foreground">{notice}</span> : null}
      </div>
    </>}
  </div>;
}
