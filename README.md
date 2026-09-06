# BB plugins

A private GitHub collection of BB plugins.

`voice-mode` adds real-time voice control of bb: a waveform button next to the
composer microphone, a **Voice** sidebar page, and a `bb voice-mode` CLI. It is a
renamed copy of [bb-handsfree](https://github.com/swairshah/bb-handsfree).
See `plugins/voice-mode/README.md`.

`erwin-hello` adds **Erwin Hello** to the sidebar. Select **Say hello** to
send a request to the BB server. The page shows the server message and UTC
time. The plugin uses no storage, credentials, host entry, or background work.

## Install from GitHub

Use BB 0.42.1 or later with Plugin SDK 0.4.47 or later. The machine that runs
the BB server needs Git, npm, and GitHub access to this private repository.
Configure Git authentication on that machine before installation. Do not put
a token in the repository URL.

```sh
bb plugin install git:https://github.com/erwinkn/bb-plugins.git@main --plugin erwin-hello
```

The collection index is `.bb/plugins.json`. The plugin package is
`plugins/hello/package.json`, with package name `bb-plugin-erwin-hello` and
plugin ID `erwin-hello`. The page route is `/plugins/erwin-hello/hello`.
Git installation installs runtime dependencies and builds the source on the
BB server. No generated bundle is stored in this repository.

## Develop

Use a local BB CLI, Node.js 22 or later, and npm. Dependencies have exact
versions in the package manifest and a committed npm lockfile.

```sh
cd plugins/hello
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

For a local development installation, use the following commands instead of
the Git installation. Use only one installation of this plugin ID at a time.

```sh
bb plugin install .
bb plugin dev
```

React and the Plugin SDK runtime come from BB. Zod is the only direct runtime
dependency. SQLite is a development dependency for the SDK test harness; the
plugin does not open a database. TypeScript checks the plugin source with
strict mode; `skipLibCheck` skips checks inside dependency declarations.

## Verify the installed plugin

1. Open **Erwin Hello** in the BB sidebar.
2. Select **Say hello**. Check for **Hello from the BB server!** and a UTC time.
3. Wait one second, then select the button again. Check that the time changes.
4. Check the page at a narrow mobile width. The button and response must fit.

The RPC method is `ping`, with JSON input `null`. Its response contains
`message` and `serverTime`. A pending request disables the button. A failed
request clears the old response and shows an error; the button then permits
a new attempt.

The local tests check the RPC boundary, invalid input, response size, server
time, and public SDK imports. They do not prove GitHub authentication, remote
installation, or live UI behavior. Run the installed checks above to test the
complete path.
