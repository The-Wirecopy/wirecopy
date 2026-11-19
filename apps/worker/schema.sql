CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  question TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'public',
  ip TEXT,
  wallet TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  deep INTEGER NOT NULL DEFAULT 0,
  burn_tx TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created INTEGER NOT NULL,
  started INTEGER,
  finished INTEGER,
  report TEXT,
  error TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_missions_queue ON missions(status, priority DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_missions_created ON missions(id DESC);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission INTEGER NOT NULL,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_steps_mission ON steps(mission, n);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission INTEGER NOT NULL,
  step INTEGER NOT NULL,
  claim TEXT NOT NULL,
  evidence TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]',
  epoch_hour INTEGER,
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(id DESC);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_findings_epoch ON findings(epoch_hour, status);

CREATE TABLE IF NOT EXISTS burns (
  tx TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount REAL NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  who TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (who, kind, day)
);

CREATE TABLE IF NOT EXISTS api_keys (
  hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  addr TEXT PRIMARY KEY,
  holds REAL NOT NULL DEFAULT 0,
  hold_checked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tape_seals (
  epoch_hour INTEGER PRIMARY KEY,
  merkle_root TEXT NOT NULL,
  dispatch_count INTEGER NOT NULL,
  wired_count INTEGER NOT NULL,
  tx_hash TEXT,
  sealed_at INTEGER NOT NULL,
  leaves_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
