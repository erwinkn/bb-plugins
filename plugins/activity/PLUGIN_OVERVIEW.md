# Threads plugin

- `app.tsx`: sidebar registration, sorting, and group rendering.
- `lib/status.ts`: pure status rules and within-group order.
- `lib/client-state.ts`: versioned per-client preferences and draft flags.
- `components/draft-observer.tsx`: public composer-state observation.
- `components/thread-row.tsx`: native thread navigation and actions.
- `components/menus.tsx`: grouping, date sorting, and status visibility controls.
- `server.ts`: empty backend; no database, tools, schedules, or network requests.
- `tests/`: policy and public SDK frontend tests.

See `README.md` for status definitions and draft limitations.
