import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location("check_session_env", Path(__file__).with_name("check-session-env.py"))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class CheckSessionEnvTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE threads (id TEXT, provider_id TEXT);
            CREATE TABLE environments (id TEXT, host_id TEXT);
            CREATE TABLE events (thread_id TEXT, environment_id TEXT, sequence INTEGER,
                created_at INTEGER, provider_thread_id TEXT, type TEXT, data TEXT);
            CREATE INDEX events_thread_type_sequence_idx ON events(thread_id,type,sequence);
            INSERT INTO threads VALUES ('claude-a','claude-code'),('codex-b','codex');
            INSERT INTO environments VALUES ('env-a','host-a'),('env-b','host-b');
        """)

    def event(self, thread="claude-a", seq=1, time=100, plugin="account-pool-local", ttl="1h", extra=()):
        codex = thread == "codex-b"
        entries = [{"name": "CODEX_OPENAI_BASE_URL" if codex else "ANTHROPIC_BASE_URL",
                    "value": f"https://example.invalid/api/v1/plugins/{plugin}/http" + ("/v1" if codex else ""),
                    "source": {"plugin": plugin}},
                   {"name": "ANTHROPIC_AUTH_TOKEN", "value": "SYNTHETIC-NEVER-RETURN"},
                   {"name": "CODEX_POOL_AUTH_TOKEN", "value": "SYNTHETIC-NEVER-RETURN"}]
        if ttl is not None:
            entries.append({"name": "CLAUDE_CODE_PROMPT_CACHE_TTL", "value": ttl, "source": {"plugin": plugin}})
        entries.extend(extra)
        self.db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?)", (
            thread, "env-b" if codex else "env-a", seq, time, "session-b" if codex else "session-a",
            "provider.env-resolved", json.dumps({"entries": entries})))

    def check(self, thread="claude-a", host="host-a", plugin="account-pool-local", since=100, ttl="1h", session="session-a"):
        return checker.check_session(self.db, thread, host, plugin, since, ttl, session)

    def test_distinct_hosts_sessions_and_only_nonsecret_metadata(self):
        self.event(); self.event(thread="codex-b")
        result, passed = self.check(); self.assertTrue(passed)
        self.assertEqual(result["effectiveMainPolicy"], "1h")
        self.assertNotIn("SYNTHETIC-NEVER-RETURN", json.dumps(result))
        result, passed = self.check(thread="codex-b", host="host-b", session="session-b")
        self.assertTrue(passed); self.assertFalse(result["mainTtlApplicable"])
        self.assertFalse(self.check(host="host-b")[1]); self.assertFalse(self.check(session="session-b")[1])

    def test_freshness_latest_event_and_wrong_route_fail_closed(self):
        self.event(time=99); self.assertFalse(self.check()[1])
        self.event(seq=2, time=100, plugin="account-pool"); self.assertFalse(self.check()[1])
        self.event(seq=3, time=101); self.assertTrue(self.check()[1])
        self.assertFalse(self.check(thread="missing")[1])

    def test_force_flag_disabled_cache_and_masked_route(self):
        self.event(extra=[{"name": "FORCE_PROMPT_CACHING_5M", "value": "1"}])
        result, passed = self.check(); self.assertFalse(passed)
        self.assertEqual(result["effectiveMainPolicy"], "5m")
        self.event(seq=2, extra=[{"name": "DISABLE_PROMPT_CACHING", "value": "1"}])
        self.assertFalse(self.check()[1])
        self.event(seq=3, extra=[{"name": "ANTHROPIC_BASE_URL", "value": {"masked": True}}])
        self.assertFalse(self.check()[1])

    def test_rollback_native_override_and_independent_expected_five_minutes(self):
        self.event(plugin="account-pool", ttl=None)
        result, passed = self.check(plugin="account-pool", ttl="native"); self.assertTrue(passed)
        self.assertEqual(result["effectiveMainPolicy"], "automatic/unknown")
        self.event(seq=2, ttl="5m"); self.assertTrue(self.check(ttl="5m")[1])
        self.assertFalse(self.check(ttl="1h")[1])


if __name__ == "__main__":
    unittest.main()
