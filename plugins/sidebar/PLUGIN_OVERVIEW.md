# Threads plugin

- `app.tsx`: sidebar registration and the one view: the Adventures section,
  then the Other threads entry with its sorting and group rendering.
- `components/project-mode.tsx`: the Adventures section (rows, reordering,
  open/closed state, the tree read that carries the worker facts).
- `components/adventure-workers.tsx`: an open Adventure's worker rows (by
  state or in one list), their child-thread toggles, the coordinator's other
  threads.
- `lib/adventure-rows.ts`: which threads an open Adventure lists and each
  worker's group, from the tree, BB's threads and the worker facts.
- `lib/adventure-workers.ts`: worker facts (model, group) from the Adventures
  overview, by the Workers tab's rules, and the model label.
- `lib/adventure-workers-server.ts`: the server's bounded, shared cache of
  worker facts for the Adventures clients have open.
- `lib/status.ts`: pure status rules and within-group order.
- `lib/thread-tree.ts`: parent/child nesting, sibling order, and family status.
- `lib/client-state.ts`: versioned per-client preferences (the thread list's
  grouping and order), archive visibility, and draft flags.
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
  controls for Other threads; worker grouping and order for the Adventures.
- `lib/ui-preferences-schema.ts`: the two BB sidebar preferences the plugin
  mirrors (collapsed Pinned and project groups), shared by server and frontend.
- `lib/ui-preferences-contract.ts`, `lib/ui-preferences-store.ts`: read and
  compare-and-swap write RPCs over `bb.sdk.system.uiPreferences`, with a
  realtime signal per write.
- `lib/use-ui-preferences.ts`: applies BB's preferences to client state on
  mount, focus, and reconnect, and writes local changes through.
- `components/project-forms.tsx`: inline rename and remove forms.
- `components/inline-form.tsx`: shared inline form (focus, Escape, errors).
- `components/project-header-menu.tsx`: right-click/long-press menu on project
  group headers.
- `server.ts`: archive list and restore RPCs through BB, with change signals.
- `lib/archive-contract.ts`: validated archive RPC contract.
- `lib/use-archives.ts`: paged archive loading and refresh handling.
- `lib/project-schema.ts`, `lib/project-contract.ts`, `lib/projects-rpc.ts`:
  project rename and removal RPCs over `bb.sdk.projects`.
- `lib/nesting-contract.ts`: `setParent` RPC; reparents and unpins a pinned
  source first, mirroring bb's own unpin-then-reparent.
- `lib/thread-dnd.ts`: pure drag decision logic ported from bb's sidebar
  (activation, center-band nesting, rejection states); group drops replace bb's
  section moves.
- `lib/use-reorder-dnd.ts`: bb's sensor setup, click suppression, vertical-axis
  lock, and Escape cancel (mouse 4 px, touch 200 ms hold); the keyboard sensor
  is replaced by menu actions.
- `lib/use-thread-dnd.ts`, `lib/thread-dnd-context.ts`: drag session state
  (armed nest target, group hover, dwell expansion) shared with rows and group
  containers.
- `components/thread-drag-overlay.tsx`: the floating row card while dragging.
- `tests/`: policy and public SDK frontend tests.

See `README.md` for status definitions and draft limitations.
