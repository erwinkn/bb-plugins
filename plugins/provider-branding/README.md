# Provider Branding

Optional icons and labels for any exact provider ID in bb. The shipped mapping
keeps the existing `acp-devin` icon and `Devin CLI` label. The plugin does not
register an agent or change its launch command, authentication, or model IDs.

## Configure

Open the plugin settings page to see live provider IDs and native names. The
directory uses the public `experimental_useProviders` hook. It includes all
providers because the catalog does not expose a universal custom-provider flag.

Edit `providers.json`, keyed by those exact IDs. IDs need not start with `acp-`.
For example:

```json
{
  "acp-devin": { "label": "Devin CLI" },
  "my-agent": { "label": "My agent" },
  "amp": {}
}
```

Both fields are optional. Add `icon` as a PNG or WebP base64 data URL. Use a
transparent monochrome image: the icon renders as a mask in bb's current text
color. Use `data:image/png;base64,` followed by your PNG's base64 bytes. No remote
image request is made. Icons are limited to 128 KiB of encoded text; labels are
trimmed and limited to 80 characters, matching bb provider display names.
Invalid fields are ignored with a warning in settings and the plugin log.
An absent or rejected icon creates no icon registration, preserving native UI.
Supply a valid image; the plugin validates the data URL, not every image byte.

The mapping is compiled into the plugin. Rebuild and install a new revision to
change it. SDK 0.4.47 declares exact icon IDs synchronously; it does not provide
runtime wildcard registration or a provider-label replacement slot. This plugin
uses neither DOM changes nor asynchronous mutation of SDK registration state.

## Label boundaries

| Surface | Behavior |
| --- | --- |
| Provider tab in the model picker | Custom icon; native tab remains compact. The icon has a tooltip and accessible label. No persistent text is added beside it. |
| Selected composer control | Custom icon; bb still shows model and reasoning text. Provider text is available on the icon tooltip. |
| Model rows | Native model names remain unchanged. |
| Plugin settings directory | Visible configured label, exact provider ID, and native name. |
| Thread header and other native surfaces | bb controls placement and text. An icon slot does not add a text label to these surfaces. |

If no label is configured, the icon uses the live provider name, then its ID
while the catalog is unavailable. A label alone appears in the plugin directory;
it does not override a native icon or its tooltip.

Custom ACP agents have a supported `displayName` setting. Preview and explicitly
apply matching labels with:

```sh
bb provider-branding labels
bb provider-branding apply-labels
```

The command reads `provider-acp` through `bb.sdk.plugins.getSettings` and writes
only its `customAgents` setting through `updateSettings`. Only matching entries'
`displayName` fields change. Other fields and entries are preserved. The output
contains only provider IDs and old/new names, never commands or environment data.
Installation and reload do not apply labels. Already matching names do not write.
Generic non-ACP providers keep their native display names outside plugin surfaces.

The second read before writing detects some concurrent edits, but it is not an
atomic compare-and-swap: this SDK offers no expected-version setting write. Do
not edit ACP settings concurrently with `apply-labels`. Removing a label from the
mapping does not undo a previously applied ACP name; change that native setting
explicitly if required.

## Build and verify

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

Tests cover generic and ACP IDs, optional-field rejection, icon registration,
tooltip/accessibility text, label preview, preserving launch/auth fields, and
skipping equal values. Use a local bb browser to check actual theme and layout.

## Replace the earlier local Devin plugin

Install this plugin from a reviewed Git commit using the collection name
`erwin-provider-branding`. Keep the old source and settings available. Disable
`devin-branding` before checking the replacement icon so the two plugins do not
compete for the same slot. If verification fails, disable the replacement and
enable `devin-branding` again. The existing `Devin CLI` name needs no migration.

The bundled Devin mask comes from the official documentation favicon at
https://docs.devin.ai/mintlify-assets/_mintlify/favicons/cognitionai/Ycul7J1XWDV1FX48/_generated/favicon/android-chrome-192x192.png,
retrieved on 2026-09-06. This is a personal customization, not an official
Cognition plugin. The icon data contains no account or host settings.
