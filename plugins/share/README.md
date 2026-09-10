# Share

Share a BB thread as a read-only HTML page. Pages read the live conversation on
refresh; links can expire or be revoked. The thread header's Share control shows
an active-link dot and opens a popover to create, copy, configure, and revoke
links. Public links require an explicit confirmation before creation. Sign-in
links have an Allowed people field for email or `@domain` chips; an empty list
allows anyone who can sign in. Each link has tool-output and expiry controls.
Shares can also be managed with the CLI or the local-auth RPC contract.

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin share
```

The package must be present on `main` before that install command is usable.
For development in this checkout: `bb plugin install ./plugins/share --yes`,
then `bb plugin dev plugins/share`. The plugin ID is `share`.

## Modes and trust

| Mode | Who can read | Route and checks |
| --- | --- | --- |
| Access-gated (default) | Guests who sign in through Cloudflare Access; optionally limited to listed emails or exact domains | `/s?k=<slug>` verifies RS256 signature, issuer, audience, expiry, subject, and the per-share allow list. An empty list allows any verified identity. |
| Public | Anyone holding the link | `/p?k=<slug>` checks the 256-bit random slug and the global public-link switch; no identity is consulted. |

Both routes enforce the stored mode, revocation, expiry, and a shared limit of
60 requests per minute per client IP. They return 404 for inactive, unknown, or
wrong-mode links. Slugs are looked up by SHA-256 with a timing-safe hash comparison.
The plaintext slug is kept in the plugin-private database so the owner can copy
an existing link again. Thread deletion revokes that thread's links.

The tunnel must expose only these two paths. The handler trusts Cloudflare's
client IP header, then the first `x-forwarded-for` entry, then the socket IP if
available, then `unknown`. Direct callers that can forge proxy headers can also
forge their rate-limit identity. The in-memory buckets reset on plugin reload.

By default only user and assistant messages appear. Tool output is opt-in and
can include file contents, paths, and logs. System notices, attachments, images,
and file diffs are omitted. Common secret patterns are redacted, but this is not
a guarantee that arbitrary sensitive text will be removed. Pages contain no
scripts or external resources, disallow raw HTML and unsafe Markdown links,
and send a strict CSP, `no-store`, `noindex, nofollow`, and `no-referrer` headers.

The reader pages backward through the full timeline, flattens and orders all
rows, then keeps the newest 5000 source rows and notes truncation. With tools
enabled, collapsed turns expand through `timelineTurnSummaryDetails`; supplied nested conversation rows are
kept in either mode. SDK 0.4.47 exposes `outputPreview.totalChars` on command and
tool rows, but no direct API to retrieve a work row's complete output. Raw event
history would require reconstructing output, so incomplete previews are omitted
entirely, with the line “Output omitted: BB stored only a preview of this output.”
The tool title, detail, and status remain visible. Complete output is redacted
before the renderer caps it at 100,000 characters per tool output and reports how
many characters were omitted. Redaction also removes partial
PEM blocks and runs of at least 200 base64 characters, including wrapped lines.

## Settings

All settings are non-secret. Change them with `bb plugin config share set <key> <value>`.

| Key | Default | Meaning |
| --- | --- | --- |
| `publicBaseUrl` | empty | Required HTTP(S) origin, e.g. `https://bb.erwinkn.com`, without a path, credentials, query, or fragment. The effective value strips the trailing slash. |
| `publicLinksEnabled` | `true` | Disable to make every public link return 404 and refuse new public links. |
| `defaultExpiryDays` | `0` | New link lifetime in days; 0 means never. Fractional days are supported. |
| `accessTeamDomain` | empty | Cloudflare Access hostname, e.g. `equisafe.cloudflareaccess.com`. |
| `accessAudience` | empty | Application AUD tag for the gated route. |
| `requireAccessJwt` | `true` | Disable only for loopback development. Gated pages show “Unverified mode: Access JWT check is disabled”. |

`publicBaseUrl` controls `configured`; both Access values control
`accessConfigured`. Missing Access values do not disable public sharing.
Unconfigured routes return 503. BB reports `needs-configuration` naming
`publicBaseUrl`. Status is cleared by a plugin reload once configuration is
complete; `bb plugin reload share` is available if the host does not reload
automatically. Request handlers read current settings on every request.

With JWT checks disabled, no email identity is accepted, so a gated share with
a non-empty allow list still returns 403. The JWKS is cached for ten minutes;
an unknown key ID can trigger a refresh after a 30-second cooldown.

## CLI

`[thread]` defaults to the invoking CLI's `BB_THREAD_ID`. Human output is the
default, with machine-readable output through `--json`. Errors are one line and
exit non-zero; output is limited to 256 KiB (or the host's smaller limit).

```sh
bb share create [thread] [--public] [--allow <email-or-@domain>]... [--tools] [--expires <days>|never] [--json]
bb share allow <share-id> <entry>... [--json]
bb share disallow <share-id> <entry>... [--json]
bb share list [thread] [--json]
bb share revoke <share-id> [--json]
bb share status [--json]
```

Create prints the URL. Lists show ID, mode, state, views, creation date, and URL.
Emails and `@domain.tld` entries are trimmed, lowercased, validated, and
deduplicated. Domain entries match that exact domain, not subdomains. Public
shares accept valid allow lists but ignore them and always return `[]`.
Omitting `--expires` uses the setting; `never` or `0` means no expiry.

## Frontend RPC contract

`lib/model.ts` exports `rpcContract`, the Zod schemas, `Share`, `Status`, and
`REALTIME_CHANNEL = "share:changed"`. These methods have BB's local-auth semantics
at `POST /api/v1/plugins/share/rpc/<method>`. The host wraps success as
`{ ok: true, result }` and failure as `{ ok: false, error }`; input validation
messages naming malformed allow entries are in `error.issues`.

| Method | Input | Result |
| --- | --- | --- |
| `share_status` | `{}` | `Status` |
| `share_list` | `{ threadId }` | `{ shares: Share[] }` |
| `share_create` | `{ threadId, visibility, allowedEmails?, includeTools?, expiresInDays? }` | `{ share: Share }` |
| `share_update` | `{ threadId, shareId, allowedEmails?, includeTools?, expiresAt? }` | `{ share: Share }` |
| `share_revoke` | `{ threadId, shareId }` | `{ share: Share }` |

```ts
type Share = {
  id: string; threadId: string; visibility: "access" | "public"; url: string;
  allowedEmails: string[]; includeTools: boolean;
  createdAt: number; revokedAt: number | null; expiresAt: number | null;
  lastViewedAt: number | null; viewCount: number;
  state: "active" | "revoked" | "expired";
};
type Status = {
  configured: boolean; accessConfigured: boolean; publicLinksEnabled: boolean;
  defaultExpiryDays: number; publicBaseUrl: string | null; missing: string[];
};
```

Timestamps are epoch milliseconds. Creation expiry is in days, omitted for the
default and `null` for explicit never. Update expiry is an absolute timestamp,
with `null` to remove expiry; visibility cannot change. Update and revoke verify
thread ownership. Mutations publish `{ threadId }` on `share:changed`, including
thread-deletion revocation and admitted views. `missing` lists absent setting keys, including
Access-only fields. View counts update on admitted requests before timeline reads.

## Cloudflare setup

Recorded in the plugin README as a runbook. Nothing here is committed with real values.

1. Create a tunnel with `cloudflared tunnel create bb-share` and a DNS route for `bb.erwinkn.com`. The zone `erwinkn.com` is already on Cloudflare nameservers and the name has no record yet.
2. Ingress config, forwarding only the two plugin paths:

```yaml
ingress:
  - hostname: bb.erwinkn.com
    path: ^/api/v1/plugins/share/http/[sp]$
    service: http://127.0.0.1:38886
  - service: http_status:404
```

cloudflared matches only the decoded request path, never the query string, so
the rule must be exact.

3. Run `cloudflared` as a launchd service on the BB server machine.
4. In Zero Trust, create a self-hosted Access application for `bb.erwinkn.com` with the path `/api/v1/plugins/share/http/s`, so it covers only the gated route. Add one Allow policy that includes Everyone, and enable the login methods guests should have: one-time PIN by email, plus Google and GitHub if wanted. Access still requires sign-in for an Everyone policy. Per-thread narrowing happens in the plugin. Copy the AUD tag. The `/p` path stays outside the application, so public links open without login.
5. Fill the plugin settings.
6. Verify from a browser without a BB session: a gated link shows the login page, then the share page. A public link opens at once in a private window. A request to `/api/v1/threads` on the same hostname returns 404.
7. From outside the BB server, request both traversal paths below and confirm
   each returns the tunnel's 404, with no BB content. Use `--path-as-is` so curl
   sends the literal traversal instead of normalizing it locally:

```sh
curl --path-as-is -i 'https://bb.erwinkn.com/api/v1/plugins/share/http/p%3F/%2e%2e/%2e%2e/%2e%2e/%2e%2e/threads'
curl --path-as-is -i 'https://bb.erwinkn.com/api/v1/plugins/share/http/p/../../../../threads'
```

Existing Cloudflare Access credentials for `equisafe.cloudflareaccess.com` are present on this machine, so a Zero Trust org already exists. The Access application for `bb.erwinkn.com` can live in that org or in a new one for the `erwinkn.com` account. The `accessTeamDomain` setting follows that choice.

## Development checks

```sh
cd plugins/share
bb plugin types
npm run typecheck
npm test
npm run build
```

The current `bb plugin types` sync adds all host runtime type dependencies to
frontend plugins, including `@pierre/diffs`, `vaul`, and unused Radix families.
Keep those declarations so repeated syncs stay clean. Removing them durably
needs an upstream BB CLI change: sync only packages imported by the plugin,
while retaining the SDK test harness dependencies (file under `get-bb/bb`,
`bb plugin types` dependency syncing).
