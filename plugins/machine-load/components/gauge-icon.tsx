import { useSyncExternalStore } from "react";
import type { LoadSettings, Sample } from "../lib/contract.js";
import { percentOf, toneFor, type Tone } from "../lib/format.js";
import type { LoadStore } from "../lib/load-store.js";

/**
 * The footer button's icon: three bars for CPU, memory, and the fullest disk.
 * BB renders it outside the plugin's style scope, so it styles itself inline
 * and takes its colors from the host's CSS variables.
 */
export interface GaugeLevels {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

export function gaugeLevels(sample: Sample | null): GaugeLevels {
  if (sample === null) return { cpu: null, memory: null, disk: null };
  const { totalBytes, availableBytes } = sample.memory;
  const disks = sample.disks
    .map((disk) => percentOf(disk.usedBytes, disk.usedBytes + disk.availableBytes))
    .filter((value) => value !== null);
  return {
    cpu: sample.cpu.percent,
    memory: percentOf(totalBytes - availableBytes, totalBytes),
    disk: disks.length === 0 ? null : Math.max(...disks),
  };
}

const TONE_COLOR: Record<Tone, string> = {
  normal: "currentColor",
  warning: "var(--warning)",
  critical: "var(--destructive)",
};

const BAR_TOP = 2;
const BAR_HEIGHT = 12;
const BAR_WIDTH = 3;
const BAR_X = [2, 6.5, 11];

function Bar({ x, percent, settings }: { x: number; percent: number | null; settings: LoadSettings | null }) {
  const height = percent === null ? 0 : Math.max(1, (Math.min(100, percent) / 100) * BAR_HEIGHT);
  const tone = settings === null ? "normal" : toneFor(percent, settings);
  return (
    <>
      <rect x={x} y={BAR_TOP} width={BAR_WIDTH} height={BAR_HEIGHT} rx={1} fill="currentColor" opacity={0.25} />
      {height === 0 ? null : (
        <rect
          data-gauge-tone={tone}
          x={x}
          y={BAR_TOP + BAR_HEIGHT - height}
          width={BAR_WIDTH}
          height={height}
          rx={1}
          fill={TONE_COLOR[tone]}
        />
      )}
    </>
  );
}

export function createGaugeIcon(store: LoadStore) {
  return function MachineLoadGauge({ className }: { className?: string }) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const result = snapshot.result;
    // Offline machines, failed host reads, and failed or hung polls all leave
    // only an old reading; empty tracks say "no current value" instead.
    const connected = result?.machines.find((machine) => machine.id === result.machineId)?.connected === true;
    const current = connected && result?.error === null && snapshot.error === null;
    const levels = gaugeLevels(current ? (result?.sample ?? null) : null);
    const settings = result?.settings ?? null;
    return (
      <svg
        viewBox="0 0 16 16"
        className={className}
        aria-hidden="true"
        data-machine-load-gauge={current ? "current" : "stale"}
      >
        <Bar x={BAR_X[0]!} percent={levels.cpu} settings={settings} />
        <Bar x={BAR_X[1]!} percent={levels.memory} settings={settings} />
        <Bar x={BAR_X[2]!} percent={levels.disk} settings={settings} />
      </svg>
    );
  };
}
