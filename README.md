# agent-cron

**English** | [中文](README.zh-CN.md)

A small always-on service shared by several AI agents.
The design follows [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents). For the reasoning and trade-offs, see [PLAN.md](PLAN.md).

Agents sleep most of the time. The service looks once a minute. It wakes an agent only when there is work, and skips otherwise, so idle time costs no tokens.

- No dependencies. Needs only Node ≥ 22.13 (it uses the built-in `node:sqlite`).
- All data lives in one file: `~/.agent-cron/agent-cron.db`. The prompt and output of every wake-up are in `~/.agent-cron/runs/`.

## Three things

| Thing | What it is | Name in commands |
|---|---|---|
| Timer | "When should I look?" | timer |
| Event | "Work that is ready now", kept in an inbox (a queue) | event |
| Wake-up | Waiting events packed into one prompt, and one agent run | run |

A timer never starts an agent. When a timer is due, and its gate passes, it only adds an event to the inbox. Agents take work only from the inbox.

## Install

```sh
git clone https://github.com/its-ahoh/agent-cron.git
cd agent-cron
npm link                       # gives you the agent-cron command; or use ./bin/agent-cron.js
agent-cron connect claude      # register an agent
agent-cron service install     # macOS: start at login, restart if it dies
agent-cron skill install       # copies the skill to ~/.claude/skills/agent-cron
```

- Other agents: `agent-cron connect codex`, or `agent-cron connect <name> --command "<a command that reads a prompt on stdin>"`.
- Give an agent a working folder and a time limit: `--cwd <dir>`, `--timeout 30m`.
- Skill folder of another agent: `agent-cron skill install --dir <dir>`.
- After editing `skill/agent-cron/SKILL.md`, run `agent-cron skill install` again.
- After editing `src/`, restart the service: `launchctl kickstart -k gui/$(id -u)/com.agent-cron.daemon`.

## Add a timer

```sh
agent-cron add --in 2h --name "PR follow-up" --prompt "Read the comments on PR 42 and address them"
agent-cron add --every 30m --check 'test -n "$(ls ~/inbox)"' --prompt "Triage ~/inbox"
agent-cron add --cron "0 9 * * 1-5" --prompt "Summarize yesterday's commits"
agent-cron add --expires 3h --check '! gh pr checks 42 | grep -q pending' --prompt "CI finished, look at the result"
```

| Option | Meaning |
|---|---|
| `--in 30m` / `--at 09:00` | One-off. With no time given, it is looked at within a minute |
| `--every 15m` / `--cron "0 9 * * 1-5"` | Repeating. Cron has 5 fields, in local time |
| `--check "<command>"` | The gate. Exit 0 wakes the agent and hands it the command's output. Anything else skips, at no token cost |
| `--expires 6h` | Stop looking after this long |
| `--max-fires N` | Cap how many times a repeating timer fires |
| `--max-attempts N` | How many tries in total if the run fails. Default 3, maximum 20 |
| `--no-retry` | Same as `--max-attempts 1`. Use it for risky work |
| `--agent <name>` | Who to wake. Optional when only one agent is connected |
| `--name "title"` | A readable name |

A one-off timer with `--check` is checked every minute until the check passes. Give it an `--expires`.

To put an event in the inbox without a timer: `agent-cron push --prompt "..."`. With `--source <source> --id <id>`, the same id is accepted only once.

## What happens every minute

1. Settle earlier runs: did they end? Kill any that ran past their time limit.
2. Find due timers. Mark expired ones `expired`.
3. Run `--check` where there is one. If it fails, skip.
4. For each one that passes, add an event to the inbox.
5. If an agent has waiting events and is not already running, pack them (up to 20) and wake it once.

Queue rules: first in, first out. One queue per agent, one run at a time. Agents do not block each other. There are no priorities.
After a run ends, the next batch waits for the next minute's check.

## Statuses

| | Statuses |
|---|---|
| Timer | `active` scheduled · `paused` · `done` · `expired` · `cancelled` |
| Event | `pending` waiting · `paused` held · `running` · `done` · `failed` given up |
| Run | `running` · `done` · `failed` exited with an error · `lost` crashed · `timeout` |

There are two kinds of pause: `agent-cron pause <timer id>` (adds nothing to the inbox) and `agent-cron pause-event <event id>` (the event stays in the inbox, but no agent is woken for it).
Undo them with `resume` and `resume-event`.

## Three things a woken agent should do

These are for the agent. The skill and the wake prompt both teach them.

**1. Report each event**

```sh
agent-cron event done 12
agent-cron event fail 13 --note "API returned 503"
```

A reported event keeps its own result. An unreported one takes the result of the whole run. So one failure does not drag down the rest of its batch.
An agent can only report events of its own run.

**2. Use the ledger, so nothing happens twice**

An agent can finish an action (say, a merge) and crash before reporting. The retry remembers nothing.

```sh
if agent-cron action begin merge-pr-42; then   # exit 0 = nobody did this yet, go ahead
  gh pr merge 42 --squash
  agent-cron action done merge-pr-42
fi
```

On a retry, `action begin` returns `10` = already done, skip; `11` = started before but never finished, so check the real system first.
The retry prompt says "this is a retry" and lists the actions recorded last time.

The ledger only helps when the agent actually uses it. When in doubt, add `--no-retry` to the task.

**3. Come back later**

```sh
agent-cron followup --in 2h --name "PR re-check" --prompt "Check CI on PR 42 again"
```

`followup` is the only way an agent can schedule itself, and it is narrow by design:

- One-off only (`--in` or `--at`). No `--every`, no `--cron`.
- No `--check`, so it cannot run other commands.
- Only for itself, and only inside the run that woke it.
- At least 1 minute ahead, at most 30 days. At most 5 waiting at once. At most 20 added in 24 hours.

Change the limits with `AGENT_CRON_FOLLOWUP_MAX_PENDING` and `AGENT_CRON_FOLLOWUP_MAX_PER_DAY`.

## Permissions

Agents run unattended. Nobody can click "approve", so anything that needs approval is refused.

By default `claude -p` can read files in its working folder, search, and run read-only commands such as `ls`, `cat` and `grep`.
It cannot edit files, run commands with side effects, or use tools that need approval.
(See the Claude Code docs on [permissions](https://code.claude.com/docs/en/permissions) and [headless mode](https://code.claude.com/docs/en/headless).)

To allow more, put it in the connect command. Allowing at least the three above is recommended:

```sh
agent-cron connect claude --command "claude -p --allowedTools 'Bash(agent-cron event:*)' 'Bash(agent-cron action:*)' 'Bash(agent-cron followup:*)'"
```

Rules:

- **Do not allow all of `agent-cron`, and do not allow `agent-cron add`.** A `--check` command is run by the background service with your full permissions. Allowing it lets the agent run anything.
- One job, one agent. Use `--cwd` to keep it in one folder. Allow commands one by one, as narrowly as you can.
- Once you allow merge, push or sending messages, add `--no-retry` to those tasks.
- Do not use the switch that skips all permission checks.
- Repeating and gated timers are added by people only.

## Look at things

| Command | Shows |
|---|---|
| `agent-cron status` | Is the service alive; how many are waiting, paused, failed |
| `agent-cron agents` | The agents and the command each one uses |
| `agent-cron list [--all]` | Timers |
| `agent-cron show <id>` | One timer in full: when, gate, retry rule, prompt, who added it, history |
| `agent-cron events [--all]` | The inbox |
| `agent-cron events --failed` | Events that were given up on, with the last reason |
| `agent-cron show-event <id>` | One event in full: every try, how it ended and why |
| `agent-cron runs` | Every wake-up |
| `agent-cron show-run <id>` | The prompt and the agent's full output for one wake-up |
| `agent-cron log [-n 30]` | Activity log: fires, skips, runs |
| `agent-cron action list` | The ledger |

**Failure reasons**: every try of every event is recorded with its result, reason, run and time.
When an agent fails without reporting, the service writes the reason itself (crashed, timed out, exit code).

Tables line up correctly with Chinese, Japanese and Korean text.

## Clean up

| Command | Does |
|---|---|
| `agent-cron rm <timer id>` | Cancel a timer |
| `agent-cron rm-event <event id>` | Delete an event (not one that is running) |
| `agent-cron clean [--older 7d]` | Delete finished things. Waiting and paused work is untouched. **Failed events and their logs are kept** |
| `agent-cron clean --failed` | Delete failed ones too |
| `agent-cron rm-agent <name>` | Delete an agent and everything it owns |
| `agent-cron disconnect <name>` | Just stop waking it; its things are kept |
| `agent-cron service uninstall` | Remove the background service; data is kept |

## Other notes

- You can try it without the service: `agent-cron daemon` runs in the foreground; `agent-cron tick` does one check now and waits for the agents to finish.
- Check commands should be fast and read-only. Over 30 seconds counts as a fail.
- A run is limited to 30 minutes by default.
- Environment variables: `AGENT_CRON_HOME` (data folder), `AGENT_CRON_TICK_MS` (default 60000), `AGENT_CRON_MAX_ATTEMPTS` (default 3), `AGENT_CRON_CHECK_TIMEOUT_MS` (default 30000).
  The background service is started by macOS, so it does not see variables set in your terminal.
- A woken agent gets `AGENT_CRON_AGENT`, `AGENT_CRON_RUN_ID` and `AGENT_CRON_EVENT_IDS`.
- A timer can be up to one minute late, because the service checks once a minute.
- All commands: `agent-cron help`.

## Tests

```sh
npm test
```
