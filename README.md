# BB plugins

A private GitHub collection of BB plugins.

`erwin-devin` adds **Devin** as a provider, with a native icon, sign-in
help, executable setting, account usage, and live ACP model catalog. It preserves the provider
ID `acp-devin`. See [Devin provider](plugins/devin/README.md) for configuration,
verification, and migration from a custom ACP entry.

## Install

Use BB 0.42.1 or later. The bb server needs Git, npm, and GitHub access to this
private repository. Configure Git authentication on that machine; do not put a
token in the repository URL.

Replace `COMMIT_SHA` with the full reviewed commit SHA:

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@COMMIT_SHA --plugin erwin-devin
```

Follow the migration steps first if a custom ACP entry already owns
`acp-devin`. The collection index is `.bb/plugins.json`; the package lives in
`plugins/devin`. Git installation builds source on the bb server. Generated
bundles are not committed.

## Develop

Use the local BB CLI, Node.js 22 or later, and npm:

```sh
cd plugins/devin
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

The earlier Hello proof plugin and general branding experiment have been
removed from the current collection. Their prior commits and release tags stay
in Git history.

## Desired upstream changes

### Mobile: choose Steer or Queue from the Send button

When Steer is the default send action, desktop users can press Command+Enter
to queue a message. Mobile users need a touch control for the same choice.

Allow a long press on Send to open a menu with **Steer now** and **Queue next**.
A normal tap should keep the configured default. Opening or dismissing the
menu must not send the message. A visible menu arrow could also expose the choice.

This belongs in BB's core composer. Both actions already exist, but the plugin
API has no dedicated way to change the built-in Send button's behavior.

Status: recorded here; no upstream issue filed.
Suggested issue title: `Mobile: long-press Send to choose Steer or Queue`.
File the request in [BB issues](https://github.com/get-bb/bb/issues).
