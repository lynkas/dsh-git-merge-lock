# dsh-git-merge-lock 项目介绍 · Introduction

> 中英双语项目介绍：使用场景、解决的问题、工作原理。
> Bilingual project introduction: use cases, the problem it solves, and how it works.

---

## 第一部分 · 中文

### 1. 这是什么

`dsh-git-merge-lock` 是 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）的一个 host 平面插件，为**多 agent session 共用同一个 git 仓库**提供跨 session 的**合并互斥**：

- **整仓单线程**：同一仓库的 `merge` / `pull` / `rebase` / `cherry-pick` / `revert` / `am` 完全串行，任意时刻最多一个 session 在做历史变更操作；
- **模型侧工具** `git_merge_lock`：`acquire`（FIFO 排队）/ `release` / `force_release`（需人工确认）/ `status` / `notify`（给持锁者留言）；
- **浏览器 UI**：侧栏项目行的锁状态灯（灰色空闲 / 金色有人持锁）+ 弹窗（持锁详情、等待队列、审计账本、手动解锁）。

插件只仲裁"**何时允许开始**"，不触碰工作区——合并动作仍由各 session 自己执行。

### 2. 解决什么问题

**场景**：多个 AI agent session（比如你开了三四个 dsh 会话）并行开发同一个仓库。git 的历史变更操作不是原子读改写：`merge` 中途会留下 `MERGE_HEAD` 等半途现场，`rebase` 会反复改写 index 和工作区。

**没有互斥时会发生什么**：

- session A 的 rebase 进行到一半，session B 抢着 `git pull` → B 读到混乱的中间态，冲突解决被污染，甚至把 A 正在做的工作直接覆盖；
- 两个 session 同时撞进冲突解决，各自 `git add` 竞争同一个 index，后提交的一方"吞掉"前一方的修复；
- agent 事后发现工作区状态诡异，靠猜来自救，把半途现场"清理"成错误的历史。

**为什么常见方案不够用**：

| 方案 | 缺陷 |
|---|---|
| 自觉约定（prompt 里写"合并前看看别人"） | 无强制力，agent 高负载下必然忘记 |
| git hooks | git 没有 `pre-merge` 钩子，覆盖不了 merge/pull/rebase 全家 |
| 文件锁 + 心跳 TTL（`flock`/锁文件类） | 三个经典缺口：① 进程死了要等 TTL 过期才能抢锁；② TTL 到期偷锁后，原持有者苏醒继续写 → **fencing 缺口**（Kleppmann 问题）；③ 先到先得的文件锁无 FIFO 公平性，可能饥饿 |

本插件的核心主张：**互斥权威放在一个长驻进程的内存里**，资格从不下放给文件——失联即失效，从根上消掉陈旧锁和 fencing 缺口。

### 3. 使用场景

**典型用法（每次合并类操作前后）：**

```text
1. git_merge_lock(action="acquire", why="merging feature/x into main")
   → 拿到锁：立刻做 git 操作；队列忙：返回 busy，附持有者信息
2. 做你的 git merge / pull / rebase …
3. git_merge_lock(action="release")   ← 做完立刻还锁，不跨步骤持有
```

- **多 session 并行开发同一仓库**（主场景）：谁先 acquire 谁先合并，其余排队，等待者名单公开；
- **长 rebase/merge 期间**：其他 session 的 pull 自动排队而不是插进去；
- **持锁 session 卡死**：别人可以 `notify` 留言催促；人工决策时由人 `force_release`（两段确认），锁立即移交队头，不打断对方 session；
- **事后追溯**：所有 acquired / waiting / released / auto_released / force_released 事件落在审计账本里，出了问题可以回放"排队期间发生了什么"。

**明确的边界（保护范围之外）**：

- 互斥权威在**单个 web host 进程内存**里——第二个 dsh 实例、裸命令行 git、跨机器的进程不受保护（它们本来也不调用这个工具）；
- 分支级细粒度不做：同一仓库内所有集成分支操作统一串行，换取语义简单可靠。

### 4. 工作原理

**架构一句话**：web host 进程内的 per-repo FIFO 队列是唯一权威；`journal.jsonl` 只是审计账本，不是锁。

```
session A ──acquire──▶┌─────────────────────────────┐
session B ──acquire──▶│ web host 进程内存            │
session C ──acquire──▶│ per-repo FIFO 队列 + keeper │──▶ 队头获得资格
                      └─────────────────────────────┘
                                │ 只追加（append-only）
                                ▼
              <git-common-dir>/dsh-git-lock/journal.jsonl   ← 审计账本
```

- **租约绑定调用生命周期**：锁的资格与发起调用的 agent 会话同生共死——
  - 排队时被打断 → 立即出队作废，不占位；
  - 持有时会话中断/失联 → keeper 每 5 秒巡检，发现即自动释放并记 `auto_released`，队头无缝接管；
  - 兜底 60 分钟硬上限，防止任何形式的永久占用；
  - 结果是：**不存在陈旧锁判定、不存在偷锁、不存在 fencing 缺口**——失联即失效，资格从不下放。
- **严格 FIFO 公平**：先到先排队，无饥饿；超时返回 busy 时点名当前持有者并给出可选项。
- **单出口并发正确性**：授予/超时/打断三路收敛到同一个 `settle()` 出口，计时器与 abort 监听器恰好清理一次；队头移交用 `current === entry` 判定消除竞态；所有计时器 `unref()`，不阻宿主退出。
- **git 现场探测**：acquire 时只读检查 `MERGE_HEAD` / `REBASE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD`，发现上一任留下的未完成集成现场就警告下一任持有者；release 前同样自检并留痕。
- **信箱机制**：`notify` 的留言存在内存信箱里，持锁者下一次调用任何 action 时随结果送达。
- **配置热读**：全局 `~/.dsh/git-merge-lock.json` + 项目级 `<repo>/dsh-merge-lock.json` 双层覆盖，每次调用实时重读，改完即生效。
- **为什么不用文件锁**（v1 → v2 的教训）：文件锁的一切问题都源于"权威在文件里"——TTL 估不准、死进程判不准、偷锁后无法撤权。把权威挪进长驻进程内存后，这三个问题连同它们的补丁一起消失了。

**质量保障**：内核语义套件 21 断言（FIFO 公平、等待中打断、持有中自愈 <8s、幂等/越权、超时 busy、信箱、force_release 门禁、双仓隔离）+ 端点套件 14 断言（真实 git 临时仓四态）。内核约 432 行，零 npm 依赖、仅 node 内建。

---

## Part 2 · English

### 1. What is this

`dsh-git-merge-lock` is a host-plane plugin for [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) that provides **cross-session merge mutual exclusion** for **multiple agent sessions sharing one git repository**:

- **Repo-wide single-threading**: `merge` / `pull` / `rebase` / `cherry-pick` / `revert` / `am` on the same repository are fully serialized — at most one session performs a history-mutating operation at any moment;
- **A model-facing tool** `git_merge_lock`: `acquire` (FIFO queueing) / `release` / `force_release` (human-confirmed) / `status` / `notify` (leave a note for the holder);
- **Browser UI**: a lock indicator on each sidebar project row (grey = idle, gold = held) plus a dialog (holder details, wait queue, audit journal, manual unlock).

The plugin only arbitrates **when an operation may start** — it never touches the working tree; each session still runs its own git commands.

### 2. The problem it solves

**The setup**: several AI agent sessions (say, three or four dsh conversations) develop in one repository in parallel. Git's history-mutating operations are not atomic read-modify-write: a `merge` midway leaves half-done state such as `MERGE_HEAD`, and a `rebase` repeatedly rewrites the index and working tree.

**What happens without exclusion**:

- Session A is halfway through a rebase when session B rushes a `git pull` → B reads a confusing intermediate state, conflict resolution gets polluted, and A's in-flight work can be silently overwritten;
- Two sessions stumble into conflict resolution simultaneously, racing `git add` on the same index — the later committer "swallows" the earlier one's fixes;
- The agent later finds the working tree in a weird state and improvises a "cleanup", turning a half-done merge into wrong history.

**Why the obvious fixes fall short**:

| Approach | Flaw |
|---|---|
| Gentleman's agreement ("check before merging" in the prompt) | No enforcement; agents forget under load |
| Git hooks | Git has no `pre-merge` hook — can't cover the merge/pull/rebase family |
| File locks with heartbeat TTL (`flock`/lockfile style) | Three classic gaps: ① a dead process's lock lingers until TTL expiry; ② after TTL-based theft, the original holder wakes up and keeps writing → the **fencing gap** (the Kleppmann problem); ③ file locks are first-come-first-served with no FIFO fairness — starvation is possible |

The core idea here: **put the mutex authority in the memory of one long-lived process**. The right to proceed is never delegated to a file — losing contact means losing the lease, which eliminates stale locks and the fencing gap at the root.

### 3. Use cases

**Typical flow (around every merge-type operation):**

```text
1. git_merge_lock(action="acquire", why="merging feature/x into main")
   → got the lock: run your git commands right away; busy: returns holder details
2. Do your git merge / pull / rebase …
3. git_merge_lock(action="release")   ← release immediately; never hold across steps
```

- **Multiple sessions developing one repo** (the primary case): first acquire merges first; everyone else queues, with the waiter list public;
- **During a long rebase/merge**: other sessions' pulls queue up instead of barging in;
- **A stuck holder**: others can `notify` it; a human can decide to `force_release` (two-step confirmation) — the lease transfers to the queue head immediately without interrupting the holder's session;
- **Post-mortems**: every acquired / waiting / released / auto_released / force_released event lands in the audit journal, so you can replay "what happened while I was queued".

**Explicit boundaries (outside the protection scope)**:

- The authority lives in **one web host process** — a second dsh instance, bare CLI git, or processes on other machines are not protected (they don't call this tool anyway);
- No branch-level granularity: integration operations within a repository are uniformly serialized, in exchange for simple, reliable semantics.

### 4. How it works

**The architecture in one sentence**: a per-repo FIFO queue in the web host process's memory is the sole authority; `journal.jsonl` is an audit ledger, not a lock.

```
session A ──acquire──▶┌──────────────────────────────────┐
session B ──acquire──▶│ web host process memory          │
session C ──acquire──▶│ per-repo FIFO queue + keeper     │──▶ head of queue proceeds
                      └──────────────────────────────────┘
                                │ append-only
                                ▼
              <git-common-dir>/dsh-git-lock/journal.jsonl   ← audit ledger
```

- **Leases bound to the call's lifecycle**: the right to proceed lives and dies with the agent session that requested it —
  - Interrupted while waiting → dequeued and voided immediately, no phantom slot;
  - Interrupted/disconnected while holding → the keeper scans every 5 s, auto-releases on detection (journal: `auto_released`), and the queue head takes over seamlessly;
  - A 60-minute hard cap backstops against any form of permanent occupation;
  - The consequence: **no stale-lock detection, no lock theft, no fencing gap** — losing contact invalidates the lease, and the right to proceed is never delegated.
- **Strict FIFO fairness**: first-come-first-served, no starvation; a timed-out `acquire` returns busy, naming the current holder and offering options.
- **Single-exit concurrency correctness**: the three paths (grant / timeout / abort) converge on one `settle()` exit, so timers and abort listeners are cleaned up exactly once; the handoff race is eliminated by checking `current === entry`; every timer is `unref()`ed so the host can exit freely.
- **Git state probing**: on `acquire`, a read-only check for `MERGE_HEAD` / `REBASE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` warns the next holder about an unfinished integration left behind; the same self-check runs before `release` and is journalled.
- **Mailbox**: notes sent via `notify` are held in memory and delivered with the holder's next tool call.
- **Live config**: global `~/.dsh/git-merge-lock.json` overridden per-repo by `<repo>/dsh-merge-lock.json`, re-read on every call — changes take effect without restart.
- **Why not file locks** (the v1 → v2 lesson): every file-lock pathology stems from "the authority lives in a file" — TTLs are guesses, dead processes are hard to pronounce, and stolen locks can't be revoked. Moving the authority into one long-lived process's memory makes those problems — and their patches — disappear.

**Quality assurance**: a kernel semantics suite with 21 assertions (FIFO fairness, abort-while-waiting, self-healing <8 s while holding, idempotency/unauthorized release, timeout busy, mailbox, force_release gating, two-repo isolation) plus an endpoint suite with 14 assertions (four states against a real scratch git repo). The kernel is ~432 lines with zero npm dependencies — node built-ins only.
