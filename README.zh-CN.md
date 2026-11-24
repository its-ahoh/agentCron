# agentCron

[English](README.md) | **中文**

给多个 AI agent 共用的 always-on 小服务。装好后的命令叫 `agent-cron`。
设计参考 [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents)。设计和取舍见 [PLAN.md](PLAN.md)（英文）。

agent 平时睡觉。服务每分钟看一眼。有事才叫醒，没事跳过，不花 token。

- 零依赖。只要 Node ≥ 22.13（用自带的 `node:sqlite`）。
- 数据全在一个文件：`~/.agent-cron/agent-cron.db`。每次叫醒的 prompt 和输出在 `~/.agent-cron/runs/`。

## 三样东西

| 东西 | 是什么 | 命令里叫 |
|---|---|---|
| 闹钟 | 「什么时候去看一眼」 | timer |
| 信 | 「现在就该做的事」，放在信箱（队列）里 | event |
| 叫醒 | 把信打包成 prompt，跑一次 agent | run |

闹钟不直接叫 agent。闹钟到点（而且门槛通过）只往信箱放一封信。agent 只从信箱拿活。

## 装

```sh
git clone https://github.com/its-ahoh/agentCron.git
cd agentCron
npm link                       # 之后有 agent-cron 命令。不想 link 就用 ./bin/agent-cron.js
agent-cron connect claude      # 连上一个 agent
agent-cron service install     # macOS：开机自启，挂了自己重启
agent-cron skill install       # skill 装到 ~/.claude/skills/agent-cron
```

- 别的 agent：`agent-cron connect codex`，或 `agent-cron connect 名字 --command "<从 stdin 读 prompt 的命令>"`。
- 给 agent 指定干活的文件夹和时限：`--cwd <目录>`、`--timeout 30m`。
- 别的 agent 的 skill 目录：`agent-cron skill install --dir <目录>`。
- 改了 `skill/agent-cron/SKILL.md` 要重新 `agent-cron skill install`。
- 改了 `src/` 要重启服务：`launchctl kickstart -k gui/$(id -u)/com.agent-cron.daemon`。

## 加闹钟

```sh
agent-cron add --in 2h --name "PR 跟进" --prompt "去看 PR 42 的评论并处理"
agent-cron add --every 30m --check 'test -n "$(ls ~/inbox)"' --prompt "整理 ~/inbox"
agent-cron add --cron "0 9 * * 1-5" --prompt "总结昨天的 commit"
agent-cron add --expires 3h --check '! gh pr checks 42 | grep -q pending' --prompt "CI 跑完了，去看结果"
```

| 选项 | 意思 |
|---|---|
| `--in 30m` / `--at 09:00` | 一次性。不写时间 = 一分钟内 |
| `--every 15m` / `--cron "0 9 * * 1-5"` | 循环。cron 是 5 段，本地时间 |
| `--check "<命令>"` | 门槛。exit 0 才叫醒 agent，命令的输出一起给它。不通过就跳过，不花 token |
| `--expires 6h` | 过期就不再查 |
| `--max-fires N` | 循环的最多响几次 |
| `--max-attempts N` | 失败后总共试几次。默认 3，最多 20 |
| `--no-retry` | 等于 `--max-attempts 1`。危险的事用这个 |
| `--agent <名字>` | 给谁。只连了一个 agent 时可以不写 |
| `--name "标题"` | 好认的名字 |

一次性的闹钟带 `--check` 时，会每分钟查一次，直到通过为止。记得加 `--expires`。

不经过闹钟，直接放一封信：`agent-cron push --prompt "..."`。带 `--source <来源> --id <编号>` 时，同一个编号只收一次。

## 每分钟做什么

1. 收尾：上次的 run 结束了没？超时就杀掉。
2. 找到期的闹钟。过期的标 `expired`。
3. 有 `--check` 就跑。不通过就跳过。
4. 通过的写一封信进信箱。
5. 信箱有信、这个 agent 没在跑 → 把等着的信打包（最多 20 封），叫醒一次。

队列的规矩：先来先做；每个 agent 一条队，同时只跑一个；不同 agent 互不挡路；没有优先级。
agent 跑完后，下一批要等下一分钟那次检查。

## 状态

| | 状态 |
|---|---|
| 闹钟 | `active` 排着 · `paused` 暂停 · `done` 跑完 · `expired` 过期 · `cancelled` 取消 |
| 信 | `pending` 等着 · `paused` 扣住 · `running` 在做 · `done` 做完 · `failed` 放弃 |
| 叫醒 | `running` · `done` · `failed` 报错退出 · `lost` 崩了 · `timeout` 超时 |

暂停有两种：`agent-cron pause <闹钟id>`（不再往信箱放信）和 `agent-cron pause-event <信id>`（信留在信箱，但不叫醒 agent）。
恢复是 `resume` 和 `resume-event`。

## 被叫醒的 agent 该做的三件事

这三样是给 agent 用的。skill 和叫醒的 prompt 里都教了。

**1. 逐封报告结果**

```sh
agent-cron event done 12
agent-cron event fail 13 --note "API 返回 503"
```

报过的信有自己的结果。没报的才跟着整次 run 的结果走。这样一封失败不会拖累同一批的别的信。
agent 只能报自己这一趟的信。

**2. 用账本，别把一件事做两次**

agent 可能做完事（比如 merge 了）还没报告就崩了。重试时它什么都不记得。

```sh
if agent-cron action begin merge-pr-42; then   # exit 0 = 没人做过，去做
  gh pr merge 42 --squash
  agent-cron action done merge-pr-42
fi
```

重试时 `action begin` 会返回：`10` = 已经做完，跳过；`11` = 上次开始了但没说做完，先去真实系统里查。
重试的 prompt 会写明「这是重试」，并列出上次登记过的动作。

账本只在 agent 真的用它时才有用。拿不准就给任务加 `--no-retry`。

**3. 过会儿再来**

```sh
agent-cron followup --in 2h --name "回头看 PR" --prompt "再看一次 PR 42 的 CI"
```

`followup` 是 agent 给自己排任务的唯一入口，天生很窄：

- 只能一次性（`--in` 或 `--at`）。没有 `--every`、`--cron`。
- 没有 `--check`，所以跑不了别的命令。
- 只能加给自己，只能在被叫醒的那一趟里用。
- 最少 1 分钟后，最多 30 天内。同时最多 5 个在等。24 小时内最多加 20 个。

上限用环境变量改：`AGENT_CRON_FOLLOWUP_MAX_PENDING`、`AGENT_CRON_FOLLOWUP_MAX_PER_DAY`。

## 权限

agent 是没人看着跑的。没人点「批准」，所以需要批准的操作一律被拒。

`claude -p` 默认：能读工作文件夹里的文件、能搜索、能跑 `ls` / `cat` / `grep` 这类只读命令。
不能改文件，不能跑有后果的命令，不能用需要批准的工具。
（见 Claude Code 文档的 [permissions](https://code.claude.com/docs/en/permissions) 和 [headless](https://code.claude.com/docs/en/headless)。）

要多放什么，写进 connect 的命令里。建议至少放上面那三样：

```sh
agent-cron connect claude --command "claude -p --allowedTools 'Bash(agent-cron event:*)' 'Bash(agent-cron action:*)' 'Bash(agent-cron followup:*)'"
```

规矩：

- **不要放行整个 `agent-cron`，也不要放行 `agent-cron add`。** `--check` 的命令是后台服务用你的完整权限跑的。放行它就等于 agent 能跑任何命令。
- 一个活一个 agent。用 `--cwd` 把它关在一个文件夹里。命令一条条放行，写到最窄。
- 放行了 merge、push、发消息这类之后，给这些任务加 `--no-retry`。
- 不要用「跳过所有权限检查」的开关。
- 循环的、带门槛的闹钟，只由人来加。

## 查看

| 命令 | 看什么 |
|---|---|
| `agent-cron status` | 服务活着吗，有多少在等、暂停、失败 |
| `agent-cron agents` | 有哪些 agent，各用什么命令 |
| `agent-cron list [--all]` | 闹钟 |
| `agent-cron show <id>` | 一个闹钟的全部细节：时间、门槛、重试规则、prompt、谁加的、历史 |
| `agent-cron events [--all]` | 信箱 |
| `agent-cron events --failed` | 放弃了的信，带最后的原因 |
| `agent-cron show-event <id>` | 一封信的全部经过：每一次尝试、结果、原因 |
| `agent-cron runs` | 每次叫醒 |
| `agent-cron show-run <id>` | 某次的 prompt 和 agent 的全部输出 |
| `agent-cron log [-n 30]` | 流水账：触发、跳过、运行 |
| `agent-cron action list` | 账本 |

**失败原因**：每封信的每一次尝试都会记下结果、原因、哪次 run、时间。
agent 没报就出事的，服务会自己写原因（崩了、超时、退出码）。

## 清理

| 命令 | 做什么 |
|---|---|
| `agent-cron rm <闹钟id>` | 取消一个闹钟 |
| `agent-cron rm-event <信id>` | 删一封信（正在做的删不了） |
| `agent-cron clean [--older 7d]` | 删掉已结束的东西。等着的、暂停的不动。**失败的信和它们的日志会留着** |
| `agent-cron clean --failed` | 连失败的也删 |
| `agent-cron rm-agent <名字>` | 删掉一个 agent 和它的全部东西 |
| `agent-cron disconnect <名字>` | 只是不再叫醒它，东西保留 |
| `agent-cron service uninstall` | 卸掉后台服务，数据保留 |

## 其他

- 不开服务也能试：`agent-cron daemon` 在前台跑；`agent-cron tick` 马上查一轮并等 agent 跑完。
- check 命令要快、只读。超过 30 秒算不通过。
- 一次 run 默认限 30 分钟。
- 环境变量：`AGENT_CRON_HOME`（数据目录）、`AGENT_CRON_TICK_MS`（默认 60000）、`AGENT_CRON_MAX_ATTEMPTS`（默认 3）、`AGENT_CRON_CHECK_TIMEOUT_MS`（默认 30000）。
  后台服务是 macOS 启动的，读不到你终端里设的变量。
- 被叫醒的 agent 会拿到 `AGENT_CRON_AGENT`、`AGENT_CRON_RUN_ID`、`AGENT_CRON_EVENT_IDS`。
- 闹钟最多会晚一分钟：服务一分钟查一次。
- 全部命令：`agent-cron help`。

## 测试

```sh
npm test
```
