# Hide plugin nav menus

Hide the ellipsis on every plugin sidebar row, including Automations. The row
still opens the plugin. Right-click and More > Customize sidebar still work.

This replaces the Automations-only `automations-sidebar` plugin. Remove that
install after this one is running. Voice Mode can keep its own scoped hide;
the two do not conflict.

BB requires an empty server entry. No settings, secrets, or storage.

The content script targets `data-sidebar-navigation-item` rows and the
`.bb-sidebar-hover-actions` wrapper. Plugin accessories stay visible after the
button is gone. Check these selectors after BB updates. BB removes the injected
style when the plugin unloads or reloads.

## BB 0.43.1 check

Verified live on BB 0.43.1 with SDK 0.4.87 (2026-09-13). Nothing in this
plugin needs 0.43.1; it works on 0.43.0 and 0.42.1 with the same selectors.

- Each plugin row (`__bb__/automations`, `voice-mode/sessions`,
  `sidebar/spaces`) has one `.bb-sidebar-hover-actions` child. That container
  holds exactly one element: the `<title> panel options` dropdown trigger with
  the `MoreHorizontal` icon. Hiding the container removes nothing else.
- Built-in rows (New thread, Search threads, Plugins, Skills) have no hover
  container, so the rule does not touch them.
- A plugin accessory is a sibling `[data-plugin-nav-sidebar-accessory]` span
  with `bb-sidebar-hover-actions-fade`; the second rule keeps it at opacity 1
  on hover.
- The row menu is Open in split, View details, Hide from sidebar, and Disable.
  Right-click opens the same items through the row's context menu, so nothing
  becomes unreachable. Left-click still opens the plugin.
- On narrow viewports the container carries
  `data-sidebar-hover-actions-mobile="always"`, which BB uses to keep the
  ellipsis visible without hover. The `display: none` rule hides it there too.

```sh
npm install
npm run typecheck
npm test
bb plugin build .
bb plugin install . --yes
```
