#!/usr/bin/env python3
"""Root-operated namespace handoff. Never invoke this against an active pool."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import uuid

IDS = {"account-pool", "account-pool-local"}
LOCAL_CONFIG_KEYS = {"claudeMainCacheTtl", "sessionAffinityIdleMinutes"}
# Opt-in features stay off in the destination: a handoff never turns advisor routes or cache
# warming on for a new install.
LOCAL_ONLY_KEYS = {"advisor-config", "warming-config"}


def readonly_database(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def snapshot(directory, destination):
    destination.mkdir(mode=0o700)
    if directory.is_symlink():
        raise ValueError("Pool directories must not be symlinks.")
    database = directory / "data.db"
    if database.exists():
        if database.is_symlink():
            raise ValueError("Pool database must not be a symlink.")
        with readonly_database(database) as source, sqlite3.connect(destination / "data.db") as target:
            source.backup(target)
        os.chmod(destination / "data.db", 0o600)
    secrets = directory / "secrets"
    if secrets.exists():
        if secrets.is_symlink() or any(p.is_symlink() for p in secrets.rglob("*")):
            raise ValueError("Secret files must not be symlinks.")
        shutil.copytree(secrets, destination / "secrets")
        for p in (destination / "secrets").rglob("*"):
            os.chmod(p, 0o700 if p.is_dir() else 0o600)
        os.chmod(destination / "secrets", 0o700)


def save_rows(path, rows):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(rows, output)


def copy_pool_state(data_dir, source_id, target_id, backup_dir, *, quiescent=False, replace_target=False):
    if not quiescent:
        raise ValueError("Confirm all Claude/Codex sessions and pool requests are quiescent with --quiescent.")
    if {source_id, target_id} != IDS:
        raise ValueError("Only builtin/local Account Pooler handoffs are supported.")
    data_dir, backup_dir = Path(data_dir).resolve(), Path(backup_dir).absolute()
    pool_root = data_dir / "plugins"
    if pool_root.is_symlink():
        raise ValueError("Plugin data root must not be a symlink.")
    source_dir, target_dir = pool_root / source_id, pool_root / target_id
    if backup_dir.exists() or backup_dir.resolve().is_relative_to(pool_root):
        raise ValueError("Use a new backup directory outside the plugin data root.")
    backup_dir.mkdir(parents=True, mode=0o700)
    os.chmod(backup_dir, 0o700)
    stage = None
    moved_target = False
    installed_stage = False
    db = None
    try:
        db = sqlite3.connect((data_dir / "bb.db").resolve().as_uri() + "?mode=rw", uri=True)
        db.execute("BEGIN IMMEDIATE")
        for plugin_id in [source_id, target_id]:
            row = db.execute("SELECT enabled, removed_at FROM plugins WHERE id = ?", (plugin_id,)).fetchone()
            if plugin_id == source_id and (row is None or row[1] is not None):
                raise ValueError("Source plugin must be installed.")
            if row is not None and row[1] is None and row[0]:
                raise ValueError("Both pool plugins must be disabled before copying.")
            # This release keeps config in KV; none of its settings or schedules may need remapping.
            for table in ["plugin_settings", "plugin_schedules"]:
                exists = db.execute("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'", (table,)).fetchone()
                if exists and db.execute(f"SELECT 1 FROM {table} WHERE plugin_id = ? LIMIT 1", (plugin_id,)).fetchone():
                    raise ValueError("Unexpected settings/schedules need a separate compatibility review.")
        if not source_dir.is_dir() or source_dir.is_symlink() or not (source_dir / "data.db").is_file():
            raise ValueError("Source pool data.db is missing or linked.")
        rows = db.execute("SELECT key, value, updated_at FROM plugin_kv WHERE plugin_id = ? ORDER BY key", (source_id,)).fetchall()
        old_rows = db.execute("SELECT key, value, updated_at FROM plugin_kv WHERE plugin_id = ? ORDER BY key", (target_id,)).fetchall()
        if not replace_target and (target_dir.exists() or old_rows):
            raise ValueError("Destination already has state; use an explicit --replace-target with a new backup.")
        account_index = next((value for key, value, _ in rows if key == "accounts:v1"), "[]")
        for account in json.loads(account_index):
            account_id = account["id"]
            if str(uuid.UUID(account_id)) != account_id.lower():
                raise ValueError("Source account index has a noncanonical account ID.")
            reference = source_dir / "secrets" / "accounts" / f"account-{account_id}.json"
            if not reference.is_file() or reference.is_symlink():
                raise ValueError("An account credential reference is missing or linked.")
        snapshot(source_dir, backup_dir / "source")
        save_rows(backup_dir / "source-kv.json", rows)
        save_rows(backup_dir / "target-kv.json", old_rows)
        stage = Path(tempfile.mkdtemp(prefix=f".{target_id}-handoff-", dir=pool_root))
        # snapshot creates its destination; use a child so partial preparation never replaces the target.
        prepared = stage / "prepared"
        snapshot(source_dir, prepared)
        mapped = []
        for key, value, updated_at in rows:
            if key in LOCAL_ONLY_KEYS:
                continue
            if key == "config" and target_id == "account-pool":
                config = json.loads(value)
                for local_key in LOCAL_CONFIG_KEYS:
                    config.pop(local_key, None)
                value = json.dumps(config, separators=(",", ":"))
            mapped.append((target_id, key, value, updated_at))
        if target_dir.exists():
            if target_dir.is_symlink():
                raise ValueError("Destination must not be a symlink.")
            target_dir.rename(backup_dir / "target-original")
            moved_target = True
        prepared.rename(target_dir)
        installed_stage = True
        db.execute("DELETE FROM plugin_kv WHERE plugin_id = ?", (target_id,))
        db.executemany("INSERT INTO plugin_kv(plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)", mapped)
        db.commit()
        skipped = sorted(key for key, _, _ in rows if key in LOCAL_ONLY_KEYS)
        return {"source": source_id, "target": target_id, "kvRows": len(mapped), "skippedKeys": skipped, "backup": str(backup_dir)}
    except BaseException:
        if db is not None:
            db.rollback()
        if installed_stage:
            shutil.rmtree(target_dir)
        if moved_target:
            (backup_dir / "target-original").rename(target_dir)
        raise
    finally:
        if db is not None:
            db.close()
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--from", dest="source_id", choices=sorted(IDS), required=True)
    parser.add_argument("--to", dest="target_id", choices=sorted(IDS), required=True)
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--quiescent", action="store_true")
    parser.add_argument("--replace-target", action="store_true")
    args = parser.parse_args()
    try:
        result = copy_pool_state(args.data_dir, args.source_id, args.target_id, args.backup_dir,
                                 quiescent=args.quiescent, replace_target=args.replace_target)
    except Exception as error:
        parser.exit(1, f"Handoff refused/failed: {error}\nBoth pools must stay disabled until recovery is checked.\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
