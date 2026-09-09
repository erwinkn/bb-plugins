# Hide plugin nav menus

Hide the ellipsis on every plugin sidebar row, including Automations. The row
still opens the plugin. Right-click and More > Customize sidebar still work.

This replaces the Automations-only `automations-sidebar` plugin. Remove that
install after this one is running. Voice Mode can keep its own scoped hide;
the two do not conflict.

BB requires an empty server entry. No settings, secrets, or storage.

The content script targets BB 0.42 `data-sidebar-navigation-item` rows and the
`.bb-sidebar-hover-actions` wrapper. Plugin accessories stay visible after the
button is gone. Check these selectors after BB updates. BB removes the injected
style when the plugin unloads or reloads.

```sh
npm install
npm run typecheck
npm test
bb plugin build .
bb plugin install . --yes
```
