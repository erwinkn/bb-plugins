import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizedRejection } from "./account-rejection.js";

// Tells a person, once per account and message, that an API-key account (a gateway) refuses
// requests for a reason about the account (terms to accept, billing): the Pooler holds it and
// probes it every 15 minutes, but only someone acting upstream ends that. The messages already told
// are kept in the plugin's KV store, so a reload or a restart does not tell them again.

const KEY_PREFIX = "account-alerts:";
// The distinct messages kept per account, newest last; an older one may be told again.
const MAX_MESSAGES = 20;
const toldSchema = z.array(z.string());

export interface AccountAlert {
  accountId: string;
  label: string;
  message: string;
}

export class AccountAlerts {
  // Told or being told, so a burst of refusals (every waiting thread probing at once) sends one.
  private readonly told = new Set<string>();
  // The latest store update per account: updates of one account's list run one after another, so
  // two messages told at once both stay recorded.
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(
    private readonly kv: PluginKvStorage,
    private readonly send: (alert: AccountAlert) => void,
    private readonly log: (message: string) => void,
  ) {}

  async rejected(
    account: { id: string; label: string },
    message: string,
  ): Promise<void> {
    const normalized = normalizedRejection(message);
    const key = JSON.stringify([account.id, normalized]);
    if (this.told.has(key)) return;
    this.told.add(key);
    if (
      !(await this.afterUpdates(account.id, () =>
        this.record(account, normalized),
      ))
    )
      return;
    try {
      this.send({ accountId: account.id, label: account.label, message });
    } catch (error) {
      this.log(
        `Account Pooler could not send its alert for ${account.label}: ${errorText(error)}`,
      );
    }
  }

  // Adds the message to the account's stored list: false if it was there already (told before a
  // reload). A store that fails counts as new, so the alert still goes out.
  private async record(
    account: { id: string; label: string },
    normalized: string,
  ): Promise<boolean> {
    try {
      const stored = toldSchema.safeParse(
        await this.kv.get(KEY_PREFIX + account.id),
      );
      const previous = stored.success ? stored.data : [];
      if (previous.includes(normalized)) return false;
      await this.kv.set(
        KEY_PREFIX + account.id,
        [...previous, normalized].slice(-MAX_MESSAGES),
      );
    } catch (error) {
      this.log(
        `Account Pooler could not record its alert for ${account.label}: ${errorText(error)}`,
      );
    }
    return true;
  }

  private afterUpdates<T>(
    accountId: string,
    update: () => Promise<T>,
  ): Promise<T> {
    const result = (this.updates.get(accountId) ?? Promise.resolve()).then(
      update,
    );
    const settled = result.catch(() => undefined);
    this.updates.set(accountId, settled);
    void settled.then(() => {
      if (this.updates.get(accountId) === settled)
        this.updates.delete(accountId);
    });
    return result;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
