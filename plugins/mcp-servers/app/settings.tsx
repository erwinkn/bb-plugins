// Settings → Plugins → MCP servers: add a server, connect it, see what it
// serves. Every read comes from the query cache at once (lib/queries.tsx);
// writes go through useMutation, and their effect arrives as the server's
// pushed list.

import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { queryKeys, serversQuery, type Api } from "@/lib/queries";
import { refresh } from "@/lib/query";
import { suggestPrefix, type AuthInput, type ServerInput, type ServerView } from "@/src/schemas";

const PLUGIN_ID = "mcp-servers";
const callbackFor = (origin: string) => `${origin}/api/v1/plugins/${PLUGIN_ID}/http/oauth/callback`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATE: Record<ServerView["state"], { label: string; dot: string }> = {
  connected: { label: "Connected", dot: "bg-[var(--success)]" },
  connecting: { label: "Connecting…", dot: "bg-muted-foreground/60 animate-pulse" },
  idle: { label: "Reconnecting…", dot: "bg-muted-foreground/60 animate-pulse" },
  "needs-auth": { label: "Needs authorization", dot: "bg-[var(--attention)]" },
  error: { label: "Unreachable", dot: "bg-destructive" },
  disabled: { label: "Disabled", dot: "bg-muted-foreground/30" },
};

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid content-start gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="inline-flex w-fit rounded-md border border-border p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-3 py-1 text-sm transition-colors",
            value === option.value ? "bg-state-active text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Add or edit form. Secrets are write-only: an edit leaves them empty unless retyped. */
function ServerForm({
  api,
  initial,
  onDone,
}: {
  api: Api;
  initial?: ServerView;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [prefix, setPrefix] = useState(initial?.prefix ?? "");
  const [prefixEdited, setPrefixEdited] = useState(Boolean(initial));
  const [kind, setKind] = useState<AuthInput["kind"]>(initial?.auth.kind ?? "none");
  const [headerName, setHeaderName] = useState(initial?.auth.headerName ?? "Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [advanced, setAdvanced] = useState(Boolean(initial?.auth.clientId || initial?.auth.scope || initial?.auth.clientMetadataUrl));
  const [clientId, setClientId] = useState(initial?.auth.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scope, setScope] = useState(initial?.auth.scope ?? "");
  const [clientMetadataUrl, setClientMetadataUrl] = useState(initial?.auth.clientMetadataUrl ?? "");

  const save = useMutation({
    mutationFn: async (input: ServerInput) => {
      if (initial) await api.call("update", { id: initial.id, ...input });
      else await api.call("add", input);
    },
    onSuccess: () => {
      refresh(client, queryKeys.servers);
      onDone();
    },
  });

  const effectivePrefix = prefixEdited ? prefix : suggestPrefix(name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const auth: AuthInput =
      kind === "none"
        ? { kind }
        : kind === "header"
          ? { kind, headerName, ...(headerValue ? { headerValue } : {}) }
          : {
              kind,
              ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
              ...(clientSecret ? { clientSecret } : {}),
              ...(scope.trim() ? { scope: scope.trim() } : {}),
              ...(clientMetadataUrl.trim() ? { clientMetadataUrl: clientMetadataUrl.trim() } : {}),
            };
    save.mutate({ name: name.trim(), url: url.trim(), prefix: effectivePrefix, auth });
  };

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Linear" required autoFocus />
        </Field>
        <Field label="Tool prefix" hint={`Agents see ${effectivePrefix || "prefix"}_<tool>.`}>
          <Input
            value={effectivePrefix}
            onChange={(event) => {
              setPrefixEdited(true);
              setPrefix(event.target.value.toLowerCase());
            }}
            className="font-mono"
            required
          />
        </Field>
      </div>
      <Field label="Server URL" hint="The server's Streamable HTTP (or legacy SSE) endpoint.">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://mcp.example.com/mcp"
          className="font-mono"
          inputMode="url"
          required
        />
      </Field>
      <div className="grid gap-2 text-sm">
        <span className="font-medium">Authentication</span>
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "none", label: "None" },
            { value: "header", label: "Header" },
            { value: "oauth", label: "OAuth" },
          ]}
        />
      </div>
      {kind === "header" ? (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr]">
          <Field label="Header">
            <Input value={headerName} onChange={(event) => setHeaderName(event.target.value)} className="font-mono" required />
          </Field>
          <Field label="Value" hint={initial?.auth.headerValueSet ? "Saved. Leave empty to keep it." : "Stored on the BB server only."}>
            <Input
              type="password"
              value={headerValue}
              onChange={(event) => setHeaderValue(event.target.value)}
              placeholder={headerName.toLowerCase() === "authorization" ? "Bearer …" : ""}
              autoComplete="off"
              required={!initial?.auth.headerValueSet}
            />
          </Field>
        </div>
      ) : null}
      {kind === "oauth" ? (
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            BB discovers the authorization server and registers itself. After saving, click Connect and approve access.
          </p>
          <button
            type="button"
            className="justify-self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
          >
            {advanced ? "Hide advanced options" : "Use a pre-registered client or set scopes"}
          </button>
          {advanced ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client ID">
                <Input value={clientId} onChange={(event) => setClientId(event.target.value)} className="font-mono" />
              </Field>
              <Field label="Client secret" hint={initial?.auth.clientSecretSet ? "Saved. Leave empty to keep it." : "Only for confidential clients."}>
                <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" />
              </Field>
              <Field label="Scopes" hint="Space-separated. Empty: what the server asks for.">
                <Input value={scope} onChange={(event) => setScope(event.target.value)} className="font-mono" />
              </Field>
              <Field label="Client metadata URL" hint="A client ID metadata document you host (https).">
                <Input value={clientMetadataUrl} onChange={(event) => setClientMetadataUrl(event.target.value)} className="font-mono" />
              </Field>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Register this redirect URI with the client:{" "}
                <code className="select-all break-all font-mono text-foreground">{callbackFor(window.location.origin)}</code>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {message(save.error)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : initial ? "Save" : "Add server"}
        </Button>
      </div>
    </form>
  );
}

/** Connect / Re-authorize: opens the authorization page, with a paste fallback. */
function Authorize({ api, server }: { api: Api; server: ServerView }) {
  const client = useQueryClient();
  const [link, setLink] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const start = useMutation({
    mutationFn: async () => {
      // Open the tab inside the click, before awaiting, so it is not blocked.
      const tab = window.open("about:blank", "_blank");
      // The authorization page must not be able to navigate this BB tab.
      if (tab) tab.opener = null;
      try {
        const { authorizationUrl } = await api.call("startAuth", { id: server.id, origin: window.location.origin });
        if (!authorizationUrl) {
          tab?.close();
          return;
        }
        setLink(authorizationUrl);
        if (tab) tab.location.href = authorizationUrl;
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    // The push says the flow is pending; this read covers a lost push.
    onSuccess: () => refresh(client, queryKeys.servers),
  });
  const finish = useMutation({
    mutationFn: () => api.call("completeAuth", { id: server.id, redirectedUrl: pasted }),
    onSuccess: () => {
      setPasted("");
      setLink(null);
    },
  });
  // The server's flow decides: once the tab's login (or Forget, or expiry)
  // ends it, the link and the paste form go with it.
  const waiting = server.auth.pending;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? "Opening…" : server.auth.authorized ? "Re-authorize" : "Connect"}
        </Button>
        {link && waiting ? (
          <a href={link} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Open the authorization page
          </a>
        ) : null}
      </div>
      {start.error ? <p className="text-xs text-destructive">{message(start.error)}</p> : null}
      {waiting ? (
        <form
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (pasted.trim()) finish.mutate();
          }}
        >
          <span className="text-xs text-muted-foreground">
            Approve access in the new tab; this page updates when it returns. If that tab ends on an error page, paste its address here:
          </span>
          <div className="flex gap-2">
            <Input
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="https://…/oauth/callback?code=…"
              className="h-8 font-mono text-xs"
            />
            <Button type="submit" size="sm" variant="outline" disabled={finish.isPending || !pasted.trim()}>
              Finish
            </Button>
          </div>
          {finish.error ? <span className="text-xs text-destructive">{message(finish.error)}</span> : null}
        </form>
      ) : null}
    </div>
  );
}

function ServerRow({ api, server }: { api: Api; server: ServerView }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSettled: () => refresh(client, queryKeys.servers),
  });
  if (editing) return <ServerForm api={api} initial={server} onDone={() => setEditing(false)} />;

  const state = STATE[server.state];
  const facts = [
    `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`,
    server.server?.protocolVersion ? `MCP ${server.server.protocolVersion}` : null,
    server.server?.transport === "sse" ? "legacy SSE" : null,
    server.auth.kind === "oauth" ? "OAuth" : server.auth.kind === "header" ? `${server.auth.headerName} header` : null,
  ].filter(Boolean);
  const notLive = server.enabled && server.tools.length !== server.liveToolCount;

  return (
    <li className="grid gap-3 px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", state.dot)} title={state.label} aria-label={state.label} />
            <span className="truncate font-medium">{server.name}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{server.prefix}_*</code>
          </div>
          <div className="mt-0.5 truncate pl-4 font-mono text-xs text-muted-foreground" title={server.url}>
            {server.url}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {server.enabled && server.state !== "needs-auth" ? (
            <Button size="sm" variant="ghost" onClick={() => action.mutate(() => api.call("reconnect", { id: server.id }))}>
              Reconnect
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={!server.enabled}
            onClick={() => action.mutate(() => api.call("setEnabled", { id: server.id, enabled: !server.enabled }))}
          >
            {server.enabled ? "Disable" : "Enable"}
          </Button>
          {confirmRemove ? (
            <>
              <Button size="sm" variant="destructive" onClick={() => action.mutate(() => api.call("remove", { id: server.id }))}>
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center pl-4 text-xs text-muted-foreground">
        {[state.label, ...facts].map((fact, index) => (
          <span key={String(fact)} className="flex items-center">
            {index > 0 ? <span aria-hidden className="px-1.5 text-muted-foreground/50">·</span> : null}
            {index === 1 && server.tools.length > 0 ? (
              <button type="button" className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => setShowTools(!showTools)} aria-expanded={showTools}>
                {fact}
              </button>
            ) : (
              <span className={index === 0 ? "text-foreground/80" : undefined}>{fact}</span>
            )}
          </span>
        ))}
      </div>

      {server.error && server.state !== "connected" && server.state !== "needs-auth" ? (
        <p className="pl-4 text-xs text-destructive">{server.error}</p>
      ) : null}
      {action.error ? <p className="pl-4 text-xs text-destructive">{message(action.error)}</p> : null}
      {server.conflicts.length > 0 ? (
        <p className="pl-4 text-xs text-[var(--attention)]">
          Another plugin already owns {server.conflicts.join(", ")}; agents get that one. Change the prefix to fix it.
        </p>
      ) : null}
      {notLive ? (
        <p className="pl-4 text-xs text-muted-foreground">Agents get the current tool list in their next session.</p>
      ) : null}

      {server.auth.kind === "oauth" && server.enabled ? (
        <div className="pl-4">
          <Authorize api={api} server={server} />
          {server.auth.authorized ? (
            <button
              type="button"
              className="mt-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => action.mutate(() => api.call("disconnect", { id: server.id }))}
            >
              Forget tokens
            </button>
          ) : null}
        </div>
      ) : null}

      {showTools ? (
        <ul className="ml-4 grid gap-2 rounded-md border border-border bg-background/50 p-3">
          {server.tools.map((tool) => (
            <li key={tool.upstreamName} className="grid gap-0.5">
              <code className="font-mono text-xs">{tool.name}</code>
              {tool.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</span> : null}
              {tool.schemaChanges.length > 0 ? (
                <span className="text-xs text-muted-foreground/80">Schema adjusted for BB: {tool.schemaChanges.join("; ")}.</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SettingsSection() {
  const api = useRpc<typeof import("../server").rpcContract>();
  const servers = useQuery(serversQuery(api));
  const [adding, setAdding] = useState(false);
  const list = servers.data?.servers ?? [];

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Each server's tools reach every agent under their own names, descriptions and schemas, with the server's
        instructions. A running thread picks up changes in its next session.
      </p>
      {servers.data?.reloadPending ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Applying tool changes…</p>
      ) : null}
      {servers.error && !servers.data ? (
        <p role="alert" className="text-sm text-destructive">
          {message(servers.error)}
        </p>
      ) : null}
      {servers.isPending ? (
        <div className="h-16 animate-pulse rounded-lg border border-border bg-muted/40" aria-label="Loading servers" />
      ) : list.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {list.map((server) => (
            <ServerRow key={server.id} api={api} server={server} />
          ))}
        </ul>
      ) : !adding ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No MCP servers yet.
        </div>
      ) : null}
      {adding ? (
        <ServerForm api={api} onDone={() => setAdding(false)} />
      ) : (
        <div>
          <Button variant="outline" onClick={() => setAdding(true)}>
            Add server
          </Button>
        </div>
      )}
    </div>
  );
}
