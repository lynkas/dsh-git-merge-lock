# DSH Web 客户端:第三方插件如何给侧边栏每个项目行加图标按钮 + 弹自绘 dialog

调查日期:2026-02-15 · 只读调查,宿主 = `/Users/cat/.nvm/versions/node/v24.17.0/lib/node_modules/@deepseek-ai/dsh`(下称 `DSH`,其内 `node_modules/@deepseek-ai/*` 下称 `@ds/*`)。
所有路径均给绝对路径 + 行号。两处先纠偏:

> **纠偏 1**:社区包实名是 **`@linxin666/*`**(npm 上),GitHub 仓库是 `zhu1090093659/dsh-web`;`dsh-web-ui-all` 0.3.5 只是聚合+兼容壳(其中只有 compat shim 的 client.js),真正的 UI 插件各自发 npm 包(`@linxin666/dsh-client-ui-session-id`、`@linxin666/dsh-client-ui-skin-center` 等)。本机未克隆该仓库,本次从 npm registry 拉 tarball 到 `/tmp/linx/` 精读。
>
> **纠偏 2**:"projectRoot" 字样只存在于服务端包;浏览器侧项目列表的路径字段是 **`WorkspaceView.path`**(见 §4)。

---

## TL;DR

| 问题 | 结论 |
|---|---|
| 有没有"每个工作区行右侧加按钮"的 slot? | **没有**。`sidebar.workspaces` 是 single 槽、被官方 ui-workspace 独占;唯一加性侧栏槽是 `sidebar.footer.action`(列表槽,脚部图标位) |
| 那怎么给每行加按钮? | **MutationObserver + DOM 注入**,锚点:`div[data-slot="sidebar.workspaces"]` 内的 `[class*="_projectRow"] > [class*="_rowActions"]`(think-flow / linxin666 兼容层同款模式,有成熟先例) |
| dialog 怎么弹? | 首选 `require("@deepseek-ai/dsh-client-ui-primitives").Modal`(React portal);第三方实测先例:`react-dom.createPortal(document.body)` 自绘 `position:fixed` overlay(session-id 插件) |
| 项目列表数据 | 每个 slot 组件自带全局标准 props **`useWorkspaces(selector)`**(items: `WorkspaceView[]`,`{workspaceId, path, title, ...}`);或 apply 闭包里拿 `ctx.get("workspaces").list`(SnapshotStore) |
| factory 里 require('react') | ✅ 可用。React **18.3.1**,staticModules 表含 react / react-dom / react-dom/client 等 10 个模块 |
| zod | ❌ **不在 staticModules**;`require('zod')` 在浏览器会炸。remote.$mount/描述符 schema 要么随自己 bundle 内联 zod,要么走 JSON/plain object |

---

## 1. slots 插座体系

### 1.1 三层结构

```
@deepseek-ai/dsh-client-ui-slots   纯注册表 SlotCore(无 cordis、零依赖)
@deepseek-ai/dsh-client-runtime    Service 层 SlotRegistry(ctx.slots)+ 全部 slot 契约类型
@deepseek-ai/dsh-client-web-react  React 渲染机(SlotOutlet / createSlotRenderer)
```

- **纯核** `@ds/dsh-client-ui-slots/lib/index.js`:
  - `SlotCore.register(options, component)` L64–144:四种 kind(single/keyed/list/chain)、priority 影子选举(L70–91,"lowest renders")、`children` 声明即独占渲染权(L92–137,"one declarer per slot",L94 抛错)、返回 disposer 且级联塌陷子声明(L138–143, L363–383)。
  - `root` 是唯一先天声明(L55–63)。
  - 订阅面:`subscribe`(微任务批量)L270–276、`subscribeDeclaration` L287–293、`onMutate` L310–315、崩溃自愈 `reportEntryError` L332–340。
- **Service 层** `@ds/dsh-client-runtime/lib/types/client/slots.d.ts`:
  - `readonly register: SlotCore['register']` — **L74**;经 cordis service proxy 绑定调用者 fiber,卸载自动级联。
  - `inject(key, callback)` — **L90**(实现在 `lib/client.js` L44–110):等某 slot 声明出现→执行回调,回调里 register;声明塌陷自动回收。这是第三方标准入口(think-flow、session-id 全用它)。
  - `renderSlot('root'...)` 仅壳可调 — L114 注释、运行时守卫 `lib/client.js:155-156`。
  - `'root'` 契约警告 **勿直接注册**:single 槽第二笔是整体替换整页(d.ts L10–19:"the page would render your component alone … For a surface of your own … register into `shell.overlay` instead")。

### 1.2 出口 DOM 盖戳(第三方 DOM 钩子的根基)

`@ds/dsh-client-web-react/lib/index.js`:

```js
// L607-616
function SlotOutlet({ slotKey, ownerProps, opts }) { ...
  return jsx("div", { "data-slot": slotKey, style: ANCHOR_STYLE /* display:contents */, children: ... });
}
```

即页面上每个插座都渲染成 `<div data-slot="<槽名>" style="display:contents">`;'root' 同样盖戳(L725–727)。**这就是 `[data-slot="sidebar.workspaces"]` 类选择器的来源**(think-flow 已在用,见 §2)。

### 1.3 完整 slot 名册(全部 SlotMap 声明,grep `interface SlotMap` 于 @ds/**/*.d.ts)

| 槽名 | kind/scope | 拥有者→占用者 | 注册它是 |
|---|---|---|---|
| `root` | single/root | runtime→ui-layout AppFrame | ⛔ 整页替换 |
| `sidebar` | single/root | layout→ui-sidebar SidebarRoot | ⛔ 整列替换(layout 明示"To add something to the sidebar, register into one of those inner seats instead",`dsh-client-ui-layout/lib/types/client/index.d.ts` L31-37) |
| `sidebar.workspaces` | single/root | sidebar→**ui-workspace WorkspaceBrowser** | ⛔ 替换整个浏览区(`replaceRisk: shadows-shipped-ui`) |
| `sidebar.settings` | single/root | sidebar→settings-general SettingsRoot | ⛔ shadowing |
| **`sidebar.footer.action`** | **list/root** | sidebar→cordis-panel(`id 'cordis-panel'`) | ✅ **加性**,新 id 并排加在侧栏脚(runner 目录 L3346-3384,示例就在里面) |
| `shell.overlay` | list/root | layout→(空) | ✅ 加性全帧浮层,层本身 click-through、条目 opt-in 指针事件(L77-90 契约;实现 `.overlayLayer{z-index:20;pointer-events:none}`+`>*{pointer-events:auto}`,layout client.js L56/L235-239);目录与官方推荐写法见 runner client.js **L3289-3325** |
| `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` | single/root | workspace→browse/native picker | 单格替换 picker 流 |
| `conversation` / `details` | single/session-maybe·session | layout→ui-conversation | ⛔ 整栏替换 |
| `conversation.chat.node` `.assistant-actions` `.commandview` `.turnTail`、`conversation.composer` `.bar` `.dock`、`conversation.input.left/right/model/plan/dock/overlay`、`conversation.session.header(.actions)(.utilities)`、`conversation.view`、`conversation.details.tool`、`conversation.hero.workspace` `.agentPreset`、`conversation.composer`(chain) | 各种 | ui-conversation 系列 | 各置换/追加,详见 `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` 与 runner 目录 L2150–2897 |
| `tool.call.toolview` | keyed/session | ui-tool | ✅ 开放 key 域(按 wire 工具名,未认领 key=加性)runner L3441+ |
| `tool.view.cordis`、`conversation.chat.*` 其余、`settings.section/general.item/action/close/header/onboarding/plugins.tab/trigger`、`settings.plugin.item`、`conversation.input.overlay` | — | settings-* / input-trigger / ui-cordis | 详见对应 slots.d.ts |

权威自文档:**`@ds/dsh-cordis-client-runner/lib/client.js` L~2100–3530 内嵌整个 slot catalog**(每槽 kind/scope/registerOptions/ownerProps/standardProps/occupants/**replaceRisk**/可直接抄的 example/source 行号)。例如 `settings.section` 条目(约 L3227 起)自带完整例:

```js
example: "return { inject: ['slots'], apply(ctx) { ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'my-entry', order: 100, label: 'My entry' },
  () => React.createElement('div', null, 'hello')) ) }, }"
```

### 1.4 注入点签名(props 给什么、约束)

`ComposedProps`(`@ds/dsh-client-ui-slots/lib/types/index.d.ts` **L358**)四/share 交集:

- **owner share**:父 renderSlot 调用点给的契约对象(如 footer.action 只有 `{ wide: boolean }`,`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` **L65-68**)。
- **全局标准 props**(每个槽都有):`{ useSessions, useWorkspaces }` — runtime 合并进 `GlobalStandardProps`(**`dsh-client-runtime/lib/types/client/index.d.ts` L86–90**);runner 目录每个槽的 `standardProps` 字段同样列出。
- session 作用域槽再加 `sessionId`(`SessionStandardProps`)。
- 子渲染 share `renderSlot/renderSlotChain`(仅当你 children 声明时,且声明了就必须渲染,编译期 RendersCheck index.d.ts L409–413)。
- store seat / inject face(自己的业务面,以闭包工厂 `inject: () => ({...})` 提供)/ locale `t`(声明 `locale: NS` 才给,没装 locale face 会 fail-loud,index.d.ts L414-431)。

组件就是普通 React 函数组件 `(props) => ReactNode` —— **需要 react**(由 shell 提供,见 §5)。list 槽注册必须带 `id`(同 id 同 priority 二次注册抛错并指名占位者,core L82-87);"用新 id=并列新增,复用别人 id=顶替那个格子"(catalog registerOptions 文案)。

### 1.5 真实消费样例(精读)

**A. `@linxin666/dsh-client-ui-session-id@0.3.5`(`/tmp/linx/dsh-client-ui-session-id/package/lib/client.js`)— 最贴近"往侧栏加东西"的官方槽用法**

- 工厂头:L1–12 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`,`require("react")`, `require("react-dom")`, `require("@deepseek-ai/dsh-client-ui-primitives")`, `require("react/jsx-runtime")`。
- 服务声明:L432–435 `const inject = ["slots", "locale", "sessions"]`(与 package.json `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]` L?? 并存,后者是 boot manifest 的加载依赖边,见 §7)。
- **注册**:L438–456
  ```js
  ctx.slots.inject("sidebar.footer.action", () => {
      const sessions = ctx.get("sessions");
      const list = { getSnapshot: () => sessions.list.getSnapshot(), subscribe: (fn) => sessions.list.subscribe(fn) };
      try {
          return ctx.slots.register({ name: "sidebar.footer.action", id: "session-id", locale: NS,
              inject: () => ({ list }) }, SessionIdEntry);
      } catch { return () => {}; }
  });
  ```
- 组件:L240–290 `SessionIdEntry({ wide, list, t })` —— 接 owner 的 `wide` 决定宽/rail 图标,**点击 setState → `react_dom.createPortal(...)` 自绘 dialog**(见 §3B)。

**B. 动态开关模板**:`@linxin666/dsh-remote-web-ui@0.3.5` lib/client.js **L4401–4422**:`ctx.slots.inject("sidebar.footer.action", () => { let disposeEntry; const syncEntry = () => enabled() && !disposeEntry ? (disposeEntry = ctx.slots.register({...}, FooterRemoteEntry)) : (!enabled() && disposeEntry ? (disposeEntry(), disposeEntry = void 0) : 0); const un = settingsScope.subscribe(syncEntry); syncEntry(); return () => { un(); disposeEntry?.(); }; })` —— "配置驱动的挂/摘"。同一个文件 L4380 还演示了向不存在槽名 `sidebar.remote` 注册时 try/catch 吞掉(no-op 收场),说明注册不存在的槽只会抛异常、不会崩页面。

---

## 2. 「每个项目条目」没有槽 → MutationObserver + DOM 注入 fallback

### 2.1 侧栏项目行的真实 DOM/类名

`WorkspaceBrowser` 渲染的分组头行(ui-workspace 是 `sidebar.workspaces` 唯一占用者):

- 注册证据:`@ds/dsh-client-ui-workspace/lib/client.js` **L2398–2407**(`ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({ name: "sidebar.workspaces", children: {...directoryFlow}, store, inject, locale }, WorkspaceBrowser))`)。
- 行 JSX:**L469–545**
  ```jsx
  <div className={clsx(Rows.projectRow, menuOpen && Rows.menuOpen)} role="treeitem" aria-expanded={row.expanded} onClick={onToggle} ...>
    <span class="slot folder">📁</span><span class="slot chevron">▸</span>
    <span class="projectText"><span class="title">{label}</span></span>
    <span class="rowActions">
      [Menu(rename/delete)] [button.newSession +]     ← hover 才 display:inline-flex
    </span>
  </div>
  ```
- **没有任何 data-testid/data-*(workspace/sidebar 包 grep 无结果)**;钩子只能靠 CSS Modules 编译产物:样式表内嵌于 client.js L334(css$2),映射表 L360 `"projectRow": "YDXeBa_projectRow"` → 运行时类名为 `<hash前缀>_原名` 格式。hash 段随构建变化,选择器要写 `[class*="_projectRow"]`、`[class*="_rowActions"]`(linxin666 兼容层的 `[class*="sidebarCol"]` 同理,`/tmp/dsh-web-ui-all/rewrite/lib/client.js` L8–11、L280–296)。
- 列容器链:`.pI_x6G_frame` → `[data-shell-overlay]` 兄弟层外,侧栏列 div.sidebarCol → `div[data-slot="sidebar"]` → `div[data-slot="sidebar.workspaces"]`(display:contents 锚由 web-react SlotOutlet 生成,§1.2;compat CSS 直接用了这个结构:`[data-dsh-frame][data-sidebar-collapsed] [data-pane="sidebar"] > [data-slot="sidebar"] …`,rewrite client.js L16–150)。
- frame 元素本身盖有官方属性:**`data-sidebar-collapsed` / `data-details-collapsed`**(`@ds/dsh-client-ui-layout/lib/client.js` **L222–224**)。

### 2.2 可行性评估:高。三个在产先例

1. **think-flow(本地)** `~/dsh-think-flow-flow/src/client.tsx`:对 `document.body` 挂 `MutationObserver({childList:true, subtree:true, characterData:true})`(L272–284),靠 `data-*` 约定找目标:
   - `[data-streaming]`、`[data-variant="think"]`(+`data-state="running"` 判活)L150/L243–254;
   - 读模型名的 `[data-slot="conversation.input.model"]` + 内部 `[aria-label]` L120–133 —— **直接消费了宿主 SlotOutlet 的 data-slot 戳**;
   - 工程细节:records>5000 直接放弃防冻结 L319–321;我们自己的 DOM 改动也会触发 observer(rAF 合帧去抖、幂等检查);
   - 注册方式 L707–718:`ctx.slots.inject("settings.section", () => ctx.slots.register({name, id:"think-flow", order:100, label:()=>"Think Flow", inject:()=>({})}, ThinkFlowSettings))`;apply 返回 disposer(L724–739)。
2. **linxin666 兼容壳** rewrite/lib/client.js L279–344:`class*=…` 选择器找 frame → `setAttribute` 盖自有 `data-dsh-frame`/`data-pane` 戳;MutationObserver 回调只调度一帧一次 rAF,幂等后停手;整段跑在 `ctx.effect(() => {…return 清理}, "名字")` 里。
3. **session-id / remote-web-ui**:说明第三方组件拿到 React 渲染权后可以随意 createPortal,不必受槽位置限制。

注入点选 `[class*="_rowActions"]`(它常驻 DOM、hover 显示,天然与官方按钮同排)或在 projectRow 右端 append;按钮要 `stopPropagation()`(否则触发行的 onToggle 展开/收起,官方 newSession 按钮正是这么干的,L505–512)。行↔项目映射用标题文本匹配(useWorkspaces 的 items[].title 或 path basename,注意"未分组"桶和重名可能,标注为启发式)。

### 2.3 约定总结(照 think-flow 学)

- observer 进 apply() 里的 `ctx.effect(...)`,disposer 里 disconnect + 移除已注入节点;
- 目标永远锚官方稳定戳(`data-slot=*`、frame 的 `data-sidebar-collapsed`)或 `[class*="_语义名"]`;
- 自己写入 DOM 也被观察到 → 幂等标记(如给注入按钮设 `data-<你的插件名>` 再查重跳过);
- 长任务(轮询)不要 setTyped 全局 setTimeout(fiber 卸载会漏清理),优先事件回调/useEffect 内建立并在 cleanup 取消(think-flow 头注释与 DYNAMIC_CLIENT_REDIRECTS,L41–53:动态包禁 setTimeout/fetch 直呼;npm 静态插件无此沙箱截留,fetch 可直接用——session-id 的 heartbeat 就是裸 fetch,L380–398)。

---

## 3. dialog / 弹窗

**A. 官方 Modal(推荐)**:`require("@deepseek-ai/dsh-client-ui-primitives").Modal`
- 类型:`@ds/dsh-client-ui-primitives/lib/types/Modal.d.ts` L19–30:`Modal({open,onClose,title,closeLabel?,description?,children?,footer?,className?,contentClassName?,headless?}): ReactPortal|null`,Escape/遮罩点击关闭,"centered modal over a blurred page mask",关闭态返回 null。
- 官方消费者实例:`@ds/dsh-client-ui-directory-picker-browse/lib/client.js:674`、`dsh-client-ui-agent-preset/lib/client.js:1041/1339/1361`、`dsh-client-ui-settings-models/lib/client.js:990/2046/2116`。
- 同包还有 Menu(portal: true 定位到 body,Menu.d.ts L38)、HoverCard、Toast(fixed banner)。

**B. vanilla overlay 先例(在产第三方代码)**:session-id 面板不走 Modal,而是
```js
open && (0, react_dom.createPortal)(jsx("div", { className: styles.overlay, role: "presentation",
  children: [ jsx("div", {className: styles.mask, onClick: onClose}),
              jsx("div", {className: styles.panel, role:"dialog", "aria-modal":"true", ...}) ] }), document.body)
```
(client.js L208–260、portal 调用约 L287–295;CSS 自己写字段,贴全部样式变量 `var(--dsw-alias-*)`。)remote-web-ui 同款两处(L2257、L2453)。
另有槽位路线:把常驻浮层登记为 `shell.overlay` 的一个 id(§1.3),适合 toast/badge 型;一次性模态用上面两条更简单。

---

## 4. 项目列表数据(浏览器侧)

- **没有叫 projectRoot 的浏览器导出**(grep 全 @ds/*:仅服务端 `dsh-agent-instructions`、`dsh-skill-filesystem` 有此词)。浏览器侧实体:
  ```ts
  // @ds/dsh-host-apiproxy/lib/types/api/workspace.d.ts L18-33
  interface WorkspaceView { workspaceId; path: string; title: string; sessionIds: SessionId[]; createdAt; updatedAt }
  ```
  `title` 创建时默认取 path basename —— 行标题即它(workspaceLabel 逻辑 ui-workspace client.js L84–87)。
- **数据源 1(React 内,最方便)**:每个槽组件自带全局 hook `useWorkspaces(selector)`(§1.4)。状态形状 `WorkspaceListState`(`@ds/dsh-client-runtime/lib/types/client/workspaces/service.d.ts` **L9–26**):`items: readonly WorkspaceView[]` + phase/error/baselinesReady/recentWorkspaceId。ui-workspace 自己就这么读(client.js L1648–1650)。
- **数据源 2(apply 闭包里,非 React 环境)**:`ctx.get("workspaces")`(`WorkspaceRuntime`,service.d.ts **L42** `readonly list: SnapshotStore<WorkspaceListState>` → `{getSnapshot(), subscribe(fn)}`,session-id 对 sessions.list 用同构包装:L440–443)。记得把 `"workspaces"` 写进模块底部 `export inject = [...]`(service 访问按 fiber inject 门禁,runner client.js L320–323)。
- Host API 本体:`WorkspaceApi.list/create/delete/insertBefore...`(`@ds/dsh-host-apiproxy/lib/types/api/workspace.d.ts` L35+,workspace.list → `{items, archivedSessionIds}`);ctx 高层面板方法 `connectWorkspace/startSession/create/pickDirectory/…`(runner 目录 workspaces 条目 L1407+)。
- **侧栏组件本体**:`packages/client/ui-workspace`(发布名 `@deepseek-ai/dsh-client-ui-workspace`)的 `WorkspaceBrowser`/`Rows`;壳壳件在 `@deepseek-ai/dsh-client-ui-sidebar`(SidebarRoot 占 `sidebar` 槽、声明三个内座,其 contract/slots.d.ts L12–45)。

---

## 5. react 版本与 staticModules(factory 里 require 什么)

- **React 版本:18.3.1**(`DSH/node_modules/react/package.json` version;ui-slots devDep `@types/react ~18.3.1` 同期)。
- **staticModules(frozen module table,fetch bundle 的 require 只解析这张表)**:`@ds/dsh-client-web/lib/index.js` **L165–178** `getStaticModules()`:

  | specifier | L# |
  |---|---|
  | `react` | 167 |
  | `react/jsx-runtime` | 168 |
  | `react-dom` | 169 |
  | `react-dom/client` | 170 |
  | `@deepseek-ai/cordis` | 171 |
  | `@deepseek-ai/dsh-client-ui-slots` | 172 |
  | `@deepseek-ai/dsh-client-web-react` | 173 |
  | `@deepseek-ai/dsh-client-ui-primitives` | 174 |
  | `@deepseek-ai/dsh-client-ui-attachment` | 175 |
  | `@deepseek-ai/dsh-client-schema-form` | 176 |

  单一事实源 `PLATFORM_MODULES`(同文件 **L419–431**;docstring L156–164 明言"These are the ONLY entities the shell shares…anything else 不在表里"→ 未列出的 specifier 必须打进你自己的 bundle)。
- 注意 `@deepseek-ai/dsh-client-runtime` **不在表里**:runtime 能力一律经 `apply(ctx)` 的服务门(`ctx.slots`、`ctx.workspaces`、`ctx.sessions`、`ctx.locale`…)获得,而非 require。

## 6. zod 在浏览器?

- staticModules **无 zod**(上表即全部);宿主 node_modules 里虽有 zod 4.4.3(`DSH/node_modules/zod`),那是 host 半侧的事,不影响 frozen 表。
- 结论:`factory(require)` 里 **`require('zod')` 会失败**。`ctx.remote.$mount(contribution)` 的 schema(policy):typert 描述符期望 codec/schema 对象——host 半可以用同进程 zod 实例(参照 `~/.dsh/plugins/git-merge-lock/index.mjs` L736 起:host 端 `tc.typert.register({...schemas/statusResult(zod)...})` 手工注册);**客户端**要么 a) 构建时把 zod 内联进自己的 bundle(tsdown/vite 只 external PLATFORM_MODULES),b) 发 plain-object/JSON-schema 型描述符,或 c) 干脆不在浏览器碰 $mount、用 `fetch POST /api/<ns>/<method>` 走通用网关信封(§7)。远程网关客户端的 wire:`dsh-api-gateway/lib/client.js` L256 `connection.rpc.call("/api", endpoint, {args}, signal)` → `dsh-client-connection/lib/client.js` **L10094–10112**:
  ```
  POST {origin}/api/<endpoint>
  body = { type:"client-request", rpcId:<uuid>, method:"<ns>/<method>", payload:{ args:{...} } }
  resp = { rpcId, result: {ok:true,value} | {ok:false,error} }   // HTTP 非 200 直接 throw
  ```

---

## 7. 加载机制补注(把 §2 的散点串起来)

- **boot**:`dsh-client-modules` 扫描各已装包 package.json 的 `dsh.client`(platform/inject/immediately,`lib/index.js` L60–99),serve `/plugins/<id>/client.js?rev=<sha1_12>`,并把入口图注入 `window.__DSH_BOOT__`(L101–113)。浏览器侧解析 in `dsh-client-modules/lib/client.js` L202–239。
- **插件形态**:`lib/client.js` 第一行必须是 `window.__ModuleLoader__.load({id:"<npm包名>", factory:(require)=>{…; return module.exports}})`(boot 缺失时报错文案:`dsh-cordis-client-runner/lib/client.js:550`);导出 `{ apply(ctx), inject:["slots","locale","sessions",…] }`。package.json 例(session-id):
  ```json
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dsh": { "engines": {"dsh": ">=0.1.1-rc.1"},
           "bundle": {"patch": "./cordis.patch.yml"},
           "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" } }
  ```

---

## 最终推荐实现骨架

目标:**每个项目(workspace)行右侧一枚 🔒 按钮(仅当该项目处于受保护分支/锁活动时点亮),点击弹自绘 dialog 展示锁状态,打开期间轮询 `POST /api/gitMergeLock/queryMergeStatus`。**

设计取舍(基于上文证据):
- 按钮本体走 **DOM 注入**(无 per-row slot,§2);dialog 组件本身作为 **slot 常驻组件**(放哪都行的渲染挂点)挂 `sidebar.footer.action`(加性、失败 try/catch 不伤主,§1.3/1.5A),从中用 `createPortal` 弹 dialog —— 这样按钮的 onClick 由原生事件桥接到 React state,不用在裸 DOM 里维护 UI 状态。
- 数据用 `useWorkspaces` 建 title→path 映射;轮询用 `setInterval` 于 useEffect 中、cleanup 清除(npm 静态插件无 timer 截留,§2.3)。
- HTTP 信封照 §6:L10094 的 `POST /api/gitMergeLock/queryMergeStatus`,body `{type:"client-request", rpcId:crypto.randomUUID(), method:"gitMergeLock/queryMergeStatus", payload:{args:{projectPath}}}`;返回取 `.result.value`(标 未验证 的字段已在下文注明)。

```js
// git-merge-lock-web/lib/client.js —— 以 window.__ModuleLoader__.load({id, factory}) 打包
window.__ModuleLoader__.load({
  id: "@you/dsh-git-merge-lock-web",
  factory: (require) => {
    const { useState, useEffect, useRef, createElement: h, Fragment } = require("react");
    const { createPortal } = require("react-dom");
    const { jsx, jsxs } = require("react/jsx-runtime");
    // 可选:require("@deepseek-ai/dsh-client-ui-primitives").Modal ← 想省事就用它替下面的自绘 panel

    const ROW_ACTIONS = '[class*="_rowActions"]';            // §2.1 L497/:styles map L360 "YDXeBa_rowActions"
    const PROJECT_ROW = '[class*="_projectRow"]';
    const ROW_TITLE   = '[class*="_projectText"] [class*="_title"]';
    const WS_SLOT     = '[data-slot="sidebar.workspaces"]';  // §1.2 SlotOutlet 盖戳
    const BTN_ATTR    = 'data-gitmerge-lock-btn';
    const RPC_URL     = '/api/gitMergeLock/queryMergeStatus';// §6 dsh-client-connection L10094

    // ---- 状态桥(裸 DOM 点击 → React 面板) -------------------------------
    let openPanelFor = null;                                  // (ws: WorkspaceView|null) => void

    function statusPanel(WsView, onClose) {                   // 自绘 dialog(仿 session-id L208-260)
      const [st, setSt] = useState({ loading: true, data: null, err: null });
      const pollRef = useRef();
      const tick = async () => {
        try {
          const res = await fetch(RPC_URL, { method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request',
              rpcId: crypto.randomUUID(),
              method: 'gitMergeLock/queryMergeStatus',       // endpointOf → ns/method(§6 gateway L256)
              payload: { args: { projectPath: WsView.path } } }) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const full = await res.json();                     // {rpcId,result}
          setSt(full.result.ok ? { loading:false, data: full.result.value, err:null }   // value=statusPayload
                               : { loading:false, data:null, err:full.result.error });
        } catch (e) { setSt({ loading:false, data:null, err:String(e) }); }
      };
      useEffect(() => { tick(); pollRef.current = setInterval(tick, 3000);   // 轮询:start
                       return () => clearInterval(pollRef.current); }, []);  // 清理:closure
      return jsxs('div', { style: FIXED_OVERLAY_STYLE, role:'presentation', children: [
        jsx('div', { style: MASK_STYLE, onClick: onClose }),
        jsxs('div', { role:'dialog','aria-modal':'true','aria-label':'Git merge lock',
          style: PANEL_STYLE, children: [
          jsx('h2', null, 'Git Merge Lock — ' + WsView.title),
          st.loading ? jsx('p', null, 'loading…')
            : st.err ? jsx('p', {style:{color:'crimson'}}, String(st.err))
            : jsxs(Fragment, { children: [
                jsx('p', null, 'branch: ' + (st.data.currentBranch ?? '-')),       // 未验证:字段以
                jsx('p', null, 'holder: ' + (st.data.holder ? st.data.holder.user  // ~/.dsh/plugins/git-merge-lock/
                  +' @'+st.data.holder.host+' ('+st.data.holder.why+')' : 'none')),// index.mjs statusPayload 为准
              ] }),
          ] }) ] });
    }

    // ---- ① footer 挂点:提供面板渲染权 + 稳定生命周期 ---------------------
    function FooterEntry(props) {                             // props 含 useWorkspaces/wide/t(§1.4)
      const [ws, setWs] = useState(null);
      openPanelFor = setWs;                                   // 裸 DOM 回调 → setState 桥
      const items = props.useWorkspaces((s) => s.items);
      const byTitle = useRef(new Map());
      useEffect(() => { byTitle.current = new Map(items.map(w => [w.title, w])); }, [items]);
      window.__gmlByTitle = byTitle;                          // 简化:暴露给注入逻辑(生产请走模块内变量)
      return ws === null ? null : createPortal(statusPanel(ws, () => setWs(null)), document.body);
    }

    // ---- ② DOM 注入:每个 _projectRow 的 _rowActions 补一颗锁按钮 ---------
    function startDomInjection() {
      const mark = row => row.hasAttribute('data-gml-done');
      const injectRow = (row) => {
        if (mark(row)) return;
        const actions = [...row.children].find(c => c.matches(ROW_ACTIONS));
        if (!actions) return;
        const title = row.querySelector(ROW_TITLE)?.textContent ?? '';
        const btn = document.createElement('button');
        btn.type='button'; btn.setAttribute(BTN_ATTR,''); row.setAttribute('data-gml-done','');
        btn.textContent='🔒'; btn.style.cssText='cursor:pointer;background:none;border:none;padding:0 2px';
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();            // 别触发行折叠(L469 onClick:onToggle)
          openPanelFor?.(window.__gmlByTitle?.current.get(title) ?? null);
        });
        actions.appendChild(btn);
      };
      const sweep = () => {                                   // rAF 合帧 + 幂等(think-flow L310-347 范式)
        document.querySelectorAll(`${WS_SLOT} ${PROJECT_ROW}`).forEach(injectRow);
      };
      let scheduled = false;
      const schedule = () => { if (scheduled) return; scheduled = true;
        requestAnimationFrame(() => { scheduled=false; sweep(); }); };
      sweep();
      const mo = new MutationObserver(schedule);
      mo.observe(document.body, { childList:true, subtree:true });
      return () => {                                          // 卸载:清掉所有注入痕迹(§2.3)
        mo.disconnect();
        document.querySelectorAll(`[${BTN_ATTR}]`).forEach(b=>b.remove());
        document.querySelectorAll('[data-gml-done]').forEach(r=>r.removeAttribute('data-gml-done'));
      };
    }

    // ---- ③ 标准插件出口 --------------------------------------------------
    const NS = 'git-merge-lock-web';
    const inject = ['slots', 'workspaces'];                   // fiber 门禁(§4/runner L320)
    function apply(ctx) {
      try { ctx.locale?.register?.(NS, { zh: {/*…*/}, en: {/*…*/} }); } catch {}
      // footer 入口:面板挂点(theme/locale 都声明失败也不伤主,try/catch §1.5B)
      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name:'sidebar.footer.action', id:'git-merge-lock', locale: NS,
            inject: () => ({ /* 业务面,可选 */ }) }, FooterEntry));
      } catch (e) { console.warn('[git-merge-lock-web] footer entry unavailable:', e); }
      // per-row 按钮:DOM 注入,disposer 交 ctx.effect
      const stopInj = typeof document !== 'undefined' ? startDomInjection() : () => {};
      return () => { stopInj(); openPanelFor = null; };       // apply 返回值也会被收集(think-flow L724-739)
    }
    return module.exports = { apply, inject };
  }
});
```

逐条对照验证过的符号:`window.__ModuleLoader__.load({id,factory})`(§7)、`ctx.slots.inject/register({name,id,locale,inject},Comp)`(§1.2/§1.5A)、list 槽必填 `id` 新值=新增(§1.3 catalog L3346+)、owner prop `wide`(§1.4)、全局 `useWorkspaces(s=>s.items)`(§1.4/runtime types index.d.ts L89)、`createPortal(body)` 自绘 overlay(§3B)、`POST /api/<ns>/<method>` 信封(§6)、row 选择器 `[class*="_projectRow"/"_rowActions"]` + stopPropagation(§2.1)。
**标“未验证”处**:① `statusPayload` 返回字段的服务端枚举值(本地 `~/.dsh/plugins/git-merge-lock/index.mjs` L637–671 可查证,zod StatusResult 在 L673–694 —— found/currentBranch/enabled/lockRequiredForCurrentBranch/holder/waiters 等,建议按它收敛 UI 分支);② 生产实现应去掉骨架里 `window.__gmlByTitle` 这个偷懒桥,改成模块内闭包变量;③ 若壳以后给 `rowActions` 加被动观察或改版 hash 类名,`[class*="_…"]` 需同步;④ CSS-module hash 前缀(`YDXeBa_`/`pI_x6G_`)每次构建都可能变 —— 本骨架从未引用具体 hash 值,勿引入。

### 附:备选路线(不推荐/受限)
- **shadow `sidebar.workspaces`(priority ≠ 0 的 same-cell second registration,§1.1 core L70-74 允许且"lowest renders")**:能完全接管浏览区自行渲染每一行+按钮——但等于 fork 整个 WorkspaceBrowser,upgrade 即碎,catalog 已标 `replaceRisk: shadows-shipped-ui`。
- **`shell.overlay` 放按钮**(§1.3):它是帧级浮层,不能落进行内,只适合全帧 badge/toast/dialog-mirror。
