import { describe, expect, it } from "vitest";
import { findBbInstall, readBundleFiles } from "./lib/bb-install";
import { HOST_ANCHORS } from "./lib/host-contract";

const install = findBbInstall();

describe("installed BB bundle", () => {
  if (install === null) {
    it("is not installed here; set BB_APP_DIR or install bb-app to run the contract checks", () => {
      console.warn("github: no bb-app install found; host contract checks skipped");
    });
    return;
  }

  const js = readBundleFiles(install, ".js");

  for (const anchor of HOST_ANCHORS) {
    it(`still has ${anchor.source}`, () => {
      const missing = anchor.mustContain.filter((needle) => ![...js.values()].some((text) => text.includes(needle)));
      expect(missing, `${anchor.because}\nBB ${install.version} at ${install.root} no longer contains: ${missing.join(" | ")}`).toEqual([]);
    });
  }
});
