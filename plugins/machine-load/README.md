# Machine load

`machine-load` shows the live resource load of an enrolled machine. A
three-bar gauge in the sidebar footer, next to Provider usage, shows CPU,
memory, and the fullest disk. Clicking it opens a detail panel with
sparklines, per-core load, disks, throughput, and top processes.

```sh
bb plugin install path:/home/erwin/Code/bb-plugins/plugins/machine-load --yes
```

## How it mounts beside Provider usage

The plugin registers a footer disclosure (`experimental_sidebarFooter`,
`kind: "disclosure"`), the same surface Provider usage uses. BB renders every
footer item as an icon button, and footer items accept no badge or text. To
show live values anyway, the plugin registers an app icon,
`machine-load:gauge`, whose component is the live gauge. The footer item uses
that icon name. BB resolves footer icons through its app icon registry, so the
button shows the gauge instead of a static glyph. The icon renders outside the
plugin's style scope, so it uses inline SVG colors with the host's `--warning`
and `--destructive` variables.

Footer order and visibility follow BB's "Customize footer" menu. The plugin
does not change Provider usage.

## Data path

```
browser content script ──poll every N s──▶ server RPC `load`
                                             │  shares a sample younger than ¾ N
                                             │  keeps 30 min of history per machine
                                             ▼
                                host entry `sample` on the chosen machine
                                reads /proc, /sys/class/net, statfs
```

- **Host entry (`host.ts`)**. A `bb.host` worker on each machine answers
  `sample`. It keeps the previous counters, so CPU, disk, network, and
  per-process CPU become rates. It runs no shell commands. A plain reading
  takes about 4 ms on the 96-core box. The process scan reads
  `/proc/<pid>/stat` for every process, about 65 ms for 1,200 processes, and
  runs only while a detail panel is open. Without a recent baseline it scans
  twice, 500 ms apart, so CPU figures appear right away. BB stops the worker
  after five idle minutes.
- **Server (`server.ts`, `lib/load-service.ts`)**. One RPC, `load`. It picks
  the requested machine, or BB's primary host, and reuses a fresh sample
  across clients. It coalesces concurrent calls and keeps 30 minutes of
  history in memory. Offline machines are never called. Each sample is
  stamped with the server's receive time, so a host with a skewed clock
  cannot break caching, history, or the clients' cursors. Detail requests
  waiting behind a read re-check before sampling, so they share one
  process scan.
- **Frontend (`app.tsx`, `lib/load-store.ts`)**. A content script polls while
  the window is visible. Each poll asks only for history newer than the last
  point it has. The gauge and the panel read the same module store. When the
  latest poll failed, timed out (15 s), or the server could not read the host,
  the gauge shows empty tracks rather than old bars. The panel keeps the last
  reading with an explanation.

The frontend polls instead of receiving pushes. Polling stops by itself when
no window is visible, so sampling happens only while someone is looking.
Push delivery would need a separate signal for "a client is watching", and
`useRealtime` exists only as a React hook, which the gauge icon cannot rely on
because BB renders it outside the plugin's React context.

## What counts

- **CPU**: busy share from `/proc/stat`. iowait counts as idle, and steal
  counts as busy. Guest time is already included in user time.
- **Memory**: `MemTotal − MemAvailable`, so page cache counts as available,
  as in `free`.
- **Disks**: block-device mounts from `/proc/self/mountinfo`, one per device.
  The plugin skips tmpfs, overlay, squashfs and snap loops, docker and snap
  trees, and network filesystems. It prefers the whole-filesystem mount over
  a bind of a subdirectory. Use % follows `df`: used ÷ (used + available).
- **Throughput**: disk sectors from `/proc/diskstats` for the mounted devices
  only, so `md2` is not counted again through its member disks. Network bytes
  come from interfaces that have a `/sys/class/net/<if>/device`, so bridges
  and veths do not double count. Counters are kept per device and per
  interface, and rates compare only those present in both readings, so a
  disk mounted between readings never shows up as a burst of traffic.
- **Load**: the 1-minute average divided by the core count gives the
  percentage used for the tone.
- **Processes**: top five by CPU, measured like `top` (100% = one core), and
  top five by RSS.

On other platforms the host entry falls back to `node:os`: CPU times, total
and free memory, load average, and the root filesystem. Throughput and
processes are left out there.

## Settings

`refreshSeconds` (1–60, default 3), `warningPercent` (default 80), and
`criticalPercent` (default 95). Edit them in Settings → Installed plugins or
with `bb plugin config machine-load set <key> <value>`.

## Develop

```sh
npm run typecheck
npm test
npm run build
```

The parsers in `lib/proc.ts` are pure and tested against fixture text. The
sampler takes a `SystemReader`, so tests run it against a fake machine. The
vendored dropdown in `components/ui` is copied from Provider usage compact.
