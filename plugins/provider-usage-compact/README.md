# Provider usage compact

`provider-usage-compact` replaces BB's built-in usage popup with a compact header.
The machine button shows an icon. Its tooltip and accessible label identify the
selected machine. All header controls are 32 pixels high. Provider tabs wrap when
space is limited. Click outside the popup or press Escape to close it.

Provider discovery uses `capability: "usage"`. Devin appears when its provider
reports usage support. The plugin uses BB's existing provider credentials and
usage APIs. It needs no separate sign-in or API key.

## Icons

Generic icons (machine, check, refresh, close, menu chevrons) render through
BB's host icon registry with `experimental_Icon`, so the plugin ships no icon
set of its own. `lib/host-icon-names.ts` is generated from bb source by
`scripts/host-icon-names.mjs` at the repository root and types every icon name
the plugin uses; a typo fails `npm run typecheck`. Regenerate it after a bb
upgrade with:

```sh
node scripts/host-icon-names.mjs --tag desktop-v<version> --plugin provider-usage-compact
```

The machine button and the machine menu show each host's machine-provider
artwork through `experimental_ProviderIcon` with kind `machine`. The backend
resolves it from `hosts.experimental_listProviders`; hosts without a machine
provider, or a bb without that listing, fall back to the generic terminal
icon. Provider tabs keep each agent provider's logo or glyph from BB's provider
data.

## Install locally

From the repository root:

```sh
cd plugins/provider-usage-compact
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install path:. --yes
bb plugin disable provider-usage
```

Confirm that `provider-usage-compact` is running before disabling the built-in
plugin. Both plugins use separate IDs. Installation does not change BB's app
bundle. Keep this directory available while the local plugin is installed.
After source changes, build and run `bb plugin reload provider-usage-compact`.

## Switch back

```sh
bb plugin disable provider-usage-compact
bb plugin enable provider-usage
```

## Source and checks

Adapted from BB's MIT-licensed `plugins/provider-usage` and shared UI components
at commit `accd5595926b080a1e17d1ea9b2fa2d7d0505ac6`. The license is included in `LICENSE`.
The BB CLI scaffold supplied the remaining UI components. The SDK dependency is
pinned to the installed BB version. Run `bb plugin types` when upgrading it.
Requires BB 0.43.0 or later for the host icon registry; it stores no thread
plugin metadata, so it does not need BB 0.43.1.

Tests cover provider discovery, per-machine caching, offline status, provider and
machine selection, keyboard tabs, manual refresh, and refresh cleanup. Check
layout and outside-click dismissal in BB because its footer owns the popup.
