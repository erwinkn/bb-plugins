#!/usr/bin/env python3
"""Read only one session's latest native env-resolution event, never auth fields.

This checks runtime configuration, not outgoing requests or upstream cache serving.
Run on the BB server's data directory; the event identifies the remote host too.
"""
import argparse
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit

ALLOWED_NAMES = (
    "ANTHROPIC_BASE_URL", "CODEX_OPENAI_BASE_URL",
    "CLAUDE_CODE_PROMPT_CACHE_TTL", "FORCE_PROMPT_CACHING_5M",
    "DISABLE_PROMPT_CACHING", "DISABLE_PROMPT_CACHING_MESSAGES",
)


def check_session(db, thread_id, host_id, plugin_id, since_ms, main_ttl,
                  expected_session_id=None):
    # Exact type/thread lookup uses the native events_thread_type_sequence index.
    # Do not fetch events.data, other event types, env arrays or auth values.
    event = db.execute("""
        SELECT e.sequence, e.created_at, e.provider_thread_id,
               env.host_id, t.provider_id
        FROM events e JOIN threads t ON t.id = e.thread_id
        LEFT JOIN environments env ON env.id = e.environment_id
        WHERE e.thread_id = ? AND e.type = 'provider.env-resolved'
        ORDER BY e.sequence DESC LIMIT 1
    """, (thread_id,)).fetchone()
    result = {"threadId": thread_id, "expectedHostId": host_id,
              "expectedPluginId": plugin_id, "envEventPresent": event is not None}
    if event is None:
        return result, False
    sequence, created_at, provider_session_id, actual_host, provider = event
    placeholders = ",".join("?" for _ in ALLOWED_NAMES)
    # SQLite filters names before returning whitelisted nonsecret values.
    rows = db.execute(f"""
        SELECT json_extract(entry.value, '$.name'),
               json_extract(entry.value, '$.value'),
               json_extract(entry.value, '$.source.plugin')
        FROM events e, json_each(e.data, '$.entries') entry
        WHERE e.thread_id = ? AND e.sequence = ?
          AND e.type = 'provider.env-resolved'
          AND json_extract(entry.value, '$.name') IN ({placeholders})
    """, (thread_id, sequence, *ALLOWED_NAMES)).fetchall()
    values = {}
    for name, value, _ in rows:
        if isinstance(value, str):
            values[name] = value
        else:
            values.pop(name, None)
    sources = {name: source for name, _, source in rows}
    provider_supported = provider in ("claude-code", "codex")
    route_name = "ANTHROPIC_BASE_URL" if provider == "claude-code" else "CODEX_OPENAI_BASE_URL"
    expected_path = f"/api/v1/plugins/{plugin_id}/http" + ("/v1" if provider == "codex" else "")
    try:
        route = urlsplit(values.get(route_name, ""))
        route_matches = (route.scheme in ("http", "https") and bool(route.netloc)
                         and route.path == expected_path and not route.query
                         and not route.fragment and sources.get(route_name) == plugin_id)
    except ValueError:
        route_matches = False
    force_5m = values.get("FORCE_PROMPT_CACHING_5M") == "1"
    caching_disabled = any(values.get(key) == "1" for key in
                           ("DISABLE_PROMPT_CACHING", "DISABLE_PROMPT_CACHING_MESSAGES"))
    explicit_ttl = values.get("CLAUDE_CODE_PROMPT_CACHE_TTL")
    effective_policy = "5m" if force_5m else explicit_ttl if explicit_ttl in ("5m", "1h") else "automatic/unknown"
    ttl_applicable = provider == "claude-code"
    if not ttl_applicable:
        ttl_matches = True
    elif main_ttl == "native":
        # Rollback verifies the fork's override is gone. Automatic client policy
        # may depend on settings/auth and is intentionally not guessed here.
        ttl_matches = sources.get("CLAUDE_CODE_PROMPT_CACHE_TTL") != "account-pool-local"
    else:
        ttl_matches = (explicit_ttl == main_ttl and effective_policy == main_ttl
                       and sources.get("CLAUDE_CODE_PROMPT_CACHE_TTL") == plugin_id
                       and not caching_disabled)
    result.update({"hostId": actual_host, "providerId": provider,
                   "providerSessionId": provider_session_id,
                   "envSequence": sequence, "envCreatedAtMs": created_at,
                   "hostMatches": actual_host == host_id,
                   "freshEnvEvent": created_at >= since_ms,
                   "providerSessionMatches": bool(provider_session_id) and (
                       expected_session_id is None or provider_session_id == expected_session_id),
                   "providerSupported": provider_supported,
                   "routeMatches": route_matches,
                   "mainTtlApplicable": ttl_applicable,
                   "mainPolicyMatches": ttl_matches,
                   "effectiveMainPolicy": effective_policy if ttl_applicable else "not-applicable",
                   "force5m": force_5m if ttl_applicable else False,
                   "cachingDisabled": caching_disabled if ttl_applicable else False})
    passed = all(result[key] for key in ("hostMatches", "freshEnvEvent",
        "providerSessionMatches", "providerSupported", "routeMatches", "mainPolicyMatches"))
    return result, passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--host-id", required=True)
    parser.add_argument("--plugin-id", choices=("account-pool", "account-pool-local"), required=True)
    parser.add_argument("--since-ms", type=int, required=True)
    parser.add_argument("--main-ttl", choices=("5m", "1h", "native"), required=True)
    parser.add_argument("--expected-session-id")
    args = parser.parse_args()
    try:
        path = (args.data_dir / "bb.db").resolve()
        with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
            db.execute("PRAGMA query_only = ON")
            result, passed = check_session(db, args.thread_id, args.host_id,
                args.plugin_id, args.since_ms, args.main_ttl, args.expected_session_id)
    except (sqlite3.Error, OSError):
        # Avoid printing database paths, raw rows or exception payloads.
        result, passed = {"checkAvailable": False}, False
    print(json.dumps(result, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
