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
- `components/scope-menu.tsx`: the heading menu that selects a space or an
  ad-hoc project selection.
- `components/space-form.tsx`: inline create, rename, and delete form.
- `components/new-thread-button.tsx`: scope-aware New thread button.
- `server.ts`: archive list and restore RPCs through BB, with change signals.
- `lib/archive-contract.ts`: validated archive RPC contract.
- `lib/use-archives.ts`: paged archive loading and refresh handling.
- `lib/space-schema.ts`: space catalog schema shared by server and frontend.
- `lib/space-contract.ts`: space RPC contract (server; frontend imports its type).
- `lib/spaces.ts`: catalog normalization and scope resolution shared by both sides.
- `lib/spaces-store.ts`: key-value catalog with revision checks, realtime
  signals, and the `bb activity` export/import CLI.
- `lib/use-spaces.ts`: catalog loading, local cache, realtime refresh, and saves.
- `tests/`: policy and public SDK frontend tests.

See `README.md` for status definitions and draft limitations.
