import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AccountAlerts, type AccountAlert } from "./account-alerts.js";

const TERMS =
  "We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue.";
const GATEWAY = {
  id: "3db11ae0-ae8a-41ad-bcd9-9ba043cf57fa",
  label: "Equisafe gateway",
};

function memoryKv(): PluginKvStorage {
  const values = new Map<string, unknown>();
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    list: async (prefix = "") =>
      [...values.keys()].filter((key) => key.startsWith(prefix)),
  } as unknown as PluginKvStorage;
}

function alerts(kv: PluginKvStorage) {
  const sent: AccountAlert[] = [];
  const logs: string[] = [];
  return {
    alerts: new AccountAlerts(
      kv,
      (alert) => sent.push(alert),
      (line) => logs.push(line),
    ),
    sent,
    logs,
  };
}

describe("AccountAlerts", () => {
  it("tells each account's message once, across a burst of refusals and a reload", async () => {
    const kv = memoryKv();
    const first = alerts(kv);
    // Every waiting thread probes the gateway at once at the hold's end.
    await Promise.all(
      [1, 2, 3].map(() => first.alerts.rejected(GATEWAY, TERMS)),
    );
    await first.alerts.rejected(GATEWAY, TERMS.toUpperCase());
    expect(first.sent).toEqual([
      { accountId: GATEWAY.id, label: GATEWAY.label, message: TERMS },
    ]);
    // A reload starts with an empty memory and reads what was told from the store.
    const reloaded = alerts(kv);
    await reloaded.alerts.rejected(GATEWAY, TERMS);
    expect(reloaded.sent).toEqual([]);
  });

  it("tells another message, or the same message from another account", async () => {
    const { alerts: subject, sent } = alerts(memoryKv());
    await subject.rejected(GATEWAY, TERMS);
    await subject.rejected(GATEWAY, "This organization has been disabled.");
    await subject.rejected({ id: "other", label: "Other gateway" }, TERMS);
    expect(sent.map(({ label, message }) => [label, message])).toEqual([
      ["Equisafe gateway", TERMS],
      ["Equisafe gateway", "This organization has been disabled."],
      ["Other gateway", TERMS],
    ]);
  });

  it("keeps both of two messages told at once, so a reload tells neither again", async () => {
    const kv = memoryKv();
    const first = alerts(kv);
    const credits =
      "Your credit balance is too low to access the Anthropic API.";
    await Promise.all([
      first.alerts.rejected(GATEWAY, TERMS),
      first.alerts.rejected(GATEWAY, credits),
    ]);
    expect(first.sent).toHaveLength(2);
    const reloaded = alerts(kv);
    await reloaded.alerts.rejected(GATEWAY, TERMS);
    await reloaded.alerts.rejected(GATEWAY, credits);
    expect(reloaded.sent).toEqual([]);
  });

  it("still tells when the store fails, and never throws", async () => {
    const broken = {
      get: async () => Promise.reject(new Error("disk full")),
      set: async () => Promise.reject(new Error("disk full")),
    } as unknown as PluginKvStorage;
    const sent: AccountAlert[] = [];
    const logs: string[] = [];
    const subject = new AccountAlerts(
      broken,
      (alert) => {
        sent.push(alert);
        throw new Error("no window");
      },
      (line) => logs.push(line),
    );
    await expect(subject.rejected(GATEWAY, TERMS)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(logs).toEqual([
      expect.stringContaining("disk full"),
      expect.stringContaining("no window"),
    ]);
  });
});
