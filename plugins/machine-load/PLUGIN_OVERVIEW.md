The three-bar gauge in the sidebar footer shows the selected machine's CPU,
memory, and fullest disk at a glance. A bar turns amber at the warning
threshold and red at the critical one.

## Details

Click the gauge to open the details: CPU with a sparkline of the last 30
minutes and a per-core grid, memory (page cache counts as available, like
`free`) and swap, load averages against the core count, every real mounted
filesystem, disk and network throughput, and the top five processes by CPU or
memory. Hover a process to see its full command line. Click outside the panel
or press Escape to close it.

With more than one machine enrolled, the machine name at the top opens a
picker. It starts on the machine BB's server runs on and remembers your
choice in this browser.

## Settings

- **Refresh interval**: seconds between readings, 3 by default.
- **Warning at** and **Critical at**: percentages for the amber and red tones,
  80 and 95 by default. Load counts as a percentage of the core count.

Readings happen only while a BB window is visible. History lives in memory on
the BB server and resets when the plugin reloads.
