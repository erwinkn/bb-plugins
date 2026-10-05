import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import ts from "typescript";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createAccountPoolPlugin } from "./server.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
} from "./store.js";

const root = path.resolve(import.meta.dirname, "..");

it("packages only public SDK and local vendored UI imports", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });
  const allow = dependencies.map(
    (name) =>
      new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`),
  );
  // SDK 0.4.87's regex mistakes ordinary "import" string literals for imports.
  // Parse actual module references with TypeScript, then let the SDK enforce its
  // package/private-import policy on the normalized references at the same paths.
  const normalized = await fs.mkdtemp(path.join(tmpdir(), "bb-pool-imports-"));
  try {
    await fs.writeFile(
      path.join(normalized, "package.json"),
      JSON.stringify(manifest),
    );
    for (const file of experimental_scanPublicSdkOnly(root, { allow }).files) {
      const source = ts.createSourceFile(
        file,
        await fs.readFile(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const specifiers: string[] = [];
      function visit(node: ts.Node): void {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          specifiers.push(node.moduleSpecifier.text);
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          specifiers.push(node.argument.literal.text);
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          expect(node.arguments.length).toBe(1);
          expect(ts.isStringLiteral(node.arguments[0]!)).toBe(true);
          if (ts.isStringLiteral(node.arguments[0]!))
            specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      const destination = path.join(normalized, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(
        destination,
        specifiers
          .map((specifier) => `import ${JSON.stringify(specifier)};`)
          .join("\n"),
      );
    }
    const scan = experimental_scanPublicSdkOnly(normalized, { allow });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  } finally {
    await fs.rm(normalized, { recursive: true, force: true });
  }
});

it("loads handed-off native schemas and credential references through local provider hooks, HTTP, RPC and CLI", async () => {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-pool-handoff-"));
  const nativeHost = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
  });
  const nativeDir = path.join(dataDir, "plugins", "account-pool");
  const secretDir = path.join(nativeDir, "secrets", "accounts");
  const now = 1_800_000_000_000;
  const store = new AccountStore(nativeHost.bb.storage.kv, secretDir);
  const account = await store.add(
    {
      provider: "claude",
      kind: "api-key",
      label: "disposable fixture",
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    },
    { kind: "api-key", apiKey: "nonsecret-fixture" },
  );
  const codex = await store.add(
    {
      provider: "codex",
      kind: "oauth",
      label: "disposable codex fixture",
      email: null,
      accountUuid: null,
      codexAccountId: "fixture-codex",
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    },
    {
      kind: "oauth",
      accessToken: "nonsecret-access",
      refreshToken: "nonsecret-refresh",
      expiresAt: now + 3_600_000,
    },
  );
  const tokens = new HubTokenStore(secretDir, () => now);
  const token = await tokens.forHost("fixture-host");
  await nativeHost.bb.storage.kv.set("config", { switchThreshold: 0.98 });
  await nativeHost.bb.storage.kv.set("routing.claude", true);
  await nativeHost.bb.storage.kv.set("routing.codex", false);
  await nativeHost.bb.storage.kv.set("bypass:excluded", true);
  const database = new Database(path.join(nativeDir, "data.db"));
  nativeHost.bb.storage.migrate(database, QUOTA_MIGRATIONS);
  const affinityKey = JSON.stringify([
    "claude",
    "fixture-host",
    "fixture-session",
  ]);
  const affinity = new PoolAffinityStore(database);
  affinity.putBinding(affinityKey, {
    accountId: account.id,
    lastUsedAt: now - 45 * 60_000,
  });
  affinity.putActiveAccount("claude", account.id);
  const quotas = new QuotaStore(database);
  quotas.put({
    ...quotas.get(account.id),
    fiveHourUtilization: 0.5,
    observedAt: now,
  });
  database.close();
  const core = new Database(path.join(dataDir, "bb.db"));
  core.exec(`CREATE TABLE plugins(id TEXT PRIMARY KEY, enabled INTEGER, removed_at INTEGER);
    CREATE TABLE plugin_kv(plugin_id TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(plugin_id,key));
    INSERT INTO plugins VALUES('account-pool',0,NULL);`);
  for (const key of await nativeHost.bb.storage.kv.list())
    core
      .prepare("INSERT INTO plugin_kv VALUES (?,?,?,?)")
      .run(
        "account-pool",
        key,
        JSON.stringify(await nativeHost.bb.storage.kv.get(key)),
        now,
      );
  core.close();
  let localHost: ReturnType<typeof createFakePluginHost> | null = null;
  let service: ReturnType<
    typeof nativeHost.harness.behavior.runService
  > | null = null;
  try {
    await promisify(execFile)("python3", [
      path.join(root, "scripts/copy-pool-state.py"),
      "--data-dir",
      dataDir,
      "--from",
      "account-pool",
      "--to",
      "account-pool-local",
      "--backup-dir",
      path.join(dataDir, "handoff-backup"),
      "--quiescent",
    ]);
    let attempts = 0;
    let codexAttempts = 0;
    localHost = createFakePluginHost({
      pluginId: "account-pool-local",
      dataDir,
      sdk: {
        hosts: { list: async () => [{ id: "fixture-host", name: "fixture" }] },
        plugins: {
          list: async () => ({
            plugins: [
              { id: "account-pool", enabled: false },
              { id: "account-pool-local", enabled: true },
            ],
          }),
        },
        system: { providerStates: async () => ({ providers: [] }) },
      },
    });
    const copiedCore = new Database(path.join(dataDir, "bb.db"), {
      readonly: true,
    });
    const rows = copiedCore
      .prepare(
        "SELECT key,value FROM plugin_kv WHERE plugin_id='account-pool-local'",
      )
      .all() as Array<{ key: string; value: string }>;
    for (const row of rows)
      await localHost.bb.storage.kv.set(row.key, JSON.parse(row.value));
    copiedCore.close();
    // Harness DB lives in its own temporary directory; install the copied native snapshot there.
    const targetHandle = localHost.bb.storage.database();
    const targetPath = targetHandle.name;
    targetHandle.close();
    await fs.copyFile(
      path.join(dataDir, "plugins/account-pool-local/data.db"),
      targetPath,
    );
    await createAccountPoolPlugin({
      now: () => now,
      fetch: async (input) => {
        if (String(input).endsWith("/v1/messages")) attempts++;
        if (String(input).endsWith("/responses")) codexAttempts++;
        return Response.json({});
      },
    })(localHost.bb);
    const config = await localHost.harness.behavior.callRpc("config.get", null);
    expect(config).toMatchObject({
      claudeMainCacheTtl: "1h",
      sessionAffinityIdleMinutes: 60,
    });
    const list = (await localHost.harness.behavior.callRpc(
      "account.list",
      null,
    )) as Array<{ id: string; fiveHourUtilization: number }>;
    expect(list).toHaveLength(2);
    expect(list.find((row) => row.id === account.id)).toMatchObject({
      id: account.id,
      fiveHourUtilization: 0.5,
    });
    const context = {
      threadId: "fixture-thread",
      projectId: "fixture-project",
      hostId: "fixture-host",
    };
    const entries = await localHost.harness.behavior.resolveProviderEnv(
      "claude-code",
      context,
    );
    expect(
      entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")?.value,
    ).toBe(token);
    expect(
      entries.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value,
    ).toEqual({ serverPath: "/api/v1/plugins/account-pool-local/http" });
    expect(
      await localHost.harness.behavior.resolveProviderEnv("claude-code", {
        ...context,
        threadId: "excluded",
      }),
    ).toEqual([]);
    expect(
      await localHost.harness.behavior.resolveProviderEnv("codex", context),
    ).toEqual([]);
    await localHost.harness.behavior.callRpc("routing.set", {
      provider: "codex",
      enabled: true,
    });
    const codexEntries = await localHost.harness.behavior.resolveProviderEnv(
      "codex",
      context,
    );
    expect(
      codexEntries.find((entry) => entry.name === "CODEX_OPENAI_BASE_URL")
        ?.value,
    ).toEqual({ serverPath: "/api/v1/plugins/account-pool-local/http/v1" });
    expect(
      codexEntries.find((entry) => entry.name === "CODEX_POOL_AUTH_TOKEN")
        ?.value,
    ).toBe(token);
    expect(codexEntries.some((entry) => /PROMPT_CACHE/.test(entry.name))).toBe(
      false,
    );
    service = localHost.harness.behavior.runService("hub");
    await vi.waitFor(async () =>
      expect(
        await localHost!.harness.behavior.callRpc("status.get", null),
      ).toMatchObject({ accepting: true }),
    );
    const restored = new PoolAffinityStore(localHost.bb.storage.database());
    expect(
      restored.loadBindings(now - 60 * 60_000, 4096).get(affinityKey)
        ?.accountId,
    ).toBe(account.id);
    expect(restored.loadActiveAccounts().get("claude")?.accountId).toBe(
      account.id,
    );
    const response = await localHost.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-5",
          metadata: {
            user_id: JSON.stringify({ session_id: "fixture-session" }),
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(attempts).toBe(1);
    const codexResponse = await localHost.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "session-id": "codex-fixture",
        },
        body: JSON.stringify({ model: "gpt-6", input: [] }),
      },
    );
    expect(codexResponse.status).toBe(200);
    await codexResponse.text();
    expect(codexAttempts).toBe(1);
    expect(restored.loadActiveAccounts().get("codex")?.accountId).toBe(
      codex.id,
    );
    const cli = await localHost.harness.behavior.runCli(["status", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout).route).toBe(
      "/api/v1/plugins/account-pool-local/http",
    );
    expect(localHost.harness.registrations.cli?.name).toBe("pool-local");
  } finally {
    service?.controller.abort();
    await service?.done;
    await localHost?.harness.lifecycle.dispose();
    await nativeHost.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
