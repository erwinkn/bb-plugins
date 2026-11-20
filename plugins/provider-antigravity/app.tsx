import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { appContract, SignInFlow, Status, UsageState } from "./src/contract";

const INSTALL_URL = "https://antigravity.google/docs/getting-started";
const queryKeys = {
  status: ["antigravity-status"] as const,
  // One entry per Google account: switching accounts never shows the previous
  // account's limits, while loading or after a failed read.
  usage: ["antigravity-usage"] as const,
  usageFor: (email: string | null) => ["antigravity-usage", email ?? ""] as const,
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, networkMode: "always" },
    mutations: { networkMode: "always" },
  },
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Button({
  tone = "outline",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "outline" | "danger" }) {
  const tones = {
    primary: "bg-foreground text-background hover:bg-foreground/90",
    outline: "border border-input bg-transparent hover:bg-state-hover hover:text-foreground",
    danger: "border border-input bg-transparent text-destructive-text hover:bg-state-hover",
  };
  return (
    <button
      type="button"
      className={`inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${tones[tone]} ${className}`}
      {...props}
    />
  );
}

function Note({ tone = "muted", children }: { tone?: "muted" | "error" | "success"; children: ReactNode }) {
  const color =
    tone === "error" ? "text-destructive-text" : tone === "success" ? "text-foreground" : "text-muted-foreground";
  return <p className={`text-xs leading-snug ${color}`}>{children}</p>;
}

function formatReset(iso: string | null): string {
  if (!iso) return "unused";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "resets soon";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Stores a status the plugin's server just returned from a sign-in or sign-out
 * call. A status read still in flight was started before that call finished
 * and may carry the old state, so it is cancelled first: the answer of the
 * call always wins. With `dropUsage` (a finished sign-in or a sign-out) every
 * account's cached limits go too, so the next read starts clean (removed, not
 * refetched, so a read for the old account is cancelled with them).
 */
function useApplyStatus() {
  const client = useQueryClient();
  return async (next: Status, dropUsage = false) => {
    await client.cancelQueries({ queryKey: queryKeys.status });
    client.setQueryData(queryKeys.status, next);
    if (dropUsage) client.removeQueries({ queryKey: queryKeys.usage });
  };
}

function FlowPanel({ flow }: { flow: SignInFlow }) {
  const api = useRpc<typeof appContract>();
  const apply = useApplyStatus();
  const [response, setResponse] = useState("");
  const submit = useMutation({
    mutationFn: () => api.call("signInSubmit", { flowId: flow.id, response }),
    onSuccess: (next) => apply(next, true),
  });
  const cancel = useMutation({
    mutationFn: () => api.call("signInCancel", { flowId: flow.id }),
    onSuccess: (next) => apply(next),
  });

  if (flow.phase !== "waiting" || !flow.authorizationUrl) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <Note>{flow.message ?? "Working…"}</Note>
        <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2.5 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <Note>1. Open Google&apos;s sign-in page and choose your account.</Note>
        <a
          href={flow.authorizationUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex h-7 shrink-0 items-center rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:bg-foreground/90"
        >
          Open sign-in page ↗
        </a>
      </div>
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        <Note>2. Paste the authorization code (or the Antigravity callback URL).</Note>
        <div className="flex items-center gap-2">
          <input
            aria-label="Authorization code"
            autoComplete="off"
            spellCheck={false}
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            placeholder="Authorization code"
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button tone="primary" type="submit" disabled={submit.isPending || response.trim() === ""}>
            Sign in
          </Button>
          <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        </div>
        {submit.isError ? <Note tone="error">{errorText(submit.error)}</Note> : null}
      </form>
    </div>
  );
}

function UsageBlock({ enabled, email }: { enabled: boolean; email: string | null }) {
  const api = useRpc<typeof appContract>();
  const client = useQueryClient();
  // Set by Refresh for the one read it starts; read (and cleared) by the query.
  const forceNext = useRef(false);
  // One query, one entry per account: a read that started under account A lands
  // in A's entry, whatever happens to the page meanwhile, so a late answer never
  // reaches another account's limits. Nothing writes to these entries by hand.
  const usage = useQuery<UsageState>({
    queryKey: queryKeys.usageFor(email),
    queryFn: () => {
      const force = forceNext.current;
      forceNext.current = false;
      return api.call("usage", force ? { force: true } : {});
    },
    enabled,
  });
  const data = usage.data;
  // Limits are shown only when they name the account the page believes is signed
  // in. An answer for another account, or "not signed in" while the status says
  // signed in, means the status is out of date (credentials changed behind the
  // page's back): read it again. The page then reads usage under the account the
  // status names. Once per answer, so a mismatch the status does not explain ends
  // there instead of looping.
  const staleStatus =
    enabled && (data?.status === "unauthenticated" || (data?.status === "ok" && data.accountEmail !== email));
  useEffect(() => {
    if (staleStatus) void client.invalidateQueries({ queryKey: queryKeys.status });
  }, [staleStatus, usage.dataUpdatedAt, client]);
  const refresh = () => {
    forceNext.current = true;
    void usage.refetch().finally(() => {
      forceNext.current = false;
    });
  };

  if (!enabled) return null;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-foreground">Usage limits</div>
        <Button disabled={usage.isFetching} onClick={refresh}>
          {usage.isFetching && data ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {usage.isPending && !data ? (
        <Note>Reading Antigravity quota…</Note>
      ) : usage.isError ? (
        <Note tone="error">{errorText(usage.error)}</Note>
      ) : staleStatus ? (
        <Note>Checking which account these limits belong to…</Note>
      ) : data?.status === "ok" ? (
        <div className="space-y-2">
          {data.windows.map((w) => {
            const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
            return (
              <div key={w.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-foreground">{w.label}</span>
                  <span className="text-muted-foreground">
                    {pct}% used · {formatReset(w.resetsAt)}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-foreground" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : data?.status === "expired" ? (
        <Note tone="error">Sign-in expired. Click Switch account to sign in again.</Note>
      ) : data?.status === "error" ? (
        <Note tone="error">{data.message}</Note>
      ) : null}
    </div>
  );
}

function AntigravitySettings() {
  const api = useRpc<typeof appContract>();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const statusQuery = useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api.call("status", {}),
  });
  const apply = useApplyStatus();
  // Starting a flow changes nothing about who is signed in: keep the limits.
  const start = useMutation({
    mutationFn: () => api.call("signInStart", {}),
    onSuccess: (next) => apply(next),
  });
  const signOut = useMutation({
    mutationFn: () => api.call("signOut", {}),
    onSuccess: async (next) => {
      setConfirmSignOut(false);
      await apply(next, true);
    },
  });

  if (statusQuery.isPending) return <Note>Checking Antigravity…</Note>;
  if (statusQuery.isError) return <Note tone="error">{errorText(statusQuery.error)}</Note>;
  const s = statusQuery.data;
  if (!s.installed) {
    return (
      <Note>
        <code>agy</code> is not installed on this server.{" "}
        <a href={INSTALL_URL} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
          Install Antigravity CLI
        </a>
      </Note>
    );
  }
  const flow = s.flow;
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-start justify-between gap-4">
        <div className="text-sm text-foreground">
          {s.signedIn ? `Signed in as ${s.email ?? "a Google account"}` : "Not signed in"}
        </div>
        {flow?.active || confirmSignOut ? null : (
          <div className="flex shrink-0 gap-2">
            {s.signedIn ? (
              <>
                <Button disabled={start.isPending} onClick={() => start.mutate()}>
                  Switch account
                </Button>
                <Button tone="danger" onClick={() => setConfirmSignOut(true)}>
                  Sign out
                </Button>
              </>
            ) : (
              <Button tone="primary" disabled={start.isPending} onClick={() => start.mutate()}>
                Sign in with Google
              </Button>
            )}
          </div>
        )}
      </div>
      {confirmSignOut ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
          <Note>Remove the saved Antigravity token on this server?</Note>
          <div className="flex shrink-0 gap-2">
            <Button tone="danger" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
              Sign out
            </Button>
            <Button onClick={() => setConfirmSignOut(false)}>Keep</Button>
          </div>
        </div>
      ) : null}
      {flow?.active ? <FlowPanel flow={flow} /> : null}
      {flow && !flow.active && flow.message ? (
        <Note tone={flow.phase === "failed" ? "error" : "success"}>{flow.message}</Note>
      ) : null}
      {start.isError ? <Note tone="error">{errorText(start.error)}</Note> : null}
      {signOut.isError ? <Note tone="error">{errorText(signOut.error)}</Note> : null}
      <UsageBlock enabled={s.signedIn} email={s.email} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "account",
    title: "Google account & usage",
    description: "Antigravity uses your Google sign-in and its plan limits.",
    component: () => (
      <QueryClientProvider client={queryClient}>
        <AntigravitySettings />
      </QueryClientProvider>
    ),
  });
});
