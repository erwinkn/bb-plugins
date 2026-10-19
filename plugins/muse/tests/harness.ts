import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { MUSE_EXECUTABLE_ENV } from "../src/vocabulary.js";

export const FAKE_MUSE = join(import.meta.dirname, "fake-muse.mjs");

/** bb's `/compact`: a text part carrying the builtin command mention. */
export const COMPACT_INPUT: PromptInput[] = [
  {
    type: "text",
    text: "/compact",
    mentions: [
      {
        start: 0,
        end: 8,
        resource: { kind: "command", trigger: "/", name: "compact", source: "command", origin: "builtin", label: "compact", argumentHint: null },
      },
    ],
  },
];

/** Point the bridge at the scripted `muse serve` and log what it receives. */
export function useFakeMuse(): { frames: () => Array<Record<string, unknown>> } {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bb-muse-fake-"));
    process.env[MUSE_EXECUTABLE_ENV] = FAKE_MUSE;
    process.env.FAKE_MUSE_LOG = join(dir, "frames.ndjson");
  });
  afterAll(() => {
    delete process.env[MUSE_EXECUTABLE_ENV];
    delete process.env.FAKE_MUSE_LOG;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    frames: () => {
      try {
        return readFileSync(join(dir, "frames.ndjson"), "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
  };
}
