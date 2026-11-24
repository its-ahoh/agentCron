# agent-cron design

Reference article: <https://claude.com/resources/articles/building-always-on-agents>

In one sentence: agents sleep most of the time. A small service looks once a minute. It wakes an agent only when there is work, and skips otherwise, so idle time costs no tokens.

For how to use it, see [README.md](README.md). This document covers why it is built this way, how far it has got, and what is missing.

## 1. Parts

```
person / skill ──add──▶ [timers]               when to look
agent ──followup──▶        │   (narrow: one-off, self only, capped)
                           │
        ┌──────────────────▼──────────────────┐
        │ daemon: one tick every minute        │
        │  0. settle earlier runs              │
        │     (crashed / timed out / ended)    │
        │  1. find due timers                  │
        │  2. run the check command (optional) │
        │       exit 0 → add an event          │
        │       else   → skip, and log it      │
        │  3. inbox has events → pack them,    │
        │     wake the agent                   │
        └──────────────────┬──────────────────┘
push / webhook ────▶ [events inbox] ──▶ agent command (claude -p / codex exec -)
                           ▲                    │
                           │                    ├─ event done / fail    report each event
                           └── failures return ─┤─ action begin / done  ledger
                                                └─ followup             come back later
```

| Table | What it holds | Name in the article |
|---|---|---|
| `agents` | Which agents exist, the command that wakes each, its working folder | — |
| `timers` | When to look, the gate, what to do when woken | Timers |
| `events` | Work that is ready now. Has a status; duplicates are dropped | Event inbox |
| `runs` | One row per wake-up. The row in `running` is the lock | Worker |
| `attempts` | The result and reason of every try of every event | — |
| `actions` | The ledger: actions that must not be repeated | — |
| `activity` | Activity log | — |

The daemon is what the article calls the Scheduler.

The article's hard rules are all kept:

- A timer **never** starts an agent. It only adds an event to the inbox.
- Every source (timers, manual pushes, later webhooks) goes through the same inbox.
- Each agent has at most one run at a time.
- Events are deduplicated on `(agent, source, source_id)`. A timer's event id is `timer id:due time`.
- If a run crashes, its events go back to `pending`, and a restarted service carries on.
- Several waiting events are packed into one wake-up.

## 2. Fire or skip

Every minute, in this order:

1. Agent not connected → do nothing.
2. Timer not due, or paused → skip.
3. Past `--expires` → mark `expired`.
4. Has `--check`: exit 0 → fire, and hand the output to the agent. Non-zero, or longer than 30 seconds → skip (a one-off is checked again next minute; a repeating timer waits for its next slot).
5. No `--check` → fire when due.
6. Agent already running → the event stays in the inbox until the next minute.
7. Event paused → it stays in the inbox and wakes nobody.

Every fire and every skip is written to the activity log.

## 3. Three hard problems, and where they stand

### 3.1 State consistency (done, with limits)

The problem: an agent changes something in the outside world, then crashes before recording it. A retry does it twice.

At the service level this is "at least once", not "exactly once". Four things narrow the gap:

| Tool | What it covers |
|---|---|
| `--no-retry` / `--max-attempts N` | Risky work runs at most once; on failure it is given up and left for a person |
| Ledger `action begin / done` | A retry can tell "done", "never started" and "started, outcome unknown" apart |
| Per-event reporting `event done / fail` | One failure does not drag down its batch; an event reported before a crash is not handed out again |
| Retry warning | The retry prompt says "this is a retry" and lists the actions recorded last time |

Limits: the ledger and the reports only work when the agent uses them. For "started, outcome unknown", the agent has to check the real system; the service cannot decide for it.

### 3.2 Long-term memory (not built, by decision)

agent-cron only handles "when to wake". It does not handle memory.

Decision: do not build memory into agent-cron, and do not tie it to one memory tool, because it is shared by several kinds of agents.
A woken `claude -p` can already read Co-memo notes, and conflicts and versions are handled by Co-memo itself.
The skill adds one rule only: read freely, but write sparingly when nobody is watching.

Current state: reading works. Writing is blocked by permissions and has not been opened up.

### 3.3 Degree of autonomy (boundaries built, evaluation not)

Built:

- By default an agent can look but not touch. What to allow is written by a person into the connect command.
- An agent can schedule itself only through `followup`: one-off, self only, no check, capped in number. The limits live in the service and do not rely on the agent behaving.
- Repeating and gated timers are added by people only, because a check command is run by the service with the person's full permissions.
- The result and reason of every try are kept, so a person can look back.

Not built:

- A test set and scoring for "do it / ask first / notify / stay quiet" (an eval). The raw material exists: the prompt and output of every run in `runs/`.
- An "agent proposes, person approves" flow (`propose` / `approve`). Designed, set aside for now.

## 4. Technical choices

- Node ≥ 22.13 with the built-in `node:sqlite`. No dependencies.
- All data in one SQLite file. Writes use `BEGIN IMMEDIATE`, so the command line and the service can work at the same time.
- Agents are woken by a shell command with the prompt on stdin. So Claude Code, Codex and others can all plug in.
- The agent process is independent of the service (its own process group). A service restart does not affect it. On exit it writes its result to a small file, and the service records it on return.
- macOS uses launchd to keep the service alive.

## 5. Safety

- A check command is limited to 30 seconds and should be read-only. Only people can add one.
- A run is limited to 30 minutes by default. On timeout the whole process group is killed.
- `--expires` and `--max-fires` stop endless polling.
- The `followup` caps stop an agent from waking itself in an endless relay.
- Permissions come from the connect command and are closed by default. `agent-cron add` is not allowed to agents.

## 6. Known limits

- No priorities. First in, first out.
- One beat a minute: a timer can be up to a minute late, and one queue handles at most one batch a minute.
- The global default number of tries (3) cannot be changed for the background service, because it does not see terminal environment variables. Each task can set its own with `--max-attempts`.
- Only macOS has `service install`. On other systems you keep `agent-cron daemon` alive yourself.

## 7. Not built yet (from the article)

- Resuming an earlier session (the user replied, so continue that conversation)
- Outbox (queueing outgoing messages, keeping the noise down)
- Deferred tool calls, which is the "propose and approve" flow above
- An HTTP endpoint for webhooks (for now use `agent-cron push --source <source> --id <id>`)
- Memory file conventions, dreaming
- An autonomy eval

## 8. Status (2026-11-23)

- Code is in this folder: `src/{store,schedule,engine,cli}.js`, `bin/`, `skill/`, `test/`. All 26 tests pass.
- Installed on the author's Mac: the `agent-cron` command, the launchd service `com.agent-cron.daemon`, the skill at `~/.claude/skills/agent-cron`, data in `~/.agent-cron`.
- One agent is connected: `claude`, working in `~/.agent-cron/work`, allowed only reporting, the ledger and followup.
- Tried with real `claude -p`: wake-ups, the gate, batching, dedupe, retry on failure, `--no-retry`, pause and resume, per-event reporting, followup, reading back failure reasons.
- Not tried on the real machine: a run killed halfway (tested with a fake agent only); behaviour after allowing file edits and other permissions.
