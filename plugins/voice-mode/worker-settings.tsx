import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { WORKER_ROLES, workerProfileSchema, workerSettingsSchema, type WorkerRole, type WorkerProfile, type WorkerSettings as Settings } from "./worker-profiles.ts";
import type { WorkerCatalog } from "./provider-catalog.ts";
import { Button } from "./components/ui/button";

const names: Record<WorkerRole,string> = {investigate:"Investigation",plan:"Planning",implement:"Implementation",review:"Review"};
const inputClass = "block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-60";

export function WorkerSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [settings,setSettings] = useState<Settings|null>(null);
  const [catalog,setCatalog] = useState<WorkerCatalog|null>(null);
  const [hostId,setHostId] = useState<string|undefined>();
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string|null>(null);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    setLoading(true);
    Promise.all([rpc.call("getWorkerSettings",null),rpc.call("listWorkerProviders",hostId ? {hostId} : {})]).then(([next,options])=>{
      if (request !== generation.current) return;
      setSettings(next);setCatalog(options);setError(null);setLoading(false);
    },cause=>{if(request === generation.current){setError(cause instanceof Error ? cause.message : String(cause));setLoading(false);}});
  },[rpc,hostId]);
  useEffect(()=>{refresh();return()=>{generation.current++;};},[refresh]);
  useRealtime("worker-profiles-changed",refresh);
  const save = async(next: Settings)=>{
    setBusy(true);
    // Retire an older settings fetch, so it cannot overwrite the save result.
    generation.current++;
    try {setSettings(await rpc.call("setWorkerSettings",workerSettingsSchema.parse(next)));setError(null);}
    catch(cause){setError(cause instanceof Error ? cause.message : String(cause));}
    finally {setBusy(false);setLoading(false);}
  };
  const update = (role:WorkerRole|"default",patch:Partial<WorkerProfile>)=>{
    if(!settings)return;
    if(role!=="default"){void save({...settings,profiles:{...settings.profiles,[role]:{...settings.profiles[role],...patch}}});return;}
    const previous=settings.defaultProfile ?? settings.profiles.implement;
    const next={...previous,...patch};
    const profiles={...settings.profiles};
    for(const name of WORKER_ROLES)if(JSON.stringify(profiles[name])===JSON.stringify(previous))profiles[name]={...next};
    void save({...settings,defaultProfile:next,profiles});
  };
  const disabled=!settings || !catalog || !catalog.hostId || busy || loading;
  const renderProfile = (role:WorkerRole|"default") => {
      const profile=role==="default" ? settings?.defaultProfile ?? settings?.profiles.implement : settings?.profiles[role];
      const providers=catalog?.providers ?? [];
      const provider=providers.find(provider=>provider.id === profile?.providerId);
      const models=catalog?.models.filter(model=>model.providerId === profile?.providerId) ?? [];
      const model=profile?.model ? models.find(model=>model.model === profile.model || model.id === profile.model) : models.find(model=>model.isDefault);
      const prefix=role==="default" ? "Default worker" : names[role];
      return <fieldset key={role} className="space-y-3 border-t border-border pt-4" disabled={disabled}>
        <legend className="px-1 text-sm font-medium">{prefix}</legend>
        <label className="block space-y-1 text-sm">Provider
          <select aria-label={`${prefix} provider`} className={inputClass} value={profile?.providerId ?? ""} onChange={event=>update(role,{providerId:event.target.value,model:null,reasoningLevel:null,serviceTier:"default"})}>
            {profile && !provider ? <option value={profile.providerId}>{profile.providerId} (unavailable)</option> : null}
            {providers.map(provider=><option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.displayName}{provider.available ? "" : " (unavailable)"}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-sm">Model
          <select aria-label={`${prefix} model`} className={inputClass} value={profile?.model ?? ""} onChange={event=>update(role,{model:event.target.value || null,reasoningLevel:null})}>
            <option value="">Provider default model</option>
            {profile?.model && !model ? <option value={profile.model}>{profile.model} (unavailable)</option> : null}
            {models.map(model=><option key={model.id} value={model.model}>{model.displayName}</option>)}
          </select>
        </label>
        {model?.reasoningLevels.length || profile?.reasoningLevel ? <label className="block space-y-1 text-sm">Reasoning effort
          <select aria-label={`${prefix} reasoning effort`} className={inputClass} value={profile?.reasoningLevel ?? ""} onChange={event=>update(role,{reasoningLevel:event.target.value ? workerProfileSchema.shape.reasoningLevel.parse(event.target.value) : null})}>
            <option value="">Model default</option>
            {profile?.reasoningLevel && !model?.reasoningLevels.some(level=>level.id === profile.reasoningLevel) ? <option value={profile.reasoningLevel}>{profile.reasoningLevel} (unsupported)</option> : null}
            {model?.reasoningLevels.map(level=><option key={level.id} value={level.id}>{level.label}</option>)}
          </select>
        </label> : null}
        {provider?.serviceTiers.some(tier=>tier.id === "fast") || profile?.serviceTier === "fast" ? <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label={`${prefix} Fast`} checked={profile?.serviceTier === "fast"} onChange={event=>update(role,{serviceTier:event.target.checked ? "fast" : "default"})}/>Fast{!provider?.serviceTiers.some(tier=>tier.id === "fast") ? " (unsupported here; disable or choose another provider)" : ""}
        </label> : null}
      </fieldset>;
  };
  return <div className="space-y-5">
    <p className="text-xs text-muted-foreground">Internal Voice workers run under the hidden coordinator and stay out of the regular thread list. The default model applies to new workers; role-specific changes remain separate. Existing work keeps its model.</p>
    <p className="text-xs text-muted-foreground">Workers use BB’s accept-edits permission mode. Investigation and review are task instructions, not read-only sandboxes. Voice does not grant new permissions.</p>
    {error ? <div role="alert" className="space-y-2 text-sm text-destructive">{error}<Button variant="outline" onClick={refresh}>Retry worker settings</Button></div> : null}
    <label className="block space-y-1 text-sm">Preview models on machine
      <select aria-label="Worker catalog machine" className={inputClass} disabled={busy || loading || !catalog?.hosts.length} value={hostId ?? catalog?.hostId ?? ""} onChange={event=>setHostId(event.target.value || undefined)}>
        {!catalog?.hosts.length ? <option value="">No connected machine</option> : null}
        {catalog?.hosts.map(host=><option key={host.id} value={host.id}>{host.name}</option>)}
      </select>
    </label>
    <p className="text-xs text-muted-foreground">This selector previews availability; it does not choose a task’s machine. Profiles are checked again on the actual destination, with no silent model substitution.</p>
    {renderProfile("default")}
    <details className="space-y-3"><summary className="cursor-pointer text-sm font-medium">Role-specific models</summary>{WORKER_ROLES.map(renderProfile)}</details>
    <label className="block space-y-1 text-sm">Maximum active or unconfirmed Voice workers
      <input type="number" aria-label="Maximum Voice workers" min={1} max={64} className={inputClass} disabled={disabled} value={settings?.maxActiveWorkers ?? 8} onChange={event=>{
        const n=Number(event.target.value);if(settings && Number.isInteger(n) && n>=1 && n<=64) void save({...settings,maxActiveWorkers:n});
      }}/>
    </label>
    <p className="text-xs text-muted-foreground">Unconfirmed creation keeps its slot and is never retried automatically. Inspect the Voice diagnostics and BB threads before attempting new work.</p>
  </div>;
}
