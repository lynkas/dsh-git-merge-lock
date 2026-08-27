# git-merge-lock v2 — host 平面合并互斥插件

## 这是什么

跨 session 的 git 历史变更互斥（merge / pull / rebase / cherry-pick / revert / am）。
模型工具 `git_merge_lock`：acquire（FIFO 排队）/ release / force_release / status / notify。

## 为什么重写（v1 → v2）

| | v1 | v2 |
|---|---|---|
| 挂载位置 | `anchored-standard` 实验性 preset（无任何会话使用 ⇒ 等于不存在，即"没权限"问题的根因） | web profile host 平面（**所有** preset、所有会话可见） |
| 互斥权威 | 文件锁 + 心跳 TTL + 死进程判定 + 偷锁 | **host 进程内存 FIFO 队列**（每仓库一个），文件只做审计账本 |
| 租约生命周期 | 无（忘记 release 要等 120s TTL 被偷） | 绑定调用 abort signal：等待中被打断即出队；持有中会话中断/超时由 keeper(5s) 自动释放；60 分钟硬上限 |
| 公平性 | 抢文件先到先得（advisory） | 严格 FIFO，无饥饿 |
| fencing 缺口 | 存在（Kleppmann 问题） | 不存在——失联即失效，资格从不下放 |

**边界**：独立 CLI 进程不共享 host 内存，不在保护范围（它们本来也不注册此工具）；
合并动作仍由各 session 自己执行，插件只管"何时允许开始"。

## 配置（每次调用实时读取，改完即生效）

- 全局：`~/.dsh/git-merge-lock.json` —— `enabled / branches / timeout_s / desktop_notify`
- 项目覆盖：`<repo>/dsh-merge-lock.json`（web UI 锁按钮弹窗保存的就是它）
- 目标分支判定：调用方传的 `target_branch` > workdir 当前 HEAD；
  只有落点命中 `branches` 才需要锁（全局默认已收紧为 `["main"]`）。

## 运行痕迹

- 账本：`<git-common-dir>/dsh-git-lock/journal.jsonl`（acquired/waiting/released/
  auto_released/force_released/notified）
- 无锁状态文件；host 重启锁自动清空（内存态），历史仍可追溯。

## 测试

离线语义套件 `/tmp/gml-harness.mjs`（26 断言）：FIFO 公平、等待中止、持有者中断
5s 自动移交、幂等 acquire、越权 release 拒绝、超时 busy、notify 信箱、force_release
移交、分支过滤、双仓库隔离。跑法：`node /tmp/gml-harness.mjs`。

## 回滚

删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `- insert: … git-merge-lock …`
块（及本目录），按 `~/.dsh/restart-dsh.sh` 重启即可。
