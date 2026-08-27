# dsh-git-merge-lock

dsh (DeepSeek Harness) 的跨 session **git 合并互斥插件**:整仓库单线程合并,
附侧栏锁状态灯 + 弹窗(持锁详情 / 手动解锁)。

## 目录结构

```
dsh-git-merge-lock/
├── plugin/              ← 插件真身(双半边包,被 ~/.dsh 引用)
│   ├── index.mjs        ← host 半边源码(FIFO 队列互斥内核 + git_merge_lock 工具 + RPC 端点)
│   ├── cordis.patch.yml ← 自指向 insert 行(bundle 层挂载声明)
│   ├── package.json     ← dsh.bundle.patch + dsh.client(web)双面声明
│   ├── lib/index.js     ← host 产物(index.mjs 的同步副本;改源码后 cp 覆盖)
│   ├── lib/client.js    ← 浏览器半边(手写 __ModuleLoader__ bundle,无构建步)
│   └── node_modules/    ← cordis / dsh-typert-protocol / zod 的符号链接(指宿主同名实例)
├── tests/
│   ├── harness.mjs      ← 内核语义套件(FIFO/租约/自愈/信箱等)
│   └── endpoints.mjs    ← Typert 端点 + 服务层套件
└── docs/                ← 三份宿主机制调研报告(挂载/RPC/slots 的证据链)
```

## 生产安装点(勿删)

| 路径 | 形态 | 作用 |
|---|---|---|
| `~/.dsh/plugins/git-merge-lock` | symlink → 本目录 `plugin/` | .dsh 插件发现 |
| `~/.dsh/profiles/web/node_modules/dsh-git-merge-lock` | symlink → 同上 | 客户端模块解析(`<name>/package.json` 双腿解析要求裸包名) |
| `~/.dsh/profiles/web/cordis.patch.yml` | `- insert: [{id: git-merge-lock, name: dsh-git-merge-lock}]` | 组合挂载 |
| `~/.dsh/git-merge-lock.json` | 配置(enabled / timeout_s / desktop_notify) | 每次调用实时读取 |

回滚:删除上述四项 + 按 `~/.dsh/restart-dsh.sh` 重启即可。

## 运行语义(v2,"方案1")

- **整仓单线程**:同一仓库任意 merge/pull/rebase/cherry-pick/revert/am 完全串行,不看分支。
- 唯一权威 = web host 进程内存中的 per-repo FIFO 队列;`<git-common-dir>/dsh-git-lock/journal.jsonl`
  只是审计账本(host 重启锁自动清空,历史可追溯)。
- 租约绑定调用生命周期:等待中被打断即出队;持有中会话中断由 keeper(5s)自动释放;
  60 分钟硬上限。**没有陈旧锁判定、没有偷锁、没有 fencing 缺口**。
- 合并动作仍由各 session 自己执行:插件只管"何时允许开始",不触碰工作区。
- acquire 时探测 MERGE_HEAD 等"未完成集成现场",警告下一个持有者;release 前同样自检并留痕。

## 模型工具

`git_merge_lock`,actions:`acquire`(FIFO 排队)/ `release` / `force_release`(需 confirm=true)/
`status` / `notify`(留言进持有者信箱)。

## 浏览器 UI

侧栏项目行 hover 出现的三图标组最左侧为 🔒(Material Symbols 内联 SVG):
灰色=空闲,金色=有人持锁。点击弹 dialog:状态徽标、holder 卡片(含手动解锁,两段确认,
只释放租约不打断对方 session)、等待队列、journal。文案中英双语,跟随宿主 locale。

RPC(统一信封 POST `/api/gitMergeLock/<method>`):
`queryMergeStatus(projectPath)` / `manualUnlock(projectPath, reason)`。

## 开发与测试

```bash
# 改 host 半边后:
node --check plugin/index.mjs && cp plugin/index.mjs plugin/lib/index.js   # 然后重启 dsh
# 改 client 半边后:
node --check plugin/lib/client.js                                          # 浏览器硬刷新即可(磁盘直读)
# 回归:
node tests/harness.mjs     # 内核 21 断言
node tests/endpoints.mjs   # 端点 14 断言(依赖真实 git 临时仓)
# 联调实例(独立 DSH_HOME,不碰生产):
DSH_HOME=~/.dsh-gml-test node <dsh>/lib/bin.js --profile test --port 3081
```

前端若改版导致行选择器(`[class*="_projectRow"]` 等语义类名)失效,见 docs/research-ui-slots.md。
