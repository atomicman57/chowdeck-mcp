CREATE TABLE IF NOT EXISTS cache_limits (
 priority INTEGER PRIMARY KEY,
 bytes INTEGER NOT NULL DEFAULT 0,
 entries INTEGER NOT NULL DEFAULT 0,
 writes INTEGER NOT NULL DEFAULT 0,
 day TEXT NOT NULL DEFAULT '',
 max_bytes INTEGER NOT NULL,
 max_entries INTEGER NOT NULL,
 max_writes INTEGER NOT NULL
);
INSERT OR IGNORE INTO cache_limits(priority,max_bytes,max_entries,max_writes) VALUES(0,33554432,2000,3000),(1,4194304,500,500);
CREATE TABLE IF NOT EXISTS cache_entries (
 key TEXT PRIMARY KEY COLLATE BINARY,
 value TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 priority INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cache_expiry ON cache_entries(expires_at);
CREATE TRIGGER IF NOT EXISTS cache_insert_guard BEFORE INSERT ON cache_entries BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM cache_limits WHERE priority=NEW.priority
  AND bytes+NEW.bytes-COALESCE((SELECT bytes FROM cache_entries WHERE key=NEW.key),0)<=max_bytes
  AND (entries<max_entries OR EXISTS(SELECT 1 FROM cache_entries WHERE key=NEW.key))
  AND (day!=date('now') OR writes<max_writes)
 ) THEN RAISE(IGNORE) END;
END;
CREATE TRIGGER IF NOT EXISTS cache_update_guard BEFORE UPDATE ON cache_entries BEGIN
 SELECT CASE WHEN NEW.priority!=OLD.priority OR NOT EXISTS (
  SELECT 1 FROM cache_limits WHERE priority=NEW.priority
  AND bytes+NEW.bytes-OLD.bytes<=max_bytes AND (day!=date('now') OR writes<max_writes)
 ) THEN RAISE(IGNORE) END;
END;
CREATE TRIGGER IF NOT EXISTS cache_insert_account AFTER INSERT ON cache_entries BEGIN
 UPDATE cache_limits SET bytes=bytes+NEW.bytes,entries=entries+1,writes=CASE WHEN day=date('now') THEN writes+1 ELSE 1 END,day=date('now') WHERE priority=NEW.priority;
END;
CREATE TRIGGER IF NOT EXISTS cache_update_account AFTER UPDATE ON cache_entries BEGIN
 UPDATE cache_limits SET bytes=bytes+NEW.bytes-OLD.bytes,writes=CASE WHEN day=date('now') THEN writes+1 ELSE 1 END,day=date('now') WHERE priority=NEW.priority;
END;
CREATE TRIGGER IF NOT EXISTS cache_delete_account AFTER DELETE ON cache_entries BEGIN
 UPDATE cache_limits SET bytes=bytes-OLD.bytes,entries=entries-1 WHERE priority=OLD.priority;
END;
