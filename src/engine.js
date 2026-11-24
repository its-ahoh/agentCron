// The once-a-minute tick: recover runs -> fire due timers into the inbox -> wake agents.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pushEvent, recordAttempt } from './store.js';
import { nextOccurrence } from './schedule.js';

const num = (name, fallback) => Number(process.env[name]) || fallback;
export const settings = () => ({
  maxAttempts: num('AGENT_CRON_MAX_ATTEMPTS', 3),
  checkTimeoutMs: num('AGENT_CRON_CHECK_TIMEOUT_MS', 30_000),
  batchSize: 20,
  checkConcurrency: 4,
});

export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// The gate. Exit 0 means "wake the agent"; anything else (or a timeout) means "skip".
export function runCheck(cmd, { cwd, env, timeoutMs = settings().checkTimeoutMs } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, reason, output: output.trim().slice(0, 4000) });
    };
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], detached: true,
    });
    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish(false, 'timeout');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (output.length < 16_000) output += chunk; });
    child.on('error', (err) => finish(false, err.message));
    child.on('close', (code, signal) => finish(code === 0, signal ? `signal ${signal}` : `exit ${code}`));
  });
}

async function processTimer(store, timer, now) {
  const where = { agent: timer.agent, timerId: timer.id, at: now };
  const label = timer.name || `timer ${timer.id}`;

  if (timer.expires_at && now >= timer.expires_at) {
    store.run(`UPDATE timers SET status = 'expired' WHERE id = ? AND status = 'active'`, timer.id);
    store.log('expire', `${label}: expired`, where);
    return 'expired';
  }

  let context = null;
  if (timer.check_cmd) {
    const check = await runCheck(timer.check_cmd, {
      cwd: timer.agent_cwd || os.homedir(),
      env: { AGENT_CRON_AGENT: timer.agent, AGENT_CRON_TIMER_ID: String(timer.id) },
    });
    if (!check.ok) {
      // A one-off keeps its due time, so it is checked again next minute. A schedule moves on.
      const next = timer.kind === 'once' ? timer.next_due_at : nextOccurrence(timer, now);
      store.run(
        `UPDATE timers SET skip_count = skip_count + 1, last_checked_at = ?, next_due_at = ?
         WHERE id = ? AND status = 'active' AND next_due_at = ?`,
        now, next, timer.id, timer.next_due_at);
      store.log('skip', `${label}: check said no (${check.reason})`, where);
      return 'skipped';
    }
    context = check.output || null;
  }

  return store.tx(() => {
    // Re-read inside the lock: another process may have handled this same occurrence.
    const fresh = store.get('SELECT * FROM timers WHERE id = ?', timer.id);
    if (!fresh || fresh.status !== 'active' || fresh.next_due_at !== timer.next_due_at) return 'stale';

    pushEvent(store, {
      agent: timer.agent, source: 'timer', sourceId: `${timer.id}:${timer.next_due_at}`,
      timerId: timer.id, title: timer.name, prompt: timer.prompt, context, maxAttempts: fresh.max_attempts,
    }, now);

    const fires = fresh.fire_count + 1;
    const finished = timer.kind === 'once' || (fresh.max_fires && fires >= fresh.max_fires);
    store.run(
      `UPDATE timers SET fire_count = ?, last_fired_at = ?, last_checked_at = ?, status = ?, next_due_at = ?
       WHERE id = ?`,
      fires, now, now, finished ? 'done' : 'active',
      finished ? fresh.next_due_at : nextOccurrence(fresh, now), timer.id);
    store.log('fire', `${label}: added to inbox`, where);
    return 'fired';
  });
}

// Step 1+2: find due timers of connected agents, run their checks, write events for the ones that pass.
export async function fireDueTimers(store, now = Date.now()) {
  const due = store.all(
    `SELECT t.*, a.cwd AS agent_cwd FROM timers t JOIN agents a ON a.name = t.agent
     WHERE t.status = 'active' AND a.connected = 1 AND t.next_due_at <= ?
     ORDER BY t.next_due_at, t.id`, now);
  const counts = { fired: 0, skipped: 0, expired: 0, stale: 0 };
  const queue = [...due];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        counts[await processTimer(store, t, now)]++;
      } catch (err) {
        store.log('error', `timer ${t.id}: ${err.message}`, { agent: t.agent, timerId: t.id, at: now });
      }
    }
  };
  await Promise.all(Array.from({ length: settings().checkConcurrency }, worker));
  return counts;
}

const runFile = (store, runId, ext) => path.join(store.dir, 'runs', `${runId}.${ext}`);

// Close a run and settle its events. Safe to call twice; only the first call does anything.
export function finishRun(store, runId, { status, exitCode = null }, now = Date.now()) {
  return store.tx(() => {
    const run = store.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.status !== 'running') return false;
    store.run('UPDATE runs SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?', status, exitCode, now, runId);
    // Events the agent did not report on take the result of the run. Write down why, for later reading.
    const reason = {
      done: null,
      failed: `the run exited with code ${exitCode ?? '?'} and the agent did not report on this event`,
      lost: 'the run ended without a result (it crashed or was killed) before this event was reported',
      timeout: 'the run went over its time limit and was stopped before this event was reported',
    }[status];
    for (const e of store.all(`SELECT * FROM events WHERE run_id = ? AND status = 'running'`, runId)) {
      recordAttempt(store, { eventId: e.id, attempt: e.attempts, runId, outcome: status, reason, saidBy: 'run' }, now);
    }
    if (status === 'done') {
      store.run(`UPDATE events SET status = 'done', updated_at = ? WHERE run_id = ? AND status = 'running'`, now, runId);
    } else {
      // Back to the inbox for another try, until the attempts run out.
      store.run(
        `UPDATE events SET status = CASE WHEN attempts >= COALESCE(max_attempts, ?) THEN 'failed' ELSE 'pending' END,
           updated_at = ? WHERE run_id = ? AND status = 'running'`,
        settings().maxAttempts, now, runId);
      for (const e of store.all(`SELECT * FROM events WHERE run_id = ? AND status = 'failed' AND updated_at = ?`, runId, now)) {
        const why = e.max_attempts === 1 ? 'it is marked no-retry' : `${e.attempts} attempts used`;
        store.log('gave-up', `event ${e.id} (${e.title || e.source}) will not be retried: ${why}`, { agent: run.agent, timerId: e.timer_id, at: now });
      }
    }
    const tail = exitCode == null ? '' : ` (exit ${exitCode})`;
    store.log('run', `run ${runId} ${status}${tail}`, { agent: run.agent, at: now });
    return true;
  });
}

// An agent reports the outcome of one event while its run is still going. That event then keeps
// its own result, whatever happens to the rest of the batch. Unreported events follow the run.
export function reportEvent(store, { id, outcome, runId = null, note = null }, now = Date.now()) {
  return store.tx(() => {
    const e = store.get('SELECT * FROM events WHERE id = ?', id);
    if (!e) return { ok: false, reason: 'not found' };
    if (e.status !== 'running') return { ok: false, reason: `it is ${e.status}, not being worked on` };
    if (runId && e.run_id !== runId) return { ok: false, reason: `it belongs to run ${e.run_id}, not this run` };
    const limit = e.max_attempts ?? settings().maxAttempts;
    const status = outcome === 'done' ? 'done' : e.attempts >= limit ? 'failed' : 'pending';
    store.run('UPDATE events SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
    recordAttempt(store, { eventId: id, attempt: e.attempts, runId: e.run_id, outcome: outcome === 'done' ? 'done' : 'failed', reason: note, saidBy: 'agent' }, now);
    const label = e.title || e.source;
    const tail = note ? `: ${note}` : '';
    const where = { agent: e.agent, timerId: e.timer_id, at: now };
    store.log('event', `event ${id} (${label}) reported ${outcome === 'done' ? 'done' : 'failed'} by run ${e.run_id}${tail}`, where);
    if (status === 'failed') {
      const why = limit === 1 ? 'it is marked no-retry' : `${e.attempts} attempts used`;
      store.log('gave-up', `event ${id} (${label}) will not be retried: ${why}`, where);
    }
    return { ok: true, status };
  });
}

// Step 0: settle runs whose process ended while nobody was watching, and kill runs that overran.
export function recoverRuns(store, now = Date.now()) {
  const running = store.all(
    `SELECT r.*, a.run_timeout_ms FROM runs r LEFT JOIN agents a ON a.name = r.agent WHERE r.status = 'running'`);
  for (const run of running) {
    let exitCode = null;
    try {
      const text = fs.readFileSync(runFile(store, run.id, 'exit'), 'utf8').trim();
      if (text !== '') exitCode = Number(text);
    } catch { /* no exit file yet */ }

    if (exitCode !== null && !Number.isNaN(exitCode)) {
      finishRun(store, run.id, { status: exitCode === 0 ? 'done' : 'failed', exitCode }, now);
    } else if (!alive(run.pid)) {
      // Give a fresh spawn a moment to record its pid before calling it lost.
      if (run.pid || now - run.started_at > 10_000) finishRun(store, run.id, { status: 'lost' }, now);
    } else if (now - run.started_at > (run.run_timeout_ms ?? 1_800_000)) {
      killGroup(run.pid);
      finishRun(store, run.id, { status: 'timeout' }, now);
    }
  }
}

export function buildPrompt(agent, events, runId, priorActions = []) {
  const lines = [
    `You were woken by agent-cron (agent "${agent.name}", run ${runId}). Nobody is watching this run live.`,
    `${events.length} event${events.length === 1 ? ' is' : 's are'} waiting. Handle each one, then stop.`,
    '',
  ];
  events.forEach((e, i) => {
    lines.push(`## Event ${i + 1}: ${e.title || `${e.source} event`} (id ${e.id}, source ${e.source}, attempt ${e.attempts})`);
    lines.push('', e.prompt.trim(), '');
    if (e.context) lines.push('Output of the check that triggered this:', '```', e.context, '```', '');
  });
  if (events.some((e) => e.attempts > 1)) {
    lines.push(
      '## Warning: this is a retry',
      '',
      'An earlier attempt at these events ended badly. It may have already done part of the work.',
      'Before repeating anything that changes the outside world (merge, send, pay, post, delete), check whether it already happened.',
      '');
    if (priorActions.length) {
      lines.push('Actions the earlier attempts recorded:');
      for (const a of priorActions) {
        lines.push(a.status === 'done'
          ? `- ${a.key}: DONE${a.note ? ` (${a.note})` : ''}. Do not repeat it.`
          : `- ${a.key}: STARTED, outcome unknown. Verify in the real system before doing it again.`);
      }
      lines.push('');
    }
  }
  const many = events.length > 1;
  lines.push(
    '---',
    `Report ${many ? 'each event as you finish it' : 'the result when you finish'}, using the event id shown above:`,
    '  `agent-cron event done <id>` when it is handled (also when it turned out nothing needed doing).',
    '  `agent-cron event fail <id> --note "<why>"` when you could not do it. It will be tried again later if tries remain.',
    many
      ? 'Report one event before starting the next. An event you do not report gets the result of the whole run.'
      : 'If you do not report, the event gets the result of the whole run.',
    'Around every action that must not happen twice, use the ledger:',
    '  `agent-cron action begin <key>` first. Exit 0 = go ahead. Exit 10 = already done, skip. Exit 11 = unknown, verify first.',
    '  `agent-cron action done <key>` right after it succeeds.',
    'If something needs you to come back later: `agent-cron followup --in 2h --prompt "<what to do then, with paths and ids>"` (or `--at 09:00`).',
    'If nothing needs doing, say so in one line and finish.');
  return lines.join('\n');
}

// Ledger entries written by earlier runs that handled any of these events.
function priorActions(store, agent, events) {
  const retried = events.filter((e) => e.attempts > 1).map((e) => e.id);
  if (!retried.length) return [];
  const runIds = store.all(`SELECT id, event_ids FROM runs WHERE agent = ? AND status != 'running'`, agent.name)
    .filter((r) => r.event_ids.split(',').some((id) => retried.includes(Number(id))))
    .map((r) => r.id);
  if (!runIds.length) return [];
  return store.all(
    `SELECT * FROM actions WHERE agent = ? AND run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY started_at`,
    agent.name, ...runIds);
}

function startRun(store, agent, runId, events, now) {
  const promptPath = runFile(store, runId, 'prompt.md');
  const logPath = runFile(store, runId, 'log');
  const exitPath = runFile(store, runId, 'exit');
  fs.writeFileSync(promptPath, buildPrompt(agent, events, runId, priorActions(store, agent, events)));
  fs.rmSync(exitPath, { force: true });

  // The wrapper writes the exit code to a file, so a restarted daemon can still learn the result.
  const script = `( ${agent.command}\n)\ncode=$?\necho "$code" > "$AGENT_CRON_EXIT_FILE"\nexit "$code"`;
  const stdin = fs.openSync(promptPath, 'r');
  const out = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn('/bin/sh', ['-c', script], {
      cwd: agent.cwd || os.homedir(),
      env: {
        ...process.env,
        AGENT_CRON_AGENT: agent.name,
        AGENT_CRON_RUN_ID: String(runId),
        AGENT_CRON_EVENT_IDS: events.map((e) => e.id).join(','),
        AGENT_CRON_EXIT_FILE: exitPath,
      },
      stdio: [stdin, out, out],
      detached: true, // own process group: survives a daemon restart, and can be killed as a group
    });
  } finally {
    fs.closeSync(stdin);
    fs.closeSync(out);
  }

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      fs.appendFileSync(logPath, `agent-cron: could not start agent: ${err.message}\n`);
      finishRun(store, runId, { status: 'failed' });
      resolve();
    });
    child.on('exit', (code) => {
      finishRun(store, runId, code === null ? { status: 'lost' } : { status: code === 0 ? 'done' : 'failed', exitCode: code });
      resolve();
    });
  });
  if (child.pid) store.run('UPDATE runs SET pid = ? WHERE id = ?', child.pid, runId);
  child.unref();
  return { id: runId, agent: agent.name, pid: child.pid, done };
}

// Step 3: for each connected agent with pending events and no active run, start one run with a batch.
export function dispatch(store, now = Date.now()) {
  const agents = store.all(
    `SELECT a.* FROM agents a
     WHERE a.connected = 1
       AND EXISTS (SELECT 1 FROM events e WHERE e.agent = a.name AND e.status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.agent = a.name AND r.status = 'running')`);
  const started = [];
  for (const agent of agents) {
    const claim = store.tx(() => {
      if (store.get(`SELECT 1 FROM runs WHERE agent = ? AND status = 'running'`, agent.name)) return null;
      const events = store.all(
        `SELECT * FROM events WHERE agent = ? AND status = 'pending' ORDER BY id LIMIT ?`,
        agent.name, settings().batchSize);
      if (!events.length) return null;
      const ids = events.map((e) => e.id);
      const { lastInsertRowid: runId } = store.run(
        `INSERT INTO runs (agent, status, event_ids, started_at) VALUES (?, 'running', ?, ?)`,
        agent.name, ids.join(','), now);
      store.run('UPDATE runs SET log_path = ? WHERE id = ?', runFile(store, runId, 'log'), runId);
      store.run(
        `UPDATE events SET status = 'running', attempts = attempts + 1, run_id = ?, updated_at = ?
         WHERE id IN (${ids.map(() => '?').join(',')})`, runId, now, ...ids);
      store.log('run', `run ${runId} started with ${ids.length} event(s)`, { agent: agent.name, at: now });
      return { runId: Number(runId), events: events.map((e) => ({ ...e, attempts: e.attempts + 1 })) };
    });
    if (!claim) continue;
    try {
      started.push(startRun(store, agent, claim.runId, claim.events, now));
    } catch (err) {
      finishRun(store, claim.runId, { status: 'failed' }, now);
      store.log('error', `run ${claim.runId}: ${err.message}`, { agent: agent.name, at: now });
    }
  }
  return started;
}

export async function tick(store, { now = Date.now(), wait = false } = {}) {
  recoverRuns(store, now);
  const timers = await fireDueTimers(store, now);
  const started = dispatch(store, now);
  if (wait) await Promise.all(started.map((r) => r.done));
  store.run('DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - 5000');
  return { ...timers, runs: started.map((r) => r.id) };
}
