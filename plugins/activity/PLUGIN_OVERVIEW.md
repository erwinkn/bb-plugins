# Threads plugin

- `app.tsx`: sidebar registration, sorting, and group rendering.
- `lib/status.ts`: pure status rules and within-group order.
- `lib/thread-tree.ts`: parent/child nesting, sibling order, and family status.
- `lib/client-state.ts`: versioned per-client preferences, archive visibility,
  and draft flags.
- `lib/mobile-sidebar-scroll.ts`: scoped mobile whole-sidebar scroll styles.
- `components/draft-observer.tsx`: public composer-state observation.
- `components/thread-row.tsx`: native thread navigation and actions.
- `components/pull-request.tsx`: pull request icon and summary text.
- `components/thread-children.tsx`: child previews, expansion, and two-level nesting.
- `components/menus.tsx`: grouping, date sorting, and status visibility controls.
- `components/spaces-page.tsx`: the Spaces `navPanel` page (route
  `/plugins/<id>/spaces`, sub-paths `new`, `projects`, `<spaceId>`): the
  spaces list, the New space form, a space's heading actions, and the All
  projects view; one column at a time on phones.
- `components/project-list.tsx`: every BB project with optional membership
  checkboxes, row menus, inline edit forms, drag handles on desktop, and the
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
- `components/scope-menu.tsx`: the heading menu that selects All projects or a
  space and opens the space form or the Manage view.
- `components/new-thread-button.tsx`: scope-aware New thread button.
- `server.ts`: archive list and restore RPCs through BB, with change signals.
- `lib/archive-contract.ts`: validated archive RPC contract.
- `lib/use-archives.ts`: paged archive loading and refresh handling.
- `lib/project-schema.ts`, `lib/project-contract.ts`, `lib/projects-rpc.ts`,
  `lib/use-projects.ts`: project inventory (folders, hosts) and management RPC
  over `bb.sdk.projects` and `bb.sdk.hosts`; the frontend hook fetches it for
  the Manage view.
- `lib/space-schema.ts`: space catalog schema shared by server and frontend.
- `lib/space-contract.ts`: space RPC contract (server; frontend imports its type).
- `lib/spaces.ts`: catalog normalization and scope resolution shared by both sides.
- `lib/spaces-store.ts`: key-value catalog with revision checks, realtime
  signals, and the `bb activity` export/import CLI.
- `lib/use-spaces.ts`: catalog loading, local cache, realtime refresh, and saves.
- `tests/`: policy and public SDK frontend tests.

See `README.md` for status definitions and draft limitations.
