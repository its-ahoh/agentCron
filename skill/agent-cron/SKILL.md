---
name: agent-cron
description: Schedule a future wake-up for yourself or another agent through the shared always-on agent-cron service. Use when the user says "remind me", "check back later", "follow up in 2 hours", "every morning", "keep an eye on X", "when CI finishes / when the file shows up, do Y", or when you need to resume your own task later. Also use to list, pause or cancel scheduled checks.
---

# agent-cron

A background service looks once a minute. It keeps **timers** (when to look) and an **inbox** (work that
is ready now). When a timer is due, its optional **check** command runs: exit 0 wakes the agent, anything
else skips quietly and costs no tokens. A woken agent gets a prompt listing the waiting events.

Command: `{{AGENT_CRON_BIN}}` (written as `agent-cron` below).

## Add an event

```sh
agent-cron add --name "<short title>" --prompt "<what to do when woken>" [when] [gate]
```

When — pick one. With none, it is looked at within a minute.

- `--in 30m`, `--in 2h` — one follow-up
- `--at 09:00` (next time the clock shows it) or `--at 2026-11-24T09:00`
- `--every 15m` — repeating, at least `1m`
- `--cron "0 9 * * 1-5"` — repeating, 5 fields, local time

Gate — optional, and the right choice for "watch for X":

- `--check "<shell command>"` — exit 0 wakes the agent; non-zero skips. What it prints is handed to the agent.
- On a one-off timer the check repeats **every minute until it passes**, then fires once.
- `--expires 6h` stops a watch from polling forever. `--max-fires N` caps a repeating timer.

Risky work — anything that must not happen twice (merge, send, pay, post, delete):

- `--max-attempts N` — how many times to try in total if the run fails or crashes (default 3, max 20).
- `--no-retry` — same as `--max-attempts 1`: the event is **not** tried again. Without it, a failed
  run is retried up to 3 times, and a retry can repeat what the first try already did.

`--agent <name>` picks who gets woken. Inside a woken run you are already the default.

## Examples

```sh
# come back to a task later
agent-cron add --in 2h --name "PR 42 review" \
  --prompt "Read the review comments on PR 42 in ~/code/app and address them."

# wake only when CI is finished; give up after 3 hours
agent-cron add --name "CI for PR 42" --expires 3h \
  --check '! gh pr checks 42 --repo me/app | grep -q pending' \
  --prompt "CI for PR 42 in ~/code/app finished. If a check failed, read its log and fix it."

# repeating job that stays asleep when there is nothing new
agent-cron add --every 30m --name "inbox triage" \
  --check 'test -n "$(ls ~/inbox/*.eml 2>/dev/null)"' \
  --prompt "Triage the .eml files in ~/inbox, then move each one to ~/inbox/done."

# weekday morning brief
agent-cron add --cron "0 9 * * 1-5" --name "morning brief" \
  --prompt "Summarize yesterday's commits in ~/code/app in five bullets."
```

## When you are the woken agent: come back later

Inside a woken run, schedule your own return with `followup`, not `add`:

```sh
agent-cron followup --in 2h --name "PR 42 re-check" \
  --prompt "Re-check CI on PR 42 in ~/code/app. If it is green, tell the user it is ready to merge."
```

It is one-off, always for yourself, and takes only `--in` or `--at`, `--prompt` and `--name`. There are
limits: at least 1 minute ahead, at most 5 waiting, at most 20 in 24 hours. If it says a limit is reached,
do not try again or work around it; say so in your reply. Anything a follow-up cannot do (a check command,
a repeating schedule, another agent) is for the user to set up with `add`.

## When you are the woken agent: report each event

A wake-up can carry several events. Say how each one went, as you finish it:

```sh
agent-cron event done 12                         # handled, or nothing needed doing
agent-cron event fail 13 --note "API returned 503"   # could not do it; retried later if tries remain
```

Always give `--note` on a failure, and make it specific (what you tried, what came back). It is stored
with the event and is what the user reads later to find out what went wrong.

Report one event before starting the next. An event you do not report gets the result of the whole run,
so one crash or one failure would otherwise send every event in the batch back for another try.

## When you are the woken agent: do not do things twice

A run can die after it changed something but before it reported back. The event is then handed to a new
run that remembers nothing. So wrap every outside action that must happen once:

```sh
if agent-cron action begin merge-pr-42; then      # exit 0: nobody did this yet
  gh pr merge 42 --repo me/app --squash
  agent-cron action done merge-pr-42 --note "merged"
fi
```

`action begin` exit codes:

- `0` — go ahead, then run `action done <key>` right after it succeeds.
- `10` — already done by an earlier run. Skip it.
- `11` — an earlier run started it and never finished. **Do not guess.** Look at the real system
  (is the PR merged? was the mail sent?). If it happened: `action done <key>`. If not: `action begin <key> --force`.

Pick keys that name the exact action, like `merge-pr-42` or `send-invoice-2026-11`. If the wake prompt says
"this is a retry", read the recorded actions it lists before doing anything.

## Memory when woken

If you have a shared memory tool (for example Co-memo), read from it freely. Nobody reviews an unattended
run, so write to it sparingly: only facts you verified in this run that a later run will need.

## Manage

```sh
agent-cron list                      # timers: next check, fired, skipped
agent-cron show <id>                 # one timer in full: when, gate, retry rule, prompt, history
agent-cron pause <id>                # also: resume <id>, rm <id>
agent-cron events                    # the inbox; rm-event <id> deletes one
agent-cron events --failed           # what was given up on, with the last reason
agent-cron show-event <id>           # every try of one event, how it ended and why
agent-cron pause-event <id>          # hold a waiting event; resume-event <id> lets it go
agent-cron clean --older 7d          # delete finished events, timers, runs and history
agent-cron runs                      # past wake-ups; show-run <id> prints prompt and output
agent-cron log                       # why things fired or were skipped
agent-cron push --prompt "..."       # put work in the inbox right now
agent-cron status                    # is the service alive
```

## Rules

- Write `--prompt` for a fresh session with no memory of this chat: give paths, ids and the goal.
- Prefer a `--check` gate over waking an agent just to find out nothing changed.
- Keep checks fast (under 30 seconds) and read-only. They run unattended every minute.
- Give watches an `--expires`.
- After adding, tell the user the timer id and the next check time that `add` printed.
- If `add` warns that the daemon is not running, or says no agent is connected, tell the user. Do not start
  the daemon or install the service yourself unless they ask.
