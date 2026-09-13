# Threads plugin

- `app.tsx`: sidebar registration, sorting, and group rendering.
- `lib/status.ts`: pure status rules and within-group order.
- `lib/thread-tree.ts`: parent/child nesting, sibling order, and family status.
- `lib/client-state.ts`: versioned per-client preferences, archive visibility,
  and draft flags.
- `lib/mobile-sidebar-scroll.ts`: scoped mobile whole-sidebar scroll styles.
- `lib/host-icon-names.ts`: the icon names bb ships, generated from the pinned
  bb tag by `scripts/host-icon-names.mjs`; do not edit by hand.
- `lib/host-icon.tsx`: `experimental_Icon` wrapper typed against those names
  with a fallback.
- `components/draft-observer.tsx`: public composer-state observation.
- `components/thread-row.tsx`: native thread navigation and actions.
- `components/pull-request.tsx`: pull request icon and summary text.
- `components/thread-children.tsx`: child previews, expansion, and two-level nesting.
- `components/menus.tsx`: grouping, date sorting, order, and status visibility
  controls.
- `lib/ui-preferences-schema.ts`: the five BB sidebar preferences the plugin
  mirrors, shared by server and frontend.
- `lib/ui-preferences-contract.ts`, `lib/ui-preferences-store.ts`: read and
  compare-and-swap write RPCs over `bb.sdk.system.uiPreferences`, with a
  realtime signal per write.
- `lib/use-ui-preferences.ts`: applies BB's preferences to client state on
  mount, focus, and reconnect, and writes local changes through.
- `components/spaces-page.tsx`: the Spaces `navPanel` page (route
  `/plugins/<id>/spaces`, sub-paths `new`, `projects`, `<spaceId>`): the
  spaces list, the New space form, a space's heading actions, and the All
  projects view; one column at a time on phones.
- `components/project-list.tsx`: every BB project with optional membership
  checkboxes, row menus, inline edit forms, draggable rows on desktop, and the
  Add project form.
- `components/project-forms.tsx`: inline rename, change-folder, remove, and
  add-project forms.
- `lib/use-compact.ts`: viewport breakpoint for the page (slot props carry it
  for the sidebar).
- `components/path-field.tsx`: folder path input with host directory completion
  and the native folder dialog.
- `components/inline-form.tsx`: shared inline form (focus, Escape, errors).
- `components/project-header-menu.tsx`: right-click/long-press menu on project
  group headers.
- `components/scope-menu.tsx`: the heading menu that selects All projects, a
  space, or the Library and opens the Spaces page.
- `components/new-thread-button.tsx`: scope-aware New thread button.
- `server.ts`: archive list and restore RPCs through BB, with change signals.
- `lib/archive-contract.ts`: validated archive RPC contract.
- `lib/use-archives.ts`: paged archive loading and refresh handling.
- `lib/library-schema.ts`: saved-thread document shared by server and frontend.
- `lib/library-contract.ts`: library RPC contract (server; frontend imports its
  type).
- `lib/library.ts`: the ancestor rule that counts descendants of members as
  saved.
- `lib/library-store.ts`: key-value library document, archive/delete
  cleanup, and the saved flag mirrored into thread plugin metadata.
- `lib/use-library.ts`: library loading, local cache, and realtime refresh.
- `lib/project-schema.ts`, `lib/project-contract.ts`, `lib/projects-rpc.ts`,
  `lib/use-projects.ts`: project inventory (folders, hosts) and management RPC
  over `bb.sdk.projects` and `bb.sdk.hosts`; the frontend hook fetches it for
  the Spaces page.
- `lib/space-schema.ts`: space catalog schema shared by server and frontend.
- `lib/space-contract.ts`: space RPC contract (server; frontend imports its type).
- `lib/spaces.ts`: catalog normalization and scope resolution shared by both sides.
- `lib/spaces-store.ts`: key-value catalog with revision checks, realtime
  signals, and the `bb activity` export/import CLI.
- `lib/use-spaces.ts`: catalog loading, local cache, realtime refresh, and saves.
- `tests/`: policy and public SDK frontend tests.

See `README.md` for status definitions and draft limitations.
