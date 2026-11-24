// Command line front end. `agent-cron help` lists everything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore, connectAgent, addTimer, pushEvent, beginAction, finishAction, addFollowup } from './store.js';
import { tick, alive, reportEvent } from './engine.js';
import { parseDuration, parseAt, parseCron, nextCron, describeSchedule, formatTime } from './schedule.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'agent-cron.js');
const SERVICE_LABEL = 'com.agent-cron.daemon';
const PRESETS = { claude: 'claude -p', codex: 'codex exec -' };

const HELP = `agent-cron - always-on wake-ups shared by AI agents

Setup
  connect <agent> [--command "<cmd>"] [--cwd <dir>] [--timeout 30m]
                              register an agent; the wake prompt goes to the command's stdin
                              (presets: claude = "claude -p", codex = "codex exec -")
  disconnect <agent>          stop waking it (timers and events are kept)
  rm-agent <agent>            delete an agent and everything it owns (timers, events, runs)
  agents                      list agents
  daemon                      run the scheduler in the foreground (checks every minute)
  service install|uninstall   macOS launchd: start at login, restart if it dies
  skill install [--dir <skills dir>]   copy the skill (default ~/.claude/skills)
  status                      is the daemon alive, what is waiting

Events
  add --prompt "<what to do>" [--name <title>] [--agent <agent>]
      [--in 30m | --at 09:00 | --every 15m | --cron "0 9 * * 1-5"]   (none = next minute)
      [--check "<shell cmd>"]   exit 0 = wake the agent, anything else = skip
      [--expires 6h] [--max-fires N]
      [--max-attempts N]        how many times to try if the run fails or crashes (default 3)
      [--no-retry]              same as --max-attempts 1 (for merge / send / pay)
  push --prompt "<what to do>" [--name <title>] [--source <src> --id <unique id>] [--context <text>]
       [--max-attempts N | --no-retry]
                              put work in the inbox right now (duplicates of source+id are ignored)
  list [--all]                timers
  show <id>                   everything about one timer: when, gate, retry rule, prompt, history
  pause|resume|rm <id>        change a timer (a paused timer adds nothing to the inbox)
  events [--all | --failed]   the inbox (--failed: only the ones given up on, with the reason)
  show-event <id>             everything about one event: every try, how it ended and why
  pause-event <id> [<id>...]  hold a waiting event: it stays in the inbox but no agent is woken for it
  resume-event <id> [<id>...] let a paused event go again
  rm-event <id> [<id>...]     delete events (not ones that are running)
  clean [--older 7d] [--failed]
                              delete finished things: done events, done/expired/cancelled timers, finished
                              runs and their logs, and history. Waiting work is never touched. Failed events
                              and their run logs are kept so you can read why, unless you add --failed
  runs                        past wake-ups
  show-run <id>               prompt and output of one wake-up
  log [-n 30]                 fires, skips and runs
  tick                        do one check now and wait for the agents to finish

Follow-up (for agents: the safe way for a woken run to come back later)
  followup --prompt "<what to do then>" (--in 2h | --at 09:00) [--name <title>]
                              one-off, for yourself only, no check command; at most 5 waiting and 20 a day

Reporting (for agents: say how each event went, so one bad event does not drag down the batch)
  event done <id> [<id>...] [--note <text>]
  event fail <id> [<id>...] [--note <text>]    retried later if tries remain

Ledger (for agents: wrap any action that must not happen twice)
  action begin <key> [--force]   exit 0 = go ahead, 10 = already done, 11 = started before, outcome unknown
  action done <key> [--note <text>]
  action list
`;

function parse(argv, options = {}) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}
const str = { type: 'string' };
const flag = { type: 'boolean' };

// Chinese, Japanese, Korean, full-width forms and emoji take two columns in a terminal.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const ZERO = /[\p{Mn}\p{Me}​-‍︎️]/u;
const charWidth = (ch) => (ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1);

export function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch);
  return w;
}

const padEnd = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

function table(rows, cols) {
  if (!rows.length) return console.log('(nothing)');
  const cells = rows.map((r) => cols.map(([, get]) => String(get(r) ?? '-')));
  const widths = cols.map(([head], i) => Math.max(displayWidth(head), ...cells.map((c) => displayWidth(c[i]))));
  const line = (c) => c.map((v, i) => padEnd(v, widths[i])).join('  ').trimEnd();
  console.log(line(cols.map(([head]) => head)));
  cells.forEach((c) => console.log(line(c)));
}

// Shorten to at most n terminal columns (not n characters), on one line.
export function clip(text, n = 40) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (displayWidth(one) <= n) return one;
  let out = '';
  let w = 0;
  for (const ch of one) {
    if (w + charWidth(ch) > n - 1) break;
    out += ch;
    w += charWidth(ch);
  }
  return `${out}…`;
}

function resolveAgent(store, given) {
  const name = given || process.env.AGENT_CRON_AGENT;
  if (name) {
    if (!store.get('SELECT 1 FROM agents WHERE name = ?', name)) {
      throw new Error(`unknown agent "${name}". Run: agent-cron connect ${name}`);
    }
    return name;
  }
  const connected = store.all('SELECT name FROM agents WHERE connected = 1');
  if (connected.length === 1) return connected[0].name;
  if (!connected.length) throw new Error('no agent is connected. Run: agent-cron connect claude');
  throw new Error(`several agents are connected (${connected.map((a) => a.name).join(', ')}). Pick one with --agent`);
}

const defaultAttempts = () => Number(process.env.AGENT_CRON_MAX_ATTEMPTS) || 3;

// --max-attempts N / --no-retry -> a number, or null for the default.
function attemptLimit(v) {
  if (v['no-retry'] && v['max-attempts'] !== undefined) throw new Error('use only one of --no-retry and --max-attempts');
  if (v['no-retry']) return 1;
  if (v['max-attempts'] === undefined) return null;
  const n = Number(v['max-attempts']);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--max-attempts must be a whole number from 1 to 20');
  return n;
}

function daemonPid(store) {
  const pid = Number(store.getMeta('daemon_pid'));
  return pid && alive(pid) ? pid : null;
}

const commands = {
  connect(store, argv) {
    const { values: v, positionals: [name] } = parse(argv, { command: str, cwd: str, timeout: str });
    if (!name) throw new Error('usage: agent-cron connect <agent> [--command "<cmd>"]');
    const existing = store.get('SELECT * FROM agents WHERE name = ?', name);
    const command = v.command || existing?.command || PRESETS[name];
    if (!command) throw new Error(`no preset for "${name}". Give --command "<cmd that reads a prompt on stdin>"`);
    const cwd = v.cwd ? path.resolve(v.cwd) : existing?.cwd ?? null;
    if (cwd && !fs.existsSync(cwd)) throw new Error(`no such directory: ${cwd}`);
    const agent = connectAgent(store, { name, command, cwd, timeoutMs: v.timeout ? parseDuration(v.timeout) : null });
    console.log(`Connected ${agent.name}: ${agent.command}${agent.cwd ? `  (in ${agent.cwd})` : ''}`);
    if (!daemonPid(store)) console.log('The daemon is not running. Start it: agent-cron daemon  (or: agent-cron service install)');
  },

  disconnect(store, argv) {
    const { positionals: [name] } = parse(argv);
    const { changes } = store.run('UPDATE agents SET connected = 0, updated_at = ? WHERE name = ?', Date.now(), name ?? '');
    if (!changes) throw new Error(`unknown agent "${name}"`);
    console.log(`Disconnected ${name}. Its timers and events are kept but nothing will fire.`);
  },

  agents(store) {
    table(store.all('SELECT * FROM agents ORDER BY name'), [
      ['AGENT', (a) => a.name], ['CONNECTED', (a) => (a.connected ? 'yes' : 'no')],
      ['COMMAND', (a) => a.command], ['CWD', (a) => a.cwd],
    ]);
  },

  add(store, argv) {
    const { values: v } = parse(argv, {
      prompt: str, name: str, agent: str, in: str, at: str, every: str, cron: str,
      check: str, expires: str, 'max-fires': str, 'no-retry': flag, 'max-attempts': str,
    });
    if (!v.prompt?.trim()) throw new Error('--prompt is required: say what the agent should do when woken');
    if (['in', 'at', 'every', 'cron'].filter((k) => v[k] !== undefined).length > 1) {
      throw new Error('use only one of --in, --at, --every, --cron');
    }
    const now = Date.now();
    const t = { agent: resolveAgent(store, v.agent), name: v.name, prompt: v.prompt, check: v.check, kind: 'once', nextDueAt: now };
    if (v.in) t.nextDueAt = now + parseDuration(v.in);
    if (v.at) t.nextDueAt = parseAt(v.at, now);
    if (v.every) {
      const ms = parseDuration(v.every);
      if (ms < 60_000) throw new Error('--every must be at least 1m');
      Object.assign(t, { kind: 'every', spec: String(ms), nextDueAt: now + ms });
    }
    if (v.cron) {
      parseCron(v.cron);
      Object.assign(t, { kind: 'cron', spec: v.cron, nextDueAt: nextCron(v.cron, now) });
    }
    t.maxAttempts = attemptLimit(v);
    if (v.expires) t.expiresAt = now + parseDuration(v.expires);
    if (v['max-fires']) {
      t.maxFires = Number(v['max-fires']);
      if (!Number.isInteger(t.maxFires) || t.maxFires < 1) throw new Error('--max-fires must be a whole number, 1 or more');
    }
    const timer = addTimer(store, t, now);
    const when = timer.next_due_at <= now ? 'within a minute' : formatTime(timer.next_due_at);
    console.log(`Added timer ${timer.id} for ${timer.agent} (${describeSchedule(timer)}). Next check: ${when}.`);
    if (timer.check_cmd && timer.kind === 'once' && !timer.expires_at) {
      console.log('Note: this check repeats every minute until it passes. Add --expires to give up after a while.');
    }
    if (!daemonPid(store)) console.log('Warning: the daemon is not running, so nothing will fire. Start it: agent-cron daemon');
  },

  push(store, argv) {
    const { values: v } = parse(argv, { prompt: str, name: str, agent: str, source: str, id: str, context: str, 'no-retry': flag, 'max-attempts': str });
    if (!v.prompt?.trim()) throw new Error('--prompt is required');
    const event = pushEvent(store, {
      agent: resolveAgent(store, v.agent), source: v.source, sourceId: v.id, title: v.name, prompt: v.prompt, context: v.context,
      maxAttempts: attemptLimit(v),
    });
    console.log(event ? `Added event ${event.id} to the inbox of ${event.agent}.` : 'Duplicate: that source and id are already in the inbox. Ignored.');
  },

  list(store, argv) {
    const { values: v } = parse(argv, { all: flag, agent: str });
    const rows = store.all(
      `SELECT * FROM timers WHERE (? OR status IN ('active','paused')) AND (? IS NULL OR agent = ?) ORDER BY id`,
      v.all ? 1 : 0, v.agent ?? null, v.agent ?? null);
    table(rows, [
      ['ID', (t) => t.id], ['AGENT', (t) => t.agent], ['STATUS', (t) => t.status],
      ['WHEN', describeSchedule], ['NEXT', (t) => (t.status === 'active' ? formatTime(t.next_due_at) : '-')],
      ['FIRED', (t) => t.fire_count], ['SKIPPED', (t) => t.skip_count],
      ['CHECK', (t) => (t.check_cmd ? clip(t.check_cmd, 24) : '-')], ['TRIES', (t) => t.max_attempts ?? defaultAttempts()], ['NAME', (t) => clip(t.name || t.prompt)],
    ]);
  },

  show(store, argv) {
    const { positionals: [id] } = parse(argv);
    const t = store.get('SELECT * FROM timers WHERE id = ?', Number(id));
    if (!t) throw new Error(`no timer ${id}`);
    const tries = t.max_attempts ?? defaultAttempts();
    const rows = [
      ['Timer', `${t.id}${t.name ? `  "${t.name}"` : ''}`],
      ['Agent', t.agent],
      ['Status', t.status],
      ['When', describeSchedule(t)],
      ['Next check', t.status === 'active' ? (t.next_due_at <= Date.now() ? 'within a minute' : formatTime(t.next_due_at)) : '-'],
      ['Gate', t.check_cmd ? `wakes the agent only if this exits 0:  ${t.check_cmd}` : 'none: wakes the agent every time it is due'],
      ['If the run fails', tries === 1 ? 'no retry (runs at most once)' : `retry, up to ${tries} tries in total`],
      ['Expires', formatTime(t.expires_at)],
      ['Max fires', t.max_fires ?? 'no limit'],
      ['Fired / skipped', `${t.fire_count} / ${t.skip_count}`],
      ['Last fired', formatTime(t.last_fired_at)],
      ['Last checked', formatTime(t.last_checked_at)],
      ['Created', formatTime(t.created_at)],
      ['Added by', t.origin_run ? `the agent itself, as a follow-up from run ${t.origin_run}` : 'a person or script (agent-cron add)'],
    ];
    for (const [k, val] of rows) console.log(`${`${k}:`.padEnd(18)}${val}`);
    console.log(`\nPrompt:\n${t.prompt.trim().replace(/^/gm, '  ')}`);
    const events = store.all('SELECT * FROM events WHERE timer_id = ? ORDER BY id DESC LIMIT 5', t.id).reverse();
    if (events.length) {
      console.log('\nEvents it created (newest last):');
      table(events, [['ID', (e) => e.id], ['STATUS', (e) => e.status], ['TRIES', (e) => e.attempts], ['RUN', (e) => e.run_id], ['CREATED', (e) => formatTime(e.created_at)]]);
    }
    const history = store.all('SELECT * FROM activity WHERE timer_id = ? ORDER BY id DESC LIMIT 8', t.id).reverse();
    if (history.length) {
      console.log('\nRecent history:');
      table(history, [['TIME', (a) => formatTime(a.at)], ['KIND', (a) => a.kind], ['WHAT', (a) => a.message]]);
    }
  },

  pause: (store, argv) => setTimerStatus(store, argv, 'paused', ['active']),
  resume: (store, argv) => setTimerStatus(store, argv, 'active', ['paused']),
  rm: (store, argv) => setTimerStatus(store, argv, 'cancelled', ['active', 'paused']),

  events(store, argv) {
    const { values: v } = parse(argv, { all: flag, failed: flag });
    const want = v.failed ? `status = 'failed'` : v.all ? '1' : `status IN ('pending','paused','running')`;
    const rows = store.all(
      `SELECT * FROM (
         SELECT e.*, a.outcome AS last_outcome, a.reason AS last_reason FROM events e
         LEFT JOIN attempts a ON a.event_id = e.id AND a.attempt = (SELECT MAX(attempt) FROM attempts WHERE event_id = e.id)
         WHERE ${want} ORDER BY e.id DESC LIMIT 50) ORDER BY id`);
    table(rows, [
      ['ID', (e) => e.id], ['AGENT', (e) => e.agent], ['STATUS', (e) => e.status], ['SOURCE', (e) => e.source],
      ['TRIES', (e) => e.attempts], ['RUN', (e) => e.run_id], ['CREATED', (e) => formatTime(e.created_at)],
      ['TITLE', (e) => clip(e.title || e.prompt, 28)],
      ['LAST PROBLEM', (e) => (e.last_outcome && e.last_outcome !== 'done' ? clip(e.last_reason || e.last_outcome, 60) : '-')],
    ]);
    if (rows.some((e) => e.last_outcome && e.last_outcome !== 'done')) console.log('\nFull story of one event: agent-cron show-event <id>');
  },

  'show-event'(store, argv) {
    const { positionals: [id] } = parse(argv);
    const e = store.get('SELECT * FROM events WHERE id = ?', Number(id));
    if (!e) throw new Error(`no event ${id}`);
    const limit = e.max_attempts ?? defaultAttempts();
    const rows = [
      ['Event', `${e.id}${e.title ? `  "${e.title}"` : ''}`],
      ['Agent', e.agent],
      ['Status', e.status],
      ['Tries', `${e.attempts} used of ${limit}`],
      ['Came from', e.timer_id ? `timer ${e.timer_id}` : `${e.source} (${e.source_id})`],
      ['Created', formatTime(e.created_at)],
      ['Last change', formatTime(e.updated_at)],
    ];
    for (const [k, val] of rows) console.log(`${`${k}:`.padEnd(14)}${val}`);
    console.log(`\nPrompt:\n${e.prompt.trim().replace(/^/gm, '  ')}`);
    if (e.context) console.log(`\nCheck output it came with:\n${e.context.trim().replace(/^/gm, '  ')}`);
    const tries = store.all('SELECT * FROM attempts WHERE event_id = ? ORDER BY attempt', e.id);
    console.log('\nTries:');
    if (!tries.length) console.log(e.status === 'running' ? '  (first try is running now)' : '  (not tried yet)');
    for (const a of tries) {
      const how = { done: 'done', failed: 'FAILED', lost: 'CRASHED', timeout: 'TIMED OUT' }[a.outcome];
      const who = a.said_by === 'agent' ? 'reported by the agent' : 'not reported; taken from how the run ended';
      console.log(`  #${a.attempt}  ${formatTime(a.at)}  run ${a.run_id}  ${how}  (${who})`);
      if (a.reason) console.log(`      why: ${a.reason}`);
    }
    const runIds = [...new Set(tries.map((a) => a.run_id).filter(Boolean))];
    if (runIds.length) console.log(`\nWhat the agent said in full: ${runIds.map((r) => `agent-cron show-run ${r}`).join('   ')}`);
  },

  runs(store) {
    const rows = store.all('SELECT * FROM (SELECT * FROM runs ORDER BY id DESC LIMIT 30) ORDER BY id');
    table(rows, [
      ['ID', (r) => r.id], ['AGENT', (r) => r.agent], ['STATUS', (r) => r.status], ['EXIT', (r) => r.exit_code],
      ['EVENTS', (r) => r.event_ids], ['STARTED', (r) => formatTime(r.started_at)],
      ['TOOK', (r) => (r.ended_at ? `${Math.round((r.ended_at - r.started_at) / 1000)}s` : '-')],
    ]);
  },

  'show-run'(store, argv) {
    const { positionals: [id] } = parse(argv);
    const run = store.get('SELECT * FROM runs WHERE id = ?', Number(id));
    if (!run) throw new Error(`no run ${id}`);
    const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return '(missing)\n'; } };
    console.log(`Run ${run.id}  agent ${run.agent}  status ${run.status}  exit ${run.exit_code ?? '-'}  started ${formatTime(run.started_at)}`);
    console.log('\n===== prompt =====');
    process.stdout.write(read(path.join(store.dir, 'runs', `${run.id}.prompt.md`)));
    console.log('\n===== output =====');
    process.stdout.write(read(run.log_path));
  },

  log(store, argv) {
    const { values: v } = parse(argv, { n: { type: 'string', short: 'n' } });
    const rows = store.all('SELECT * FROM (SELECT * FROM activity ORDER BY id DESC LIMIT ?) ORDER BY id', Number(v.n) || 30);
    table(rows, [['TIME', (a) => formatTime(a.at)], ['AGENT', (a) => a.agent], ['KIND', (a) => a.kind], ['WHAT', (a) => a.message]]);
  },

  status(store) {
    const pid = daemonPid(store);
    const last = Number(store.getMeta('last_tick'));
    console.log(pid ? `Daemon: running (pid ${pid}), last check ${last ? formatTime(last) : 'not yet'}` : 'Daemon: NOT running');
    const count = (sql) => store.get(sql).n;
    console.log(`Agents connected: ${count('SELECT COUNT(*) n FROM agents WHERE connected = 1')}`);
    console.log(`Active timers:    ${count(`SELECT COUNT(*) n FROM timers WHERE status = 'active'`)}`);
    console.log(`Events waiting:   ${count(`SELECT COUNT(*) n FROM events WHERE status = 'pending'`)}`);
    console.log(`Events paused:    ${count(`SELECT COUNT(*) n FROM events WHERE status = 'paused'`)}`);
    const failed = count(`SELECT COUNT(*) n FROM events WHERE status = 'failed'`);
    console.log(`Events failed:    ${failed}${failed ? '   <- gave up on these. See why: agent-cron events --failed' : ''}`);
    console.log(`Runs in progress: ${count(`SELECT COUNT(*) n FROM runs WHERE status = 'running'`)}`);
    console.log(`Data: ${store.dir}`);
  },

  action(store, argv) {
    const { values: v, positionals: [verb, key] } = parse(argv, { agent: str, note: str, force: flag });
    if (verb === 'list') {
      return table(store.all('SELECT * FROM actions ORDER BY started_at'), [
        ['AGENT', (a) => a.agent], ['KEY', (a) => a.key], ['STATUS', (a) => a.status], ['RUN', (a) => a.run_id],
        ['STARTED', (a) => formatTime(a.started_at)], ['DONE', (a) => formatTime(a.done_at)], ['NOTE', (a) => clip(a.note)],
      ]);
    }
    if (!['begin', 'done'].includes(verb) || !key) throw new Error('usage: agent-cron action begin|done <key>  |  action list');
    const agent = resolveAgent(store, v.agent);
    const runId = Number(process.env.AGENT_CRON_RUN_ID) || null;
    if (verb === 'done') {
      finishAction(store, { agent, key, note: v.note, runId });
      return console.log(`Recorded: ${key} is done.`);
    }
    const result = beginAction(store, { agent, key, runId, force: v.force });
    if (result === 'new') return console.log(`OK: go ahead with ${key}. Run "agent-cron action done ${key}" right after it succeeds.`);
    if (result === 'done') {
      console.log(`SKIP: ${key} was already done. Do not do it again.`);
      process.exitCode = 10;
    } else {
      console.log(`UNKNOWN: ${key} was started by an earlier run that never reported back. Check the real system.\n` +
        `If it happened: agent-cron action done ${key}\nIf it did not: agent-cron action begin ${key} --force`);
      process.exitCode = 11;
    }
  },

  followup(store, argv) {
    // Deliberately few options: no --check, --every, --cron or --agent. Unknown options are rejected.
    const { values: v } = parse(argv, { prompt: str, name: str, in: str, at: str });
    if ((v.in === undefined) === (v.at === undefined)) throw new Error('give exactly one of --in <duration> or --at <time>');
    const now = Date.now();
    const timer = addFollowup(store, {
      agent: process.env.AGENT_CRON_AGENT, runId: Number(process.env.AGENT_CRON_RUN_ID) || null,
      dueAt: v.in ? now + parseDuration(v.in) : parseAt(v.at, now), prompt: v.prompt, name: v.name,
    }, now);
    console.log(`Follow-up scheduled: timer ${timer.id}, you will be woken around ${formatTime(timer.next_due_at)}.`);
  },

  event(store, argv) {
    const { values: v, positionals: [verb, ...ids] } = parse(argv, { note: str });
    if (!['done', 'fail'].includes(verb) || !ids.length) throw new Error('usage: agent-cron event done|fail <id> [<id>...] [--note <text>]');
    const runId = Number(process.env.AGENT_CRON_RUN_ID) || null;
    for (const id of ids) {
      const r = reportEvent(store, { id: Number(id), outcome: verb, runId, note: v.note });
      if (!r.ok) {
        console.log(`Event ${id}: not recorded, ${r.reason}.`);
        process.exitCode = 1;
      } else if (verb === 'done') console.log(`Event ${id} recorded as done.`);
      else console.log(r.status === 'pending' ? `Event ${id} recorded as failed. It will be tried again.` : `Event ${id} recorded as failed. No tries left, so it will not be tried again.`);
    }
  },

  'pause-event': (store, argv) => setEventStatus(store, argv, 'pending', 'paused'),
  'resume-event': (store, argv) => setEventStatus(store, argv, 'paused', 'pending'),

  'rm-event'(store, argv) {
    const { positionals: ids } = parse(argv);
    if (!ids.length) throw new Error('usage: agent-cron rm-event <id> [<id>...]');
    for (const id of ids) {
      const e = store.get('SELECT * FROM events WHERE id = ?', Number(id));
      if (!e) console.log(`Event ${id}: not found.`);
      else if (e.status === 'running') console.log(`Event ${id}: an agent is working on it right now. Not deleted.`);
      else {
        store.run('DELETE FROM events WHERE id = ?', e.id);
        console.log(`Event ${id} deleted (was ${e.status}).`);
      }
    }
  },

  'rm-agent'(store, argv) {
    const { positionals: [name] } = parse(argv);
    if (!name || !store.get('SELECT 1 FROM agents WHERE name = ?', name)) throw new Error(`unknown agent "${name ?? ''}"`);
    if (store.get(`SELECT 1 FROM runs WHERE agent = ? AND status = 'running'`, name)) {
      throw new Error(`${name} is running right now. Try again when it has finished`);
    }
    const runIds = store.all('SELECT id FROM runs WHERE agent = ?', name).map((r) => r.id);
    const n = store.tx(() => {
      const counts = {
        timers: store.get('SELECT COUNT(*) n FROM timers WHERE agent = ?', name).n,
        events: store.get('SELECT COUNT(*) n FROM events WHERE agent = ?', name).n,
      };
      for (const t of ['runs', 'actions', 'activity']) store.run(`DELETE FROM ${t} WHERE agent = ?`, name);
      store.run('DELETE FROM agents WHERE name = ?', name); // timers and events go with it
      return counts;
    });
    removeRunFiles(store, runIds);
    console.log(`Deleted agent ${name} with ${n.timers} timer(s), ${n.events} event(s), ${runIds.length} run(s).`);
  },

  clean(store, argv) {
    const { values: v } = parse(argv, { older: str, failed: flag });
    const before = Date.now() - (v.older ? parseDuration(v.older) : 0);
    const statuses = v.failed ? `'done','failed'` : `'done'`;
    let runIds = [];
    const n = store.tx(() => {
      const events = store.run(`DELETE FROM events WHERE status IN (${statuses}) AND updated_at <= ?`, before).changes;
      const timers = store.run(
        `DELETE FROM timers WHERE status IN ('done','expired','cancelled') AND COALESCE(last_checked_at, created_at) <= ?
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.timer_id = timers.id)`, before).changes;
      // Keep any run that an event still on record went through, so its log can still be read.
      runIds = store.all(
        `SELECT id FROM runs WHERE status != 'running' AND COALESCE(ended_at, started_at) <= ?
           AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.run_id = runs.id)
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = runs.id)`, before).map((r) => r.id);
      for (const id of runIds) store.run('DELETE FROM runs WHERE id = ?', id);
      const history = store.run('DELETE FROM activity WHERE at <= ?', before).changes;
      return { events, timers, runs: runIds.length, history };
    });
    removeRunFiles(store, runIds);
    console.log(`Cleaned: ${n.events} event(s), ${n.timers} timer(s), ${n.runs} run(s), ${n.history} history line(s).`);
    const kept = store.get(`SELECT COUNT(*) n FROM events WHERE status = 'failed'`).n;
    if (kept) console.log(`Kept ${kept} failed event(s) so you can read why: agent-cron events --failed   (delete them too: agent-cron clean --failed)`);
  },

  async tick(store) {
    // Runs are detached and unref'd, so hold the process open until they finish.
    const hold = setInterval(() => {}, 1000);
    let r;
    try { r = await tick(store, { wait: true }); } finally { clearInterval(hold); }
    console.log(`fired ${r.fired}, skipped ${r.skipped}, expired ${r.expired}, runs started: ${r.runs.join(', ') || 'none'}`);
  },

  daemon(store) {
    store.tx(() => {
      const other = daemonPid(store);
      if (other && other !== process.pid) throw new Error(`a daemon is already running (pid ${other})`);
      store.setMeta('daemon_pid', process.pid);
    });
    const every = Number(process.env.AGENT_CRON_TICK_MS) || 60_000;
    const say = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
    let busy = false;
    const loop = async () => {
      if (busy) return; // a slow check must not stack ticks
      busy = true;
      try {
        const r = await tick(store);
        store.setMeta('last_tick', Date.now());
        if (r.fired || r.skipped || r.expired || r.runs.length) {
          say(`fired ${r.fired}, skipped ${r.skipped}, expired ${r.expired}, runs started: ${r.runs.join(', ') || 'none'}`);
        }
      } catch (err) {
        say(`tick failed: ${err.message}`);
      } finally {
        busy = false;
      }
    };
    const stop = () => {
      if (Number(store.getMeta('daemon_pid')) === process.pid) store.setMeta('daemon_pid', null);
      process.exit(0); // agents already running keep going; the next daemon picks up their results
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    say(`agent-cron daemon started (pid ${process.pid}), checking every ${every / 1000}s, data in ${store.dir}`);
    loop();
    setInterval(loop, every);
    return new Promise(() => {}); // run until stopped
  },

  service(store, argv) {
    const { positionals: [action] } = parse(argv);
    if (process.platform !== 'darwin') {
      throw new Error('service install is macOS only. Elsewhere, keep `agent-cron daemon` alive with systemd or a supervisor');
    }
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    const domain = `gui/${process.getuid()}`;
    const launchctl = (...args) => execFileSync('launchctl', args, { stdio: 'pipe' });
    if (action === 'install') {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const env = { PATH: process.env.PATH, HOME: os.homedir() };
      if (process.env.AGENT_CRON_HOME) env.AGENT_CRON_HOME = process.env.AGENT_CRON_HOME;
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(process.execPath)}</string><string>${esc(BIN)}</string><string>daemon</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${Object.entries(env).map(([k, val]) => `    <key>${k}</key><string>${esc(val)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(store.dir, 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(store.dir, 'daemon.log'))}</string>
</dict></plist>
`);
      try { launchctl('bootout', `${domain}/${SERVICE_LABEL}`); } catch { /* was not loaded */ }
      launchctl('bootstrap', domain, plist);
      console.log(`Installed and started. It now starts at login.\nPlist: ${plist}\nLog:   ${path.join(store.dir, 'daemon.log')}`);
    } else if (action === 'uninstall') {
      try { launchctl('bootout', `${domain}/${SERVICE_LABEL}`); } catch { /* was not loaded */ }
      fs.rmSync(plist, { force: true });
      console.log('Service removed. Your timers and events are kept.');
    } else {
      throw new Error('usage: agent-cron service install|uninstall');
    }
  },

  skill(_store, argv) {
    const { values: v, positionals: [action] } = parse(argv, { dir: str });
    if (action !== 'install') throw new Error('usage: agent-cron skill install [--dir <skills dir>]');
    const dest = path.join(path.resolve(v.dir || path.join(os.homedir(), '.claude', 'skills')), 'agent-cron');
    const text = fs.readFileSync(path.join(ROOT, 'skill', 'agent-cron', 'SKILL.md'), 'utf8')
      .replaceAll('{{AGENT_CRON_BIN}}', `"${process.execPath}" "${BIN}"`);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), text);
    console.log(`Skill installed: ${path.join(dest, 'SKILL.md')}`);
  },
};

function setEventStatus(store, argv, from, to) {
  const { positionals: ids } = parse(argv);
  if (!ids.length) throw new Error(`usage: agent-cron ${to === 'paused' ? 'pause' : 'resume'}-event <id> [<id>...]`);
  for (const id of ids) {
    // The status test is in the UPDATE itself, so an event the daemon just picked up is not touched.
    const { changes } = store.run('UPDATE events SET status = ?, updated_at = ? WHERE id = ? AND status = ?', to, Date.now(), Number(id), from);
    if (changes) {
      console.log(to === 'paused' ? `Event ${id} paused. It stays in the inbox until: agent-cron resume-event ${id}` : `Event ${id} is waiting again. It will be picked up within a minute.`);
      continue;
    }
    const e = store.get('SELECT status FROM events WHERE id = ?', Number(id));
    console.log(!e ? `Event ${id}: not found.` : `Event ${id} is ${e.status}, so it cannot be ${to === 'paused' ? 'paused' : 'resumed'}. Only ${from} events can.`);
  }
}

function removeRunFiles(store, runIds) {
  for (const id of runIds) {
    for (const ext of ['log', 'prompt.md', 'exit']) fs.rmSync(path.join(store.dir, 'runs', `${id}.${ext}`), { force: true });
  }
}

function setTimerStatus(store, argv, status, from) {
  const { positionals: [id] } = parse(argv);
  const timer = store.get('SELECT * FROM timers WHERE id = ?', Number(id));
  if (!timer) throw new Error(`no timer ${id}`);
  if (!from.includes(timer.status)) throw new Error(`timer ${id} is ${timer.status}`);
  let due = timer.next_due_at;
  // A resumed schedule waits for its next slot instead of firing for the time it was paused.
  if (status === 'active' && timer.kind !== 'once' && due <= Date.now()) {
    due = timer.kind === 'cron' ? nextCron(timer.spec) : Date.now() + Number(timer.spec);
  }
  store.run('UPDATE timers SET status = ?, next_due_at = ? WHERE id = ?', status, due, timer.id);
  console.log(`Timer ${timer.id} is now ${status}.`);
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || ['help', '--help', '-h'].includes(name)) return void process.stdout.write(HELP);
  const command = commands[name];
  if (!command) throw new Error(`unknown command "${name}". Try: agent-cron help`);
  const store = openStore();
  try {
    await command(store, rest);
  } finally {
    store.close();
  }
}
