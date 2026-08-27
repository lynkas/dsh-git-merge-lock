# dsh-git-merge-lock

> Cross-session git merge mutex for the [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) web GUI — repo-wide single-threaded integration operations with a model-facing lock tool and a sidebar lock indicator.
>
> dsh（DeepSeek Harness）Web GUI 的跨 session git 合并互斥插件——整仓单线程集成操作 + 模型侧锁工具 + 侧栏锁状态灯。

**Keywords / 标签**: `deepseek` · `deepseek-harness` · `dsh` · `dsh-plugin` · `git` · `mutex` · `multi-agent`

---

## The problem / 解决什么问题

Run several AI agent sessions against one checkout and they will eventually collide on git history: a `merge` halfway through leaves `MERGE_HEAD` behind, a `rebase` keeps rewriting the index, and a racing `git pull` from another session reads — or overwrites — that intermediate state. File locks with heartbeat TTL don't fix it: dead holders linger until expiry, TTL-based theft re-arms the original holder (the Kleppmann fencing gap), and there is no fairness.

多个 AI agent session 共用一个仓库时，`merge` / `pull` / `rebase` / `cherry-pick` / `revert` / `am` 会互相踩踏：半途现场被插入、index 竞争、冲突解决被覆盖。文件锁 + 心跳 TTL 方案存在陈旧锁、偷锁后 fencing 缺口、无公平性三个经典问题。

**This plugin's answer**: the mutex authority lives in the memory of the long-lived web host process — a per-repo FIFO queue whose leases are bound to the calling agent session's lifecycle. Lose contact, lose the lease. No stale locks, no theft, no fencing gap.

**本插件的做法**：互斥权威放在 web host 长驻进程内存里——每仓库一个 FIFO 队列，租约绑定调用方 agent 会话的生命周期。失联即失效：无陈旧锁、无偷锁、无 fencing 缺口。

## Install / 安装

Requires / 依赖: [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.1-rc.2`（在此版本验证 / verified against）, Node ≥ 18.

```bash
# 1. install into the web profile / 装进 web profile
dsh plugin --profile web add dsh-git-merge-lock

# 2. mount it — append to ~/.dsh/profiles/web/cordis.patch.yml :
#    挂载——把下面的 insert 块追加到 profile 的 cordis.patch.yml
- insert:
    - id: git-merge-lock
      name: dsh-git-merge-lock

# 3. restart dsh / 重启 dsh
```

<details>
<summary>Local development install / 本地开发安装（symlink 方式）</summary>

```
~/.dsh/plugins/git-merge-lock                      → 本仓库 plugin/
~/.dsh/profiles/web/node_modules/dsh-git-merge-lock → 同上
# 加同样的 insert 块，重启即可
```

</details>

### Uninstall / 卸载

Remove the insert block, run `dsh plugin --profile web remove dsh-git-merge-lock` (or delete the symlinks), and restart. Live locks vanish with the host process — there is no on-disk lock state to clean up. / 删 insert 块、卸载包、重启即可。锁状态在 host 内存里，随进程消失，磁盘上没有需要清理的锁文件。

## The model tool / 模型工具

`git_merge_lock` — call it around every history-mutating git operation / 在每次历史变更 git 操作前后调用：

| action | 说明 |
|---|---|
| `acquire` | FIFO 排队拿锁；拿到后立刻做 git 操作；忙时返回 busy + 持有者信息 |
| `release` | 做完立刻还锁，不跨步骤持有 |
| `status` | 查看持有者 / 等待队列 / 账本 |
| `notify` | 给持锁者留言（信箱，随其下一次调用送达） |
| `force_release` | 人工强制解锁，需 `confirm=true`，锁立即移交队头 |

```text
git_merge_lock(action="acquire", why="merging feature/x into main")
git merge …
git_merge_lock(action="release")
```

## Web UI / 浏览器界面

Each sidebar project row shows a lock indicator (grey = idle, gold = held). Click it for a dialog with status badge, holder card (manual unlock, two-step confirm), wait queue, and journal — bilingual, follows the host locale. / 侧栏项目行 hover 出锁状态灯（灰=空闲，金=有人持锁），点击弹窗查看持锁详情、等待队列、审计账本，支持两段确认的手动解锁，文案中英双语。

## Semantics / 运行语义

- **Repo-wide single-threading / 整仓单线程**：同一仓库的集成操作完全串行，不区分分支。
- **Lease lifecycle / 租约生命周期**：排队中被打断 → 立即出队；持有时会话中断 → keeper 每 5s 巡检自动释放；60 分钟硬上限。无陈旧锁判定、无偷锁、无 fencing 缺口。
- **Journal / 审计账本**：append-only `<git-common-dir>/dsh-git-lock/journal.jsonl`（acquired / waiting / released / auto_released / force_released / notified），只是账本不是锁；host 重启锁自动清空，历史可追溯。
- **Git state probing / 现场探测**：acquire/release 时只读检查 `MERGE_HEAD` / `REBASE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD`，把"上一任留下的未完成集成现场"警告给下一任持有者。
- **Config / 配置**（每次调用实时读取，改完即生效）：全局 `~/.dsh/git-merge-lock.json`（`enabled` / `timeout_s` / `desktop_notify`），项目级 `<repo>/dsh-merge-lock.json` 覆盖。

**Boundaries / 边界**：互斥权威在单个 web host 进程内——第二个 dsh 实例、裸命令行 git、跨机器进程不在保护范围。插件只仲裁"何时允许开始"，不触碰工作区。

## Development / 开发

```bash
node --check plugin/index.mjs && cp plugin/index.mjs plugin/lib/index.js   # host 半边改完同步
node --check plugin/lib/client.js                                          # client 半边
node tests/harness.mjs     # 内核语义 21 断言
node tests/endpoints.mjs   # 端点 14 断言（真实 git 临时仓）
```

Kernel: ~432 lines, zero npm dependencies (node built-ins only). / 内核约 432 行，零 npm 依赖。

## License

MIT
