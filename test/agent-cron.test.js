import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, connectAgent, addTimer, pushEvent } from '../src/store.js';
import { tick, recoverRuns } from '../src/engine.js';
import { parseDuration, parseAt, nextCron, nextOccurrence } from '../src/schedule.js';

const MIN = 60_000;

// A fake agent: it saves the prompt it was woken with, then exits with $FAKE_EXIT (default 0).
function setup(t, { command } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cron-test-'));
  const store = openStore(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  connectAgent(store, { name: 'bot', command: command ?? `cat > "${dir}/woke-$AGENT_CRON_RUN_ID.txt"`, cwd: dir });
  const woke = (runId) => fs.readFileSync(path.join(dir, `woke-${runId}.txt`), 'utf8');
  return { dir, store, woke };
}

test('durations, clock times and cron', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('1h30m'), 90 * MIN);
  assert.throws(() => parseDuration('soon'));

  const now = new Date(2026, 10, 23, 20, 0).getTime(); // Mon 23 Nov 2026, 20:00 local
  assert.equal(parseAt('21:15', now), new Date(2026, 10, 23, 21, 15).getTime());
  assert.equal(parseAt('09:00', now), new Date(2026, 10, 24, 9, 0).getTime());

  assert.equal(nextCron('*/15 * * * *', now + 1000), new Date(2026, 10, 23, 20, 15).getTime());
  assert.equal(nextCron('0 9 * * 1-5', now), new Date(2026, 10, 24, 9, 0).getTime());
  assert.equal(nextCron('0 9 * * 6,7', now), new Date(2026, 10, 28, 9, 0).getTime());
  assert.equal(nextCron('30 8 1 * *', now), new Date(2026, 11, 1, 8, 30).getTime());
  assert.throws(() => nextCron('61 * * * *', now));

  // A schedule that slept through several slots moves to the next one, it does not replay them.
  assert.equal(nextOccurrence({ kind: 'every', spec: String(10 * MIN), next_due_at: now }, now + 35 * MIN), now + 40 * MIN);
});

test('a due timer goes through the inbox and wakes the agent once', async (t) => {
  const { store, woke } = setup(t);
  const now = Date.now();
  addTimer(store, { agent: 'bot', name: 'follow up', prompt: 'Look at PR 42', nextDueAt: now + 5 * MIN }, now);

  let r = await tick(store, { now, wait: true });
  assert.deepEqual([r.fired, r.runs.length], [0, 0], 'not due yet: nothing happens');

  r = await tick(store, { now: now + 5 * MIN, wait: true });
  assert.equal(r.fired, 1);
  assert.match(woke(r.runs[0]), /Look at PR 42/);
  assert.equal(store.get('SELECT status FROM timers').status, 'done');
  assert.equal(store.get('SELECT status FROM events').status, 'done');
  assert.equal(store.get('SELECT status FROM runs').status, 'done');

  r = await tick(store, { now: now + 6 * MIN, wait: true });
  assert.deepEqual([r.fired, r.runs.length], [0, 0], 'a one-off never fires twice');
});

test('a failing check skips without waking; when it passes the agent gets its output', async (t) => {
  const { dir, store, woke } = setup(t);
  const now = Date.now();
  const flag = path.join(dir, 'ready');
  addTimer(store, { agent: 'bot', prompt: 'The file is here', check: `cat "${flag}"`, nextDueAt: now }, now);

  for (const n of [0, 1]) {
    const r = await tick(store, { now: now + n * MIN, wait: true });
    assert.deepEqual([r.skipped, r.fired, r.runs.length], [1, 0, 0]);
  }
  assert.equal(store.get('SELECT COUNT(*) n FROM events').n, 0, 'skips cost nothing');
  assert.equal(store.get('SELECT skip_count FROM timers').skip_count, 2);

  fs.writeFileSync(flag, 'build 7 is green');
  const r = await tick(store, { now: now + 2 * MIN, wait: true });
  assert.equal(r.fired, 1);
  assert.match(woke(r.runs[0]), /build 7 is green/);
  assert.equal(store.get('SELECT status FROM timers').status, 'done');
});

test('repeating timers advance, respect max-fires, and expire', async (t) => {
  const { store } = setup(t);
  const now = Date.now();
  addTimer(store, { agent: 'bot', prompt: 'tidy', kind: 'every', spec: String(10 * MIN), nextDueAt: now, maxFires: 2 }, now);
  addTimer(store, { agent: 'bot', prompt: 'watch', check: 'false', nextDueAt: now, expiresAt: now + 3 * MIN }, now);

  let r = await tick(store, { now, wait: true });
  assert.deepEqual([r.fired, r.skipped], [1, 1]);
  assert.equal(store.get('SELECT next_due_at d FROM timers WHERE id = 1').d, now + 10 * MIN);

  r = await tick(store, { now: now + 5 * MIN, wait: true });
  assert.deepEqual([r.fired, r.expired], [0, 1], 'schedule not due; watch gave up');

  r = await tick(store, { now: now + 10 * MIN, wait: true });
  assert.equal(r.fired, 1);
  assert.deepEqual(store.all('SELECT status FROM timers ORDER BY id').map((x) => x.status), ['done', 'expired']);
});

test('inbox drops duplicates and batches waiting events into one run', async (t) => {
  const { store, woke } = setup(t);
  assert.ok(pushEvent(store, { agent: 'bot', source: 'github', sourceId: 'delivery-1', prompt: 'issue opened' }));
  assert.equal(pushEvent(store, { agent: 'bot', source: 'github', sourceId: 'delivery-1', prompt: 'issue opened' }), null);
  pushEvent(store, { agent: 'bot', prompt: 'second thing' });

  const r = await tick(store, { wait: true });
  assert.equal(r.runs.length, 1);
  const prompt = woke(r.runs[0]);
  assert.match(prompt, /issue opened/);
  assert.match(prompt, /second thing/);
  assert.equal(store.get(`SELECT COUNT(*) n FROM events WHERE status = 'done'`).n, 2);
});

test('one run per agent at a time; later events wait for the next tick', async (t) => {
  const { dir, store } = setup(t, { command: 'cat > /dev/null; sleep 0.4' });
  pushEvent(store, { agent: 'bot', prompt: 'first' });
  const first = await tick(store);
  assert.equal(first.runs.length, 1);

  pushEvent(store, { agent: 'bot', prompt: 'second' });
  const second = await tick(store);
  assert.equal(second.runs.length, 0, 'agent is busy');
  assert.equal(store.get(`SELECT status FROM events WHERE prompt = 'second'`).status, 'pending');

  await new Promise((resolve) => setTimeout(resolve, 700));
  const third = await tick(store, { wait: true });
  assert.equal(third.runs.length, 1);
  assert.equal(store.get(`SELECT COUNT(*) n FROM events WHERE status = 'done'`).n, 2);
  assert.ok(fs.existsSync(path.join(dir, 'runs', '2.log')));
});

test('a failed run retries, then gives up after the attempt limit', async (t) => {
  const { store } = setup(t, { command: 'cat > /dev/null; exit 3' });
  pushEvent(store, { agent: 'bot', prompt: 'will fail' });
  for (const attempt of [1, 2, 3]) {
    const r = await tick(store, { wait: true });
    assert.equal(r.runs.length, 1);
    const e = store.get('SELECT status, attempts FROM events');
    assert.deepEqual([e.status, e.attempts], [attempt < 3 ? 'pending' : 'failed', attempt]);
  }
  assert.equal((await tick(store, { wait: true })).runs.length, 0);
  assert.equal(store.get('SELECT exit_code FROM runs WHERE id = 1').exit_code, 3);
});

test('a disconnected agent is left alone', async (t) => {
  const { store } = setup(t);
  const now = Date.now();
  addTimer(store, { agent: 'bot', prompt: 'x', nextDueAt: now }, now);
  store.run('UPDATE agents SET connected = 0');
  let r = await tick(store, { now, wait: true });
  assert.deepEqual([r.fired, r.runs.length], [0, 0]);
  store.run('UPDATE agents SET connected = 1');
  r = await tick(store, { now: now + MIN, wait: true });
  assert.deepEqual([r.fired, r.runs.length], [1, 1]);
});

test('runs that ended while the daemon was down are settled on the next tick', async (t) => {
  const { dir, store } = setup(t);
  const now = Date.now();
  const insertRun = (eventId, pid) => {
    const { lastInsertRowid: id } = store.run(
      `INSERT INTO runs (agent, pid, status, event_ids, started_at) VALUES ('bot', ?, 'running', ?, ?)`, pid, String(eventId), now);
    store.run(`UPDATE events SET status = 'running', attempts = 1, run_id = ? WHERE id = ?`, id, eventId);
    return Number(id);
  };
  const DEAD_PID = 2 ** 22 + 12345; // above the pid range on macOS and default Linux

  // Finished cleanly: the wrapper left an exit file behind.
  const a = pushEvent(store, { agent: 'bot', prompt: 'finished offline' });
  const runA = insertRun(a.id, DEAD_PID);
  fs.writeFileSync(path.join(dir, 'runs', `${runA}.exit`), '0\n');
  recoverRuns(store, now + MIN);
  assert.equal(store.get('SELECT status FROM runs WHERE id = ?', runA).status, 'done');
  assert.equal(store.get('SELECT status FROM events WHERE id = ?', a.id).status, 'done');

  // Killed with no trace: the event goes back to the inbox.
  const b = pushEvent(store, { agent: 'bot', prompt: 'crashed' });
  const runB = insertRun(b.id, DEAD_PID);
  recoverRuns(store, now + MIN);
  assert.equal(store.get('SELECT status FROM runs WHERE id = ?', runB).status, 'lost');
  assert.equal(store.get('SELECT status FROM events WHERE id = ?', b.id).status, 'pending');
});

test('a run that overruns its time limit is killed and retried', async (t) => {
  const { store } = setup(t, { command: 'cat > /dev/null; sleep 30' });
  pushEvent(store, { agent: 'bot', prompt: 'slow' });
  const now = Date.now();
  const [run] = (await tick(store, { now })).runs;
  recoverRuns(store, now + 31 * 60_000);
  assert.equal(store.get('SELECT status FROM runs WHERE id = ?', run).status, 'timeout');
  assert.equal(store.get('SELECT status FROM events').status, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the exit handler see the kill
});

// ---- Crash safety: the agent does something in the outside world, then dies before reporting back. ----

const CLI = path.resolve(import.meta.dirname, '..', 'bin', 'agent-cron.js');
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
// `kill -9 $PPID`-style death: the wrapper shell dies, so no exit code is ever written.
const DIE = 'kill -9 $$';

test('default is at-least-once: a crash after the action makes it happen again', async (t) => {
  const { dir, store } = setup(t);
  const ledger = path.join(dir, 'outside-world.txt');
  connectAgent(store, { name: 'bot', command: `cat > /dev/null; echo merged >> "${ledger}"; ${DIE}`, cwd: dir });
  pushEvent(store, { agent: 'bot', prompt: 'merge PR 42' });

  await tick(store, { wait: true });
  assert.equal(store.get('SELECT status FROM runs WHERE id = 1').status, 'lost');
  assert.equal(store.get('SELECT status FROM events').status, 'pending', 'goes back to the inbox');
  await tick(store, { wait: true });
  assert.equal(lines(ledger).length, 2, 'the action ran twice: this is the gap the next two tests close');
});

test('--no-retry: a crash after the action is never retried', async (t) => {
  const { dir, store } = setup(t);
  const ledger = path.join(dir, 'outside-world.txt');
  connectAgent(store, { name: 'bot', command: `cat > /dev/null; echo paid >> "${ledger}"; ${DIE}`, cwd: dir });
  const now = Date.now();
  pushEvent(store, { agent: 'bot', prompt: 'pay invoice 7', maxAttempts: 1 });
  addTimer(store, { agent: 'bot', prompt: 'send the email', nextDueAt: now, maxAttempts: 1 }, now);

  await tick(store, { now, wait: true });
  const second = await tick(store, { now: now + MIN, wait: true });
  assert.equal(second.runs.length, 0);
  assert.equal(lines(ledger).length, 1, 'happened exactly once');
  assert.deepEqual(store.all('SELECT status FROM events').map((e) => e.status), ['failed', 'failed']);
  assert.equal(store.get(`SELECT COUNT(*) n FROM activity WHERE kind = 'gave-up'`).n, 2, 'and it is on the record');
});

test('ledger: an action finished before the crash is skipped on the retry', async (t) => {
  const { dir, store } = setup(t);
  const ledger = path.join(dir, 'outside-world.txt');
  const ac = `AGENT_CRON_HOME="${dir}" "${process.execPath}" "${CLI}"`;
  // A careful agent: claim, act, record, and only then (first run only) crash.
  connectAgent(store, {
    name: 'bot', cwd: dir,
    command: `cat > "${dir}/prompt-$AGENT_CRON_RUN_ID.txt"
if ${ac} action begin merge-pr-42; then
  echo merged >> "${ledger}"
  ${ac} action done merge-pr-42 --note "sha abc123"
fi
[ "$AGENT_CRON_RUN_ID" = 1 ] && ${DIE}
exit 0`,
  });
  pushEvent(store, { agent: 'bot', prompt: 'merge PR 42' });

  await tick(store, { wait: true });
  assert.equal(store.get('SELECT status FROM runs WHERE id = 1').status, 'lost');
  await tick(store, { wait: true });

  assert.equal(lines(ledger).length, 1, 'merged once, even though the event ran twice');
  assert.equal(store.get('SELECT status FROM events').status, 'done');
  const retryPrompt = fs.readFileSync(path.join(dir, 'prompt-2.txt'), 'utf8');
  assert.match(retryPrompt, /this is a retry/);
  assert.match(retryPrompt, /merge-pr-42: DONE \(sha abc123\)/);
});

test('ledger: a crash between "begin" and "done" is reported as unknown, not silently redone', async (t) => {
  const { dir, store } = setup(t);
  const ledger = path.join(dir, 'outside-world.txt');
  const ac = `AGENT_CRON_HOME="${dir}" "${process.execPath}" "${CLI}"`;
  connectAgent(store, {
    name: 'bot', cwd: dir,
    command: `cat > "${dir}/prompt-$AGENT_CRON_RUN_ID.txt"
${ac} action begin send-invoice-7
echo "begin exit $?" >> "${dir}/codes.txt"
[ "$AGENT_CRON_RUN_ID" = 1 ] && { echo sent >> "${ledger}"; ${DIE}; }
exit 0`,
  });
  pushEvent(store, { agent: 'bot', prompt: 'send invoice 7' });

  await tick(store, { wait: true });
  await tick(store, { wait: true });
  assert.deepEqual(lines(path.join(dir, 'codes.txt')), ['begin exit 0', 'begin exit 11']);
  assert.equal(lines(ledger).length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'prompt-2.txt'), 'utf8'), /send-invoice-7: STARTED, outcome unknown/);
});

test('--max-attempts N: tries exactly N times, set from the command line', async (t) => {
  const { dir, store } = setup(t, { command: 'cat > /dev/null; exit 1' });
  const { execFileSync } = await import('node:child_process');
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CRON_HOME: dir }, encoding: 'utf8', stdio: 'pipe' });
  cli('push', '--max-attempts', '5', '--prompt', 'five tries');
  cli('add', '--max-attempts', '2', '--prompt', 'two tries');
  assert.throws(() => cli('add', '--max-attempts', '0', '--prompt', 'x'), /whole number/);
  assert.throws(() => cli('add', '--max-attempts', '2', '--no-retry', '--prompt', 'x'), /only one/);
  assert.equal(store.get('SELECT max_attempts m FROM timers').m, 2);

  let runs = 0;
  for (let i = 0; i < 8; i++) runs += (await tick(store, { now: Date.now() + i * MIN, wait: true })).runs.length;
  assert.equal(runs, 5);
  assert.deepEqual(store.all('SELECT attempts, status FROM events ORDER BY id').map((e) => [e.attempts, e.status]),
    [[5, 'failed'], [2, 'failed']]);
});

test('rm-event, clean and rm-agent delete finished things and leave waiting work alone', async (t) => {
  const { dir, store } = setup(t);
  const { execFileSync } = await import('node:child_process');
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CRON_HOME: dir }, encoding: 'utf8', stdio: 'pipe' });
  const count = (table) => store.get(`SELECT COUNT(*) n FROM ${table}`).n;

  cli('add', '--prompt', 'finishes now');
  cli('push', '--prompt', 'also finishes');
  await tick(store, { wait: true });
  cli('add', '--in', '2h', '--prompt', 'still waiting');
  cli('push', '--prompt', 'waiting event A');
  cli('push', '--prompt', 'waiting event B');
  assert.ok(fs.existsSync(path.join(dir, 'runs', '1.log')));

  assert.match(cli('rm-event', '4', '99'), /Event 4 deleted[\s\S]*Event 99: not found/);
  assert.match(cli('clean', '--older', '1h'), /0 event\(s\), 0 timer\(s\), 0 run\(s\)/, 'too recent to clean');
  assert.match(cli('clean'), /2 event\(s\), 1 timer\(s\), 1 run\(s\)/);
  assert.deepEqual([count('events'), count('timers'), count('runs')], [1, 1, 0]);
  assert.equal(store.get('SELECT prompt FROM events').prompt, 'waiting event A');
  assert.equal(store.get('SELECT status FROM timers').status, 'active');
  assert.ok(!fs.existsSync(path.join(dir, 'runs', '1.log')), 'run files go too');

  connectAgent(store, { name: 'temp', command: 'cat > /dev/null' });
  cli('push', '--agent', 'temp', '--prompt', 'x');
  assert.match(cli('rm-agent', 'temp'), /Deleted agent temp with 0 timer\(s\), 1 event\(s\)/);
  assert.deepEqual(store.all('SELECT name FROM agents').map((a) => a.name), ['bot']);
  assert.equal(count('events'), 1);
});

test('a paused event stays in the inbox and wakes nobody until it is resumed', async (t) => {
  const { dir, store, woke } = setup(t);
  const { execFileSync } = await import('node:child_process');
  const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CRON_HOME: dir }, encoding: 'utf8', stdio: 'pipe' });
  cli('push', '--prompt', 'held back');
  cli('push', '--prompt', 'goes ahead');
  assert.match(cli('pause-event', '1'), /Event 1 paused/);
  assert.match(cli('events'), /paused/, 'still listed');

  let r = await tick(store, { wait: true });
  assert.equal(r.runs.length, 1);
  assert.doesNotMatch(woke(r.runs[0]), /held back/);
  assert.equal((await tick(store, { wait: true })).runs.length, 0, 'a paused event alone wakes nobody');
  assert.match(cli('clean'), /1 event\(s\)/, 'clean leaves the paused one');
  assert.match(cli('pause-event', '1', '2'), /Event 1 is paused[\s\S]*Event 2: not found/);

  assert.match(cli('resume-event', '1'), /waiting again/);
  r = await tick(store, { wait: true });
  assert.match(woke(r.runs[0]), /held back/);
  assert.equal(store.get('SELECT status FROM events WHERE id = 1').status, 'done');
});

test('an old database is upgraded to allow paused events without losing rows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cron-old-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = openStore(dir);
  connectAgent(store, { name: 'bot', command: 'cat > /dev/null' });
  pushEvent(store, { agent: 'bot', source: 'gh', sourceId: 'x1', prompt: 'keep me', maxAttempts: 4 });
  // Put the table back the way older versions made it.
  store.db.exec(`ALTER TABLE events RENAME TO e2; DROP INDEX events_pending;
    CREATE TABLE events (id INTEGER PRIMARY KEY, agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
      source TEXT NOT NULL, source_id TEXT NOT NULL, timer_id INTEGER, title TEXT, prompt TEXT NOT NULL, context TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, run_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (agent, source, source_id));
    INSERT INTO events SELECT id, agent, source, source_id, timer_id, title, prompt, context, status, attempts, run_id, created_at, updated_at FROM e2;
    DROP TABLE e2; ALTER TABLE events ADD COLUMN max_attempts INTEGER; UPDATE events SET max_attempts = 4;`);
  assert.throws(() => store.run(`UPDATE events SET status = 'paused'`), /CHECK/);
  store.close();

  store = openStore(dir);
  t.after(() => store.close());
  const e = store.get('SELECT * FROM events');
  assert.deepEqual([e.prompt, e.max_attempts, e.source_id], ['keep me', 4, 'x1']);
  store.run(`UPDATE events SET status = 'paused'`);
  assert.equal(pushEvent(store, { agent: 'bot', source: 'gh', sourceId: 'x1', prompt: 'dup' }), null, 'dedupe rule survived');
});

// ---- Per-event reporting: one bad event must not drag the rest of the batch down. ----

test('reported events keep their own result; unreported ones follow the run', async (t) => {
  const { dir, store } = setup(t);
  const ac = `AGENT_CRON_HOME="${dir}" "${process.execPath}" "${CLI}"`;
  connectAgent(store, {
    name: 'bot', cwd: dir,
    command: `cat > "${dir}/prompt-$AGENT_CRON_RUN_ID.txt"
${ac} event done 1 >> "${dir}/out.txt"
${ac} event fail 2 --note "api down" >> "${dir}/out.txt"
exit 0`,
  });
  for (const p of ['one', 'two', 'three']) pushEvent(store, { agent: 'bot', prompt: p });

  await tick(store, { wait: true });
  assert.deepEqual(store.all('SELECT status, attempts FROM events ORDER BY id').map((e) => [e.status, e.attempts]),
    [['done', 1], ['pending', 1], ['done', 1]], 'run exited 0, yet event 2 goes back; event 3 was not reported so it follows the run');
  assert.match(fs.readFileSync(path.join(dir, 'prompt-1.txt'), 'utf8'), /agent-cron event done <id>/);
  assert.match(store.all(`SELECT message FROM activity WHERE kind = 'event'`).map((a) => a.message).join('\n'), /event 2 .* reported failed by run 1: api down/);

  await tick(store, { wait: true });
  const retry = fs.readFileSync(path.join(dir, 'prompt-2.txt'), 'utf8');
  assert.match(retry, /1 event is waiting/, 'only the failed one comes back');
  assert.match(retry, /\(id 2, source manual, attempt 2\)/);
  assert.match(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), /Event 1: not recorded, it is done/, 'a finished event cannot be re-reported');

  await tick(store, { wait: true });
  assert.deepEqual({ ...store.get('SELECT status, attempts FROM events WHERE id = 2') }, { status: 'failed', attempts: 3 });
});

test('an event reported done before a crash is not handed out again', async (t) => {
  const { dir, store } = setup(t);
  const ac = `AGENT_CRON_HOME="${dir}" "${process.execPath}" "${CLI}"`;
  connectAgent(store, { name: 'bot', cwd: dir, command: `cat > /dev/null; ${ac} event done 1; ${DIE}` });
  pushEvent(store, { agent: 'bot', prompt: 'finished before the crash' });
  pushEvent(store, { agent: 'bot', prompt: 'never reached', maxAttempts: 1 });
  pushEvent(store, { agent: 'bot', prompt: 'also never reached' });

  await tick(store, { wait: true });
  assert.equal(store.get('SELECT status FROM runs').status, 'lost');
  assert.deepEqual(store.all('SELECT status FROM events ORDER BY id').map((e) => e.status), ['done', 'failed', 'pending']);
});

test('an agent can only report events of its own run', async (t) => {
  const { dir, store } = setup(t, { command: 'cat > /dev/null; sleep 0.5' });
  const { spawnSync } = await import('node:child_process');
  const cli = (env, ...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CRON_HOME: dir, ...env }, encoding: 'utf8' });
  pushEvent(store, { agent: 'bot', prompt: 'x' });
  const { runs: [run] } = await tick(store);
  let r = cli({ AGENT_CRON_RUN_ID: String(run + 5) }, 'event', 'done', '1');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /belongs to run 1/);
  r = cli({ AGENT_CRON_RUN_ID: String(run) }, 'event', 'done', '1', '7');
  assert.match(r.stdout, /Event 1 recorded as done[\s\S]*Event 7: not recorded, not found/);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await tick(store, { wait: true });
  assert.equal(store.get('SELECT status FROM events').status, 'done');
});

// ---- followup: the narrow way for a woken agent to schedule itself ----

test('followup: one-off, self only, only inside a live run, and capped', async (t) => {
  const { dir, store } = setup(t, { command: 'cat > /dev/null; sleep 1.5' });
  connectAgent(store, { name: 'other', command: 'cat > /dev/null' });
  const { spawnSync } = await import('node:child_process');
  const cli = (env, ...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CRON_HOME: dir, AGENT_CRON_AGENT: '', AGENT_CRON_RUN_ID: '', ...env }, encoding: 'utf8' });
    return `${r.status}|${r.stdout}${r.stderr}`;
  };
  assert.match(cli({}, 'followup', '--in', '1h', '--prompt', 'x'), /^1\|.*only works inside a run/s, 'a person outside a run cannot use it');

  pushEvent(store, { agent: 'bot', prompt: 'start' });
  const { runs: [run] } = await tick(store);
  const me = { AGENT_CRON_AGENT: 'bot', AGENT_CRON_RUN_ID: String(run) };

  assert.match(cli(me, 'followup', '--in', '2h', '--name', 'recheck', '--prompt', 'look again'), /^0\|Follow-up scheduled: timer 1/);
  const timer = store.get('SELECT * FROM timers WHERE id = 1');
  assert.deepEqual([timer.agent, timer.kind, timer.check_cmd, timer.origin_run], ['bot', 'once', null, run]);

  // Everything that would widen it is refused.
  for (const extra of [['--check', 'rm -rf ~'], ['--every', '1m'], ['--cron', '* * * * *'], ['--agent', 'other'], ['--max-attempts', '20']]) {
    assert.match(cli(me, 'followup', '--in', '2h', '--prompt', 'x', ...extra), /^1\|.*Unknown option/s, extra[0]);
  }
  assert.match(cli(me, 'followup', '--in', '10s', '--prompt', 'x'), /at least 1 minute/);
  assert.match(cli(me, 'followup', '--in', '90d', '--prompt', 'x'), /within 30 days/);
  assert.match(cli(me, 'followup', '--prompt', 'x'), /exactly one of --in/);
  assert.match(cli(me, 'followup', '--in', '1h', '--at', '09:00', '--prompt', 'x'), /exactly one of --in/);
  assert.match(cli(me, 'followup', '--in', '1h', '--prompt', 'y'.repeat(4001)), /too long/);
  assert.match(cli({ ...me, AGENT_CRON_AGENT: 'other' }, 'followup', '--in', '1h', '--prompt', 'x'), /only works inside a run/, 'cannot pose as another agent');
  assert.match(cli({ ...me, AGENT_CRON_RUN_ID: '999' }, 'followup', '--in', '1h', '--prompt', 'x'), /only works inside a run/);

  // Cap on how many may wait at once.
  for (let i = 2; i <= 5; i++) assert.match(cli(me, 'followup', '--in', '1h', '--prompt', `n${i}`), /^0\|/);
  assert.match(cli(me, 'followup', '--in', '1h', '--prompt', 'six'), /^1\|.*5 follow-ups are already waiting/s);
  assert.equal(store.get('SELECT COUNT(*) n FROM timers').n, 5);

  // Cap per day: even after the waiting ones finish, the daily count still applies.
  store.run(`UPDATE timers SET status = 'done'`);
  assert.match(cli({ ...me, AGENT_CRON_FOLLOWUP_MAX_PER_DAY: '5' }, 'followup', '--in', '1h', '--prompt', 'x'), /5 follow-ups were added in the last 24 hours/);
  assert.match(cli(me, 'followup', '--in', '1h', '--prompt', 'ok under the default of 20'), /^0\|/);

  await new Promise((resolve) => setTimeout(resolve, 1800));
  await tick(store, { wait: true });
  assert.match(cli(me, 'followup', '--in', '1h', '--prompt', 'x'), /only works inside a run/, 'the run is over, so its id no longer works');
});

test('followup: the timer wakes the same agent later, like any other', async (t) => {
  const { dir, store, woke } = setup(t);
  const ac = `AGENT_CRON_HOME="${dir}" "${process.execPath}" "${CLI}"`;
  connectAgent(store, {
    name: 'bot', cwd: dir,
    command: `cat > "${dir}/woke-$AGENT_CRON_RUN_ID.txt"; [ "$AGENT_CRON_RUN_ID" = 1 ] && ${ac} followup --in 30m --name later --prompt "second visit"; exit 0`,
  });
  const now = Date.now();
  pushEvent(store, { agent: 'bot', prompt: 'first visit' });
  await tick(store, { now, wait: true });
  assert.match(woke(1), /agent-cron followup --in 2h/, 'the wake prompt teaches the command');
  assert.equal((await tick(store, { now: now + 29 * MIN, wait: true })).fired, 0);
  const r = await tick(store, { now: now + 31 * MIN, wait: true });
  assert.equal(r.fired, 1);
  assert.match(woke(r.runs[0]), /second visit/);
  assert.equal(store.get('SELECT COUNT(*) n FROM timers').n, 1, 'and it did not schedule yet another one');
});

// ---- Failure reasons are stored with the event and can be read back later. ----

test('every try of an event is recorded with how it ended and why', async (t) => {
  const { dir, store } = setup(t);
  const { spawnSync } = await import('node:child_process');
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CRON_HOME: dir, AGENT_CRON_RUN_ID: '' }, encoding: 'utf8' }).stdout;
  const ac = `AGENT_CRON_HOME="${dir}" "${process.execPath}" "${CLI}"`;
  // Try 1: the agent reports a failure with a reason. Try 2: it exits 7 without reporting. Try 3: it crashes.
  connectAgent(store, {
    name: 'bot', cwd: dir,
    command: `cat > /dev/null
case "$AGENT_CRON_RUN_ID" in
  1) ${ac} event fail 1 --note "API returned 503 on POST /merge"; ${ac} event done 2 ;;
  2) exit 7 ;;
  3) ${DIE} ;;
esac`,
  });
  pushEvent(store, { agent: 'bot', title: 'merge PR 42', prompt: 'merge it' });
  pushEvent(store, { agent: 'bot', title: 'fine one', prompt: 'easy' });
  for (let i = 0; i < 3; i++) await tick(store, { wait: true });

  assert.deepEqual(store.all('SELECT attempt, run_id, outcome, said_by FROM attempts WHERE event_id = 1 ORDER BY attempt').map((a) => Object.values(a)),
    [[1, 1, 'failed', 'agent'], [2, 2, 'failed', 'run'], [3, 3, 'lost', 'run']]);
  assert.deepEqual(store.all('SELECT outcome, said_by FROM attempts WHERE event_id = 2').map((a) => Object.values(a)), [['done', 'agent']]);
  assert.equal(store.get('SELECT status FROM events WHERE id = 1').status, 'failed');

  const story = cli('show-event', '1');
  assert.match(story, /Tries:\s+3 used of 3/);
  assert.match(story, /#1 .* run 1 +FAILED +\(reported by the agent\)\n +why: API returned 503 on POST \/merge/);
  assert.match(story, /#2 .* run 2 +FAILED .*\n +why: the run exited with code 7 and the agent did not report/);
  assert.match(story, /#3 .* run 3 +CRASHED .*\n +why: the run ended without a result/);
  assert.match(story, /agent-cron show-run 1 +agent-cron show-run 2 +agent-cron show-run 3/);

  const failed = cli('events', '--failed');
  assert.match(failed, /merge PR 42 +the run ended without a result/);
  assert.doesNotMatch(failed, /fine one/);

  // clean keeps the failed event, its history and its run logs; --failed removes them.
  assert.match(cli('clean'), /Cleaned: 1 event\(s\), 0 timer\(s\), 0 run\(s\)[\s\S]*Kept 1 failed event/);
  assert.match(cli('show-event', '1'), /API returned 503/);
  assert.ok(fs.existsSync(path.join(dir, 'runs', '1.log')));
  assert.match(cli('clean', '--failed'), /Cleaned: 1 event\(s\), 0 timer\(s\), 3 run\(s\)/);
  assert.equal(store.get('SELECT COUNT(*) n FROM attempts').n, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'runs', '1.log')));
});

test('a timed-out run is recorded as the reason', async (t) => {
  const { store } = setup(t, { command: 'cat > /dev/null; sleep 30' });
  pushEvent(store, { agent: 'bot', prompt: 'slow', maxAttempts: 1 });
  const now = Date.now();
  await tick(store, { now });
  recoverRuns(store, now + 31 * 60_000);
  const a = store.get('SELECT outcome, reason FROM attempts');
  assert.equal(a.outcome, 'timeout');
  assert.match(a.reason, /went over its time limit/);
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test('tables line up when titles contain Chinese', async (t) => {
  const { displayWidth, clip } = await import('../src/cli.js');
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('原因测试'), 8);
  assert.equal(displayWidth('PR 跟进 ✅'.replace(' ✅', '')), 7);
  assert.equal(displayWidth('ＡＢ'), 4);
  assert.equal(clip('整理收件箱里的所有邮件并归档', 12), '整理收件箱…');
  assert.ok(displayWidth(clip('整理收件箱里的所有邮件并归档', 12)) <= 12);
  assert.equal(clip('short', 12), 'short');

  const { dir, store } = setup(t);
  const { execFileSync } = await import('node:child_process');
  pushEvent(store, { agent: 'bot', title: '原因测试', prompt: 'x' });
  pushEvent(store, { agent: 'bot', title: 'plain title', prompt: 'x' });
  pushEvent(store, { agent: 'bot', title: '混合 mixed 标题', prompt: 'x' });
  const out = execFileSync(process.execPath, [CLI, 'events'], { env: { ...process.env, AGENT_CRON_HOME: dir }, encoding: 'utf8' });
  const rows = out.trimEnd().split('\n');
  // The column after TITLE must start at the same terminal column on every row.
  const starts = rows.map((r) => displayWidth(r.slice(0, r.lastIndexOf('-'))));
  const head = displayWidth(rows[0].slice(0, rows[0].indexOf('LAST PROBLEM')));
  assert.deepEqual(starts.slice(1), [head, head, head]);
});
