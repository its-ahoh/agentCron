// One SQLite file holds everything: agents, timers, the event inbox, runs, and an activity log.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function homeDir() {
  return process.env.AGENT_CRON_HOME || path.join(os.homedir(), '.agent-cron');
}

const SCHEMA = `
-- Who can be woken, and how. The wake prompt arrives on the command's stdin.
CREATE TABLE IF NOT EXISTS agents (
  name           TEXT PRIMARY KEY,
  command        TEXT NOT NULL,
  cwd            TEXT,
  connected      INTEGER NOT NULL DEFAULT 1,
  run_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Timers: "when should I look?". once = follow-up, every/cron = schedule.
-- A timer never starts an agent. When due (and its check passes) it adds an event to the inbox.
CREATE TABLE IF NOT EXISTS timers (
  id              INTEGER PRIMARY KEY,
  agent           TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  name            TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('once','every','cron')),
  spec            TEXT,                -- every: interval in ms; cron: the expression
  next_due_at     INTEGER NOT NULL,
  prompt          TEXT NOT NULL,
  check_cmd       TEXT,                -- optional gate: exit 0 = wake the agent, anything else = skip
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','done','expired','cancelled')),
  expires_at      INTEGER,
  max_fires       INTEGER,
  max_attempts    INTEGER,             -- copied to each event; 1 = never retry (for risky actions)
  origin_run      INTEGER,             -- set when a woken agent added this itself with "followup"
  fire_count      INTEGER NOT NULL DEFAULT 0,
  skip_count      INTEGER NOT NULL DEFAULT 0,
  last_fired_at   INTEGER,
  last_checked_at INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS timers_due ON timers (status, next_due_at);

-- Event inbox: work that is ready now. Every source writes here; nothing calls an agent directly.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  agent      TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
  source     TEXT NOT NULL,            -- timer | manual | webhook | ...
  source_id  TEXT NOT NULL,            -- the source's own id, used to drop duplicates
  timer_id   INTEGER,
  title      TEXT,
  prompt     TEXT NOT NULL,
  context    TEXT,                     -- e.g. what the check command printed
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','paused','running','done','failed')),  -- paused = held by hand
  attempts   INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER,                -- NULL = the global default; 1 = never retry
  run_id     INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent, source, source_id)
);
CREATE INDEX IF NOT EXISTS events_pending ON events (agent, status, id);

-- What happened on each try of each event, and why. Kept with the event so it can be read back later.
CREATE TABLE IF NOT EXISTS attempts (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attempt  INTEGER NOT NULL,
  run_id   INTEGER,
  outcome  TEXT NOT NULL CHECK (outcome IN ('done','failed','lost','timeout')),
  reason   TEXT,
  said_by  TEXT NOT NULL CHECK (said_by IN ('agent','run')),  -- agent = it reported; run = taken from how the run ended
  at       INTEGER NOT NULL,
  PRIMARY KEY (event_id, attempt)
);

-- One row per wake-up. A row in status 'running' is the lock: one run per agent at a time.
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY,
  agent      TEXT NOT NULL,
  pid        INTEGER,
  status     TEXT NOT NULL CHECK (status IN ('running','done','failed','lost','timeout')),
  exit_code  INTEGER,
  event_ids  TEXT NOT NULL,
  log_path   TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_per_agent ON runs (agent) WHERE status = 'running';

-- What happened and why: fires, skips, runs.
CREATE TABLE IF NOT EXISTS activity (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  agent    TEXT,
  timer_id INTEGER,
  kind     TEXT NOT NULL,
  message  TEXT
);

-- Action ledger: an agent notes a risky outside action before and after doing it,
-- so a retried run can tell "done", "never started" and "started, outcome unknown" apart.
CREATE TABLE IF NOT EXISTS actions (
  agent      TEXT NOT NULL,
  key        TEXT NOT NULL,            -- chosen by the agent, e.g. "merge-pr-42"
  status     TEXT NOT NULL CHECK (status IN ('started','done')),
  note       TEXT,
  run_id     INTEGER,
  started_at INTEGER NOT NULL,
  done_at    INTEGER,
  PRIMARY KEY (agent, key)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function openStore(dir = homeDir()) {
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'agent-cron.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Databases made before a column existed get it added here.
  for (const [table, column, type] of [['timers', 'max_attempts', 'INTEGER'], ['events', 'max_attempts', 'INTEGER'], ['timers', 'origin_run', 'INTEGER']]) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Older databases do not allow the 'paused' event status. SQLite cannot change a CHECK in place,
  // so rebuild the table once, keeping every row.
  const eventsSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`).get().sql;
  if (!eventsSql.includes("'paused'")) {
    const cols = 'id, agent, source, source_id, timer_id, title, prompt, context, status, attempts, max_attempts, run_id, created_at, updated_at';
    db.exec('BEGIN IMMEDIATE');
    try {
      // attempts points at events; drop it first so the rename cannot redirect it (it is empty this early).
      db.exec('DROP TABLE IF EXISTS attempts; ALTER TABLE events RENAME TO events_old; DROP INDEX IF EXISTS events_pending;');
      db.exec(SCHEMA);
      db.exec(`INSERT INTO events (${cols}) SELECT ${cols} FROM events_old; DROP TABLE events_old;`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const store = {
    dir,
    db,
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    // BEGIN IMMEDIATE takes the write lock up front, so two processes cannot interleave.
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    log(kind, message, { agent = null, timerId = null, at = Date.now() } = {}) {
      store.run('INSERT INTO activity (at, agent, timer_id, kind, message) VALUES (?,?,?,?,?)',
        at, agent, timerId, kind, message);
    },
    getMeta: (key) => store.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null,
    setMeta: (key, value) => store.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, value == null ? null : String(value)),
    close: () => db.close(),
  };
  return store;
}

export function connectAgent(store, { name, command, cwd = null, timeoutMs = null }, now = Date.now()) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad agent name "${name}" (letters, digits, . _ - only)`);
  store.run(
    `INSERT INTO agents (name, command, cwd, connected, run_timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, 1, COALESCE(?, 1800000), ?, ?)
     ON CONFLICT(name) DO UPDATE SET command = excluded.command, cwd = excluded.cwd, connected = 1,
       run_timeout_ms = COALESCE(?, run_timeout_ms), updated_at = excluded.updated_at`,
    name, command, cwd, timeoutMs, now, now, timeoutMs);
  return store.get('SELECT * FROM agents WHERE name = ?', name);
}

export function addTimer(store, t, now = Date.now()) {
  if (!store.get('SELECT 1 FROM agents WHERE name = ?', t.agent)) throw new Error(`unknown agent "${t.agent}"`);
  const { lastInsertRowid } = store.run(
    `INSERT INTO timers (agent, name, kind, spec, next_due_at, prompt, check_cmd, expires_at, max_fires, max_attempts, origin_run, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    t.agent, t.name ?? null, t.kind ?? 'once', t.spec ?? null, t.nextDueAt ?? now, t.prompt,
    t.check ?? null, t.expiresAt ?? null, t.maxFires ?? null, t.maxAttempts ?? null, t.originRun ?? null, now);
  return store.get('SELECT * FROM timers WHERE id = ?', lastInsertRowid);
}

// Append to the inbox. Returns null when the same (agent, source, sourceId) is already there.
export function pushEvent(store, e, now = Date.now()) {
  const { changes, lastInsertRowid } = store.run(
    `INSERT OR IGNORE INTO events (agent, source, source_id, timer_id, title, prompt, context, max_attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    e.agent, e.source ?? 'manual', e.sourceId ?? randomUUID(), e.timerId ?? null, e.title ?? null,
    e.prompt, e.context ?? null, e.maxAttempts ?? null, now, now);
  return changes ? store.get('SELECT * FROM events WHERE id = ?', lastInsertRowid) : null;
}

// Claim an outside action before doing it. Returns:
//   'new'      - nobody did this yet; go ahead
//   'done'     - already finished earlier; skip it
//   'in_doubt' - an earlier run started it and never reported back; check the real world first
export function beginAction(store, { agent, key, runId = null, force = false }, now = Date.now()) {
  return store.tx(() => {
    const row = store.get('SELECT * FROM actions WHERE agent = ? AND key = ?', agent, key);
    if (row?.status === 'done' && !force) return 'done';
    if (row && !force && !(runId && row.run_id === runId)) return 'in_doubt';
    store.run(
      `INSERT INTO actions (agent, key, status, run_id, started_at) VALUES (?, ?, 'started', ?, ?)
       ON CONFLICT(agent, key) DO UPDATE SET status = 'started', run_id = excluded.run_id,
         started_at = excluded.started_at, done_at = NULL, note = NULL`,
      agent, key, runId, now);
    return 'new';
  });
}

export function finishAction(store, { agent, key, note = null, runId = null }, now = Date.now()) {
  store.run(
    `INSERT INTO actions (agent, key, status, note, run_id, started_at, done_at) VALUES (?, ?, 'done', ?, ?, ?, ?)
     ON CONFLICT(agent, key) DO UPDATE SET status = 'done', note = excluded.note, done_at = excluded.done_at`,
    agent, key, note, runId, now, now);
}

export const followupLimits = () => ({
  minDelayMs: 60_000,
  maxDelayMs: 30 * 86_400_000,
  maxPending: Number(process.env.AGENT_CRON_FOLLOWUP_MAX_PENDING) || 5,
  maxPerDay: Number(process.env.AGENT_CRON_FOLLOWUP_MAX_PER_DAY) || 20,
  maxPromptChars: 4000,
});

// The one way a woken agent may schedule itself. Safe by construction: one-off only, for itself only,
// no check command, and capped so a run cannot keep waking itself for ever.
export function addFollowup(store, { agent, runId, dueAt, prompt, name = null }, now = Date.now()) {
  const lim = followupLimits();
  return store.tx(() => {
    const run = store.get('SELECT * FROM runs WHERE id = ?', runId ?? -1);
    if (!run || run.agent !== agent || run.status !== 'running') {
      throw new Error('followup only works inside a run that agent-cron started. Outside one, use: agent-cron add');
    }
    if (!prompt?.trim()) throw new Error('--prompt is required: say what to do when woken');
    if (prompt.length > lim.maxPromptChars) throw new Error(`--prompt is too long (limit ${lim.maxPromptChars} characters)`);
    if (dueAt - now < lim.minDelayMs) throw new Error('a follow-up must be at least 1 minute from now');
    if (dueAt - now > lim.maxDelayMs) throw new Error('a follow-up must be within 30 days');
    const pending = store.get(
      `SELECT COUNT(*) n FROM timers WHERE agent = ? AND origin_run IS NOT NULL AND status IN ('active','paused')`, agent).n;
    if (pending >= lim.maxPending) {
      throw new Error(`limit reached: ${pending} follow-ups are already waiting (limit ${lim.maxPending}). Do not retry; tell the user in your reply instead`);
    }
    const today = store.get(
      'SELECT COUNT(*) n FROM timers WHERE agent = ? AND origin_run IS NOT NULL AND created_at > ?', agent, now - 86_400_000).n;
    if (today >= lim.maxPerDay) {
      throw new Error(`limit reached: ${today} follow-ups were added in the last 24 hours (limit ${lim.maxPerDay}). Do not retry; tell the user in your reply instead`);
    }
    const timer = addTimer(store, { agent, name, prompt, kind: 'once', nextDueAt: dueAt, originRun: runId }, now);
    store.log('followup', `${name || `timer ${timer.id}`}: run ${runId} scheduled a follow-up`, { agent, timerId: timer.id, at: now });
    return timer;
  });
}

export function recordAttempt(store, { eventId, attempt, runId, outcome, reason = null, saidBy }, now = Date.now()) {
  store.run(
    `INSERT OR REPLACE INTO attempts (event_id, attempt, run_id, outcome, reason, said_by, at) VALUES (?,?,?,?,?,?,?)`,
    eventId, attempt, runId, outcome, reason, saidBy, now);
}
