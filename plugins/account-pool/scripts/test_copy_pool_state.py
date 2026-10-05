import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("copy_pool_state", Path(__file__).with_name("copy-pool-state.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PoolHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "bb"
        self.data.mkdir()
        with sqlite3.connect(self.data / "bb.db") as db:
            db.executescript("""
              CREATE TABLE plugins(id TEXT PRIMARY KEY, enabled INTEGER, removed_at INTEGER);
              CREATE TABLE plugin_kv(plugin_id TEXT, key TEXT, value TEXT, updated_at INTEGER, PRIMARY KEY(plugin_id,key));
              CREATE TABLE plugin_settings(plugin_id TEXT, key TEXT, value TEXT);
              CREATE TABLE plugin_schedules(plugin_id TEXT, name TEXT);
              INSERT INTO plugins VALUES('account-pool',0,NULL);
              INSERT INTO plugins VALUES('unrelated',1,NULL);
              INSERT INTO plugin_kv VALUES('unrelated','keep','123',1);
            """)
            rows = {
                "accounts:v1": [{"id": "11111111-1111-4111-8111-111111111111", "enabled": True}],
                "config": {"switchThreshold": 0.98},
                "routing.claude": True, "routing.codex": False,
                "bypass:fixture-thread": True,
                "routed:fixture-thread": {"hostId": "fixture-host", "routedAt": 1},
            }
            db.executemany("INSERT INTO plugin_kv VALUES('account-pool',?,?,1)", [(k, json.dumps(v)) for k, v in rows.items()])
        original = self.data / "plugins/account-pool"
        secrets = original / "secrets/accounts"
        secrets.mkdir(parents=True)
        (secrets / "account-11111111-1111-4111-8111-111111111111.json").write_text("nonsecret credential reference fixture")
        (secrets / "hub-token-fixture-host.json").write_text("nonsecret host-token fixture")
        with sqlite3.connect(original / "data.db") as db:
            db.executescript("""
              CREATE TABLE pool_affinity(key TEXT PRIMARY KEY, account_id TEXT, last_used_at INTEGER);
              CREATE TABLE pool_active_account(provider TEXT PRIMARY KEY, account_id TEXT);
              CREATE TABLE account_quota(account_id TEXT, utilization REAL);
              CREATE TABLE __plugin_migrations(id INTEGER);
              INSERT INTO pool_affinity VALUES('["claude","fixture-host","session-A"]','11111111-1111-4111-8111-111111111111',60);
              INSERT INTO pool_active_account VALUES('claude','11111111-1111-4111-8111-111111111111');
              INSERT INTO account_quota VALUES('11111111-1111-4111-8111-111111111111',0.5);
              INSERT INTO __plugin_migrations VALUES(1);
            """)

    def copy(self, source="account-pool", target="account-pool-local", backup="backup", **kwargs):
        return module.copy_pool_state(self.data, source, target, self.root / backup, quiescent=True, **kwargs)

    def test_forward_mapping_preserves_original_and_unrelated_state(self):
        original = self.data / "plugins/account-pool"
        before = {str(p.relative_to(original)): p.read_bytes() for p in original.rglob("*") if p.is_file()}
        result = self.copy()
        self.assertEqual(result["kvRows"], 6)
        local = self.data / "plugins/account-pool-local"
        with sqlite3.connect(self.data / "bb.db") as db:
            source = db.execute("SELECT key,value,updated_at FROM plugin_kv WHERE plugin_id='account-pool' ORDER BY key").fetchall()
            target = db.execute("SELECT key,value,updated_at FROM plugin_kv WHERE plugin_id='account-pool-local' ORDER BY key").fetchall()
            self.assertEqual(source, target)
            self.assertEqual(db.execute("SELECT value FROM plugin_kv WHERE plugin_id='unrelated'").fetchone(), ("123",))
            self.assertEqual(db.execute("SELECT enabled FROM plugins WHERE id='account-pool'").fetchone(), (0,))
        with sqlite3.connect(local / "data.db") as db:
            self.assertEqual(db.execute("SELECT * FROM pool_active_account").fetchall(), [("claude", "11111111-1111-4111-8111-111111111111")])
            self.assertEqual(db.execute("SELECT account_id FROM pool_affinity").fetchall(), [("11111111-1111-4111-8111-111111111111",)])
            self.assertEqual(db.execute("SELECT * FROM account_quota").fetchall(), [("11111111-1111-4111-8111-111111111111", 0.5)])
            self.assertEqual(db.execute("SELECT * FROM __plugin_migrations").fetchall(), [(1,)])
        after = {str(p.relative_to(original)): p.read_bytes() for p in original.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        for relative in ["secrets/accounts/account-11111111-1111-4111-8111-111111111111.json", "secrets/accounts/hub-token-fixture-host.json"]:
            self.assertEqual((local / relative).read_bytes(), before[relative])
            self.assertEqual((local / relative).stat().st_mode & 0o777, 0o600)

    def test_opt_in_feature_records_are_not_copied(self):
        with sqlite3.connect(self.data / "bb.db") as db:
            db.executemany("INSERT INTO plugin_kv VALUES('account-pool',?,?,1)", [
                ("advisor-config", json.dumps({"routes": {"claude": True, "codex": True}, "maxUtilization": None})),
                ("warming-config", json.dumps({"mode": "warm"})),
            ])
        result = self.copy()
        self.assertEqual(result["kvRows"], 6)
        self.assertEqual(result["skippedKeys"], ["advisor-config", "warming-config"])
        with sqlite3.connect(self.data / "bb.db") as db:
            keys = [row[0] for row in db.execute("SELECT key FROM plugin_kv WHERE plugin_id='account-pool-local' ORDER BY key")]
            source = [row[0] for row in db.execute("SELECT key FROM plugin_kv WHERE plugin_id='account-pool' ORDER BY key")]
        self.assertNotIn("advisor-config", keys)
        self.assertNotIn("warming-config", keys)
        self.assertIn("advisor-config", source)
        self.assertIn("warming-config", source)
        backed_up = {key for key, _, _ in json.loads((self.root / "backup/source-kv.json").read_text())}
        self.assertTrue({"advisor-config", "warming-config"} <= backed_up)

    def test_rollback_uses_current_refreshed_state_and_strips_local_config(self):
        self.copy()
        local = self.data / "plugins/account-pool-local"
        credential = local / "secrets/accounts/account-11111111-1111-4111-8111-111111111111.json"
        credential.write_text("nonsecret refreshed credential fixture")
        with sqlite3.connect(self.data / "bb.db") as db:
            db.execute("INSERT INTO plugins VALUES('account-pool-local',0,NULL)")
            db.execute("UPDATE plugin_kv SET value=? WHERE plugin_id='account-pool-local' AND key='config'", (json.dumps({"switchThreshold": 0.9, "claudeMainCacheTtl": "1h", "sessionAffinityIdleMinutes": 90}),))
        self.copy("account-pool-local", "account-pool", "rollback", replace_target=True)
        original = self.data / "plugins/account-pool"
        self.assertEqual((original / "secrets/accounts/account-11111111-1111-4111-8111-111111111111.json").read_text(), credential.read_text())
        self.assertTrue((self.root / "rollback/target-original/data.db").exists())
        with sqlite3.connect(self.data / "bb.db") as db:
            config = json.loads(db.execute("SELECT value FROM plugin_kv WHERE plugin_id='account-pool' AND key='config'").fetchone()[0])
            self.assertEqual(config, {"switchThreshold": 0.9})
            self.assertEqual(db.execute("SELECT value FROM plugin_kv WHERE plugin_id='unrelated'").fetchone(), ("123",))

    def test_refuses_active_pool_missing_confirmation_and_existing_destination(self):
        with self.assertRaisesRegex(ValueError, "quiescent"):
            module.copy_pool_state(self.data, "account-pool", "account-pool-local", self.root / "no-confirm")
        with sqlite3.connect(self.data / "bb.db") as db:
            db.execute("UPDATE plugins SET enabled=1 WHERE id='account-pool'")
        with self.assertRaisesRegex(ValueError, "disabled"):
            self.copy(backup="active")
        with sqlite3.connect(self.data / "bb.db") as db:
            db.execute("UPDATE plugins SET enabled=0 WHERE id='account-pool'")
        self.copy()
        with self.assertRaisesRegex(ValueError, "already has state"):
            self.copy(backup="duplicate")

    def test_refuses_unmapped_settings_and_linked_credentials(self):
        with sqlite3.connect(self.data / "bb.db") as db:
            db.execute("INSERT INTO plugin_settings VALUES('account-pool','unknown','1')")
        with self.assertRaisesRegex(ValueError, "settings/schedules"):
            self.copy(backup="settings")
        with sqlite3.connect(self.data / "bb.db") as db:
            db.execute("DELETE FROM plugin_settings")
        (self.data / "plugins/account-pool/secrets/accounts/linked").symlink_to(self.root / "outside")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.copy(backup="linked")
        self.assertFalse((self.data / "plugins/account-pool-local").exists())


if __name__ == "__main__":
    unittest.main()
