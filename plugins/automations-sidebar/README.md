# Automations sidebar

Hide the ellipsis button on the Automations sidebar row. The row still opens
Automations. Right-click and More > Customize sidebar remain available.

BB requires an empty server entry. This plugin has no scheduler, settings, or
storage. It does not replace the built-in Automations plugin. Disable it to restore the button.

The content script targets BB 0.42's `data-sidebar-navigation-item` row key and
`.bb-sidebar-hover-actions` wrapper. Check these selectors after BB updates.
BB removes the injected style when the plugin unloads or reloads.

```sh
npm install
npm run typecheck
bb plugin build .
bb plugin install . --yes
```
