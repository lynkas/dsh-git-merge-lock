// git-merge-lock web 客户端半边
// 形态:ychnis12138/dsh-usage-stats 同款"手工无构建" bundle——
//   window.__ModuleLoader__.load({ id:<包名>, factory })
// id 必须等于 boot 图里的 entry 名(本包 npm 名 dsh-git-merge-lock)。
//
// 结构(证据见 /tmp/research-ui-slots.md):
//   ① 常驻 React 挂点 = sidebar.footer.action 列表槽(加性、失败 try/catch 不伤主),
//      承担:useWorkspaces(title→path 映射)、后台轮询点亮锁按钮、dialog 渲染(createPortal 自绘,
//      session-id 插件同款在产先例)。
//   ② 每个项目行的 🔒 按钮 = MutationObserver + DOM 注入(无 per-row slot),
//      锚点 [data-slot="sidebar.workspaces"] 内 [class*="_projectRow"] > [class*="_rowActions"],
//      click 必须 stopPropagation(官方行 onClick 是展开/收起)。
//   ③ 数据通道 = 裸 fetch 统一信封 POST /api/gitMergeLock/<method>
//      body {type:"client-request", rpcId, method, payload:{args}},响应取 .result.value。
window.__ModuleLoader__.load({
  id: 'dsh-git-merge-lock',
  factory: (require) => {
    // 宿主 runner 以严格模式经典函数调用 factory 且不提供 module 形参:
    // 先例(session-id bundle)在 factory 内自备 CommonJS 两件套。
    var module = { exports: {} }
    var exports = module.exports
    const { useState, useEffect, useRef, useCallback, createElement: h } = require('react')
    const { createPortal } = require('react-dom')

    // ── 常量 ────────────────────────────────────────────────────────────────
    const WS_SLOT = '[data-slot="sidebar.workspaces"]'
    const PROJECT_ROW = '[class*="_projectRow"]'
    const ROW_ACTIONS = '[class*="_rowActions"]'
    const ROW_TITLE = '[class*="_projectText"]'
    const BTN_ATTR = 'data-gml-btn'
    const ROW_MARK = 'data-gml-done'
    const RPC = '/api/gitMergeLock/'
    const POLL_DIALOG_MS = 3000
    const POLL_LIGHTS_MS = 5000

    // ── RPC 信封(§6:POST /api/<ns>/<method>,取 .result.value) ─────────────
    async function rpc(method, args) {
      const res = await fetch(RPC + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: `gitMergeLock/${method}`,
          payload: { args },
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const full = await res.json()
      if (!full.result?.ok) throw new Error(full.result?.error?.message ?? JSON.stringify(full.result?.error))
      return full.result.value
    }
    const queryStatus = (projectPath) => rpc('queryMergeStatus', { projectPath })

    // ── 图标:Material Symbols Outlined(Google 官方 path data,24 网格,fill currentColor)──
    const MS_LOCK = {
      viewBox: '0 -960 960 960',
      d: 'M240-80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h40v-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Zm0-80h480v-400H240v400Zm240-120q33 0 56.5-23.5T560-360q0-33-23.5-56.5T480-440q-33 0-56.5 23.5T400-360q0 33 23.5 56.5T480-280ZM360-640h240v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85v80ZM240-160v-400 400Z',
    }
    const MS_LOCK_OPEN = {
      viewBox: '0 -960 960 960',
      d: 'M240-80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h40v-80q0-83 58.5-141.5T480-920q66 0 118 41t70 105l-76 28q-11-38-38.5-61T480-820q-50 0-85 35t-35 85v80h360q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Zm0-80h480v-400H240v400Zm240-120q33 0 56.5-23.5T560-360q0-33-23.5-56.5T480-440q-33 0-56.5 23.5T400-360q0 33 23.5 56.5T480-280ZM240-160v-400 400Z',
    }
    function faSvg(icon, sizePx) {
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg', viewBox: icon.viewBox, width: sizePx, height: sizePx,
        fill: 'currentColor', 'aria-hidden': true,
      }, h('path', { d: icon.d }))
    }

    // ── 模块内状态桥(生产形态,不用 window 全局) ────────────────────────────
    let openPanelFor = null            // (WorkspaceView|null)=>void,由常驻挂点注入
    const wsByTitle = new Map()        // title -> WorkspaceView
    const lights = new Map()           // title -> 'off'|'lit'|'hidden'
    const gitOk = new Map()            // title -> true(git 仓库)|false(非 git,永不上锁)|undefined(未探测)
    const probing = new Set()          // 正在异步探测的 title(防重复请求)

    /** 把点亮状态刷到已注入的按钮上(sweep 后与轮询后都调用)。 */
    function applyLights() {
      document.querySelectorAll(`[${BTN_ATTR}]`).forEach((btn) => {
        const t = btn.getAttribute(BTN_ATTR)
        const mode = lights.get(t) ?? 'off'
        // 非 git 仓库:按钮整个不渲染(由 inject 侧守卫;此处兜底移除任何残留)
        if (gitOk.get(t) === false) { btn.remove(); rowUnmark(btn); return }
        btn.classList.toggle('gml-lit', mode === 'lit')
        // 显隐完全交给官方 hover 组 CSS;这里只管颜色/tooltip。
        // 点亮 = accent 金;否则回到按钮内联的基础色(官方 iconButton 同款三级灰)。
        btn.style.color = mode === 'lit'
          ? 'var(--dsw-color-accent, #e8b339)'
          : 'var(--dsw-alias-label-tertiary, #adb2b8)'
        btn.style.opacity = mode === 'lit' ? '1' : ''
        btn.title = mode === 'lit' ? `Merge lock held — ${t}` : `Git merge lock — ${t}`
      })
    }

    function rowUnmark(btn) {
      btn.closest('[class*="_projectRow"]')?.removeAttribute(ROW_MARK)
    }

    /**
     * 探测某 title 对应的 workspace 是否 git 仓库(权威判定:后端 rev-parse)。
     * 结果缓存:true/false 不再重探;undefined=探测中。
     */
    async function probeGit(title) {
      if (gitOk.has(title)) return gitOk.get(title)
      const wsView = wsByTitle.get(title)
      // workspace 映射尚未就绪(启动竞态):不缓存,返回 null 表示"未知,稍后重试"
      if (!wsView?.path) return null
      if (probing.has(title)) return undefined
      probing.add(title)
      try {
        const d = await queryStatus(wsView.path)
        const ok = d.found === true
        gitOk.set(title, ok)
        return ok
      } catch { probing.delete(title); return undefined }
    }

    // ── ① dialog(status + 分支编辑器) ────────────────────────────────────
    // 语言判定:优先宿主 locale 服务(snapshot.active —— 即用户在 Settings 里选的语言),
    // 回退浏览器语言。locale 服务在 apply(ctx) 后才可取 → makeL 延迟到那时调用。
    let L = null
    function makeL(activeId) {
      const zh = String(activeId ?? 'en').toLowerCase().startsWith('zh')
      return {
        zh,
        locked: () => zh ? '🔒 已上锁' : '🔒 LOCKED',
        free: () => zh ? '○ 空闲' : '○ FREE',
        detached: () => zh ? '(分离头指针)' : '(detached HEAD)',
        heldBy: () => zh ? '持有者' : 'held by',
        held: () => zh ? '已持' : 'held',
        why: () => zh ? '原因' : 'why',
        waiting: (n) => zh ? `等待中 (${n}):` : `waiting (${n}):`,
        waited: () => zh ? '已等' : 'waited',
        manualUnlock: () => zh ? '手动解锁' : 'Unlock manually',
        confirmUnlock: () => zh ? '确认解锁?' : 'Confirm unlock?',
        neverMind: () => zh ? '算了' : 'Never mind',
        unlockTooltip: () => zh ? '只释放锁,不会打断持有者的 session 或正在进行的操作' :
          'Releases the lease only — the holder session keeps running untouched',
        unlockingNote: () => zh ? '将强制释放该锁(journal 记 force_released)。持有者 session 不受影响。' :
          'Force-releases the lease (journaled as force_released). The holder session is untouched.',
        unlockedNote: (h) => zh ? `已解锁(原持有者 ${h})。其下次调用锁工具时会发现锁已不在手上。` :
          `Unlocked (was ${h}). The holder will find the lock gone on its next lock-tool call.`,
        unlockFailed: (e) => zh ? `解锁失败:${e}` : `Unlock failed: ${e}`,
        savedNote: (n, p) => zh ? `已保存(${n} 条,${p})` : `Saved ${n} to ${p}`,
        loading: () => zh ? '加载中…' : 'loading…',
        recentJournal: () => zh ? '最近日志' : 'recent journal',
        emptyJournal: () => zh ? '(空)' : '(empty)',
      }
    }

    function LockDialog({ ws, onClose }) {
      const [st, setSt] = useState({ loading: true, data: null, err: null })
      const [saving, setSaving] = useState(false)
      const [note, setNote] = useState(null)

      useEffect(() => {
        let alive = true
        let fails = 0
        const tick = async () => {
          try {
            const data = await queryStatus(ws.path)
            fails = 0
            if (alive) setSt({ loading: false, data, err: null })
          } catch (e) {
            // 结构性失败(旧页面对新 host):dialog 里连续失败 5 拍 → 自动刷新自愈
            if (++fails >= 5) { console.warn('[git-merge-lock] dialog RPC stale — reloading'); location.reload(); return }
            if (alive) setSt({ loading: false, data: null, err: String(e.message ?? e) })
          }
        }
        tick()
        const timer = setInterval(tick, POLL_DIALOG_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [ws.path])

      // ── 手动解锁:两段确认;只释放租约,不打断持有者的 session/回合 ──
      const [unlocking, setUnlocking] = useState(false)   // 已按第一下,等待确认
      const doUnlock = async () => {
        if (!unlocking) { setUnlocking(true); return }
        setUnlocking(false); setSaving(true); setNote(null)
        try {
          const r = await rpc('manualUnlock', { projectPath: ws.path, reason: 'manual unlock from lock dialog' })
          setNote(r.released ? L.unlockedNote(r.formerHolder) : L.unlockFailed(r.detail))
          const data = await queryStatus(ws.path)
          setSt({ loading: false, data, err: null })
        } catch (e) { setNote(String(e.message ?? e)) } finally { setSaving(false) }
      }

      // 状态行分支名(点分隔的多个分支/保护列表在编辑态显示)
      const d = st.data
      return h('div', { role: 'presentation', style: S.overlay },
        h('div', { style: S.mask, onClick: onClose }),
        h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Git merge lock', style: S.panel }, [
          h('div', { style: S.head }, [
            h('h2', { style: S.h2 }, '\uD83D\uDD12 Git Merge Lock'),
            h('button', { style: S.x, onClick: onClose, 'aria-label': 'close' }, '\u00d7'),
          ]),
          h('div', { style: S.sub }, ws.path),

          st.loading
            ? h('p', { style: { ...S.dim, textAlign: 'center', padding: '18px 0' } }, L.loading())
            : st.err
              ? h('p', { style: S.err }, String(st.err))
              : h('div', null, [

                  // ── 占用情况 ──
                  h('div', { style: S.section },
                    // 状态徽标行:整行 flex 居中。整仓单线程模式:分支信息不再展示。
                    h('div', {
                      style: {
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                        fontWeight: 600, marginBottom: d.holder || d.waiters.length ? 8 : 0,
                      } },
                      [
                        faSvg(d.holder ? MS_LOCK : MS_LOCK_OPEN, 15),
                        h('span', { key: 's' }, d.holder ? L.locked() : L.free()),
                      ]),
                    d.holder && h('div', { style: S.card }, [
                      h('div', null, [`${L.heldBy()} `, h('code', { key: 's' }, d.holder.sessionId ?? `pid ${d.holder.pid}`)]),
                      h('div', { style: S.dim }, `${d.holder.user}@${d.holder.host} · ${L.held()} ${fmtDur(Date.now() - d.holder.acquiredAtMs)}`),
                      d.holder.why && h('div', { style: S.dim }, `${L.why()}: ${d.holder.why}`),
                      // 手动解锁行:🔓 + 两段确认(第一下变"确认解锁?",再点才执行)
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } }, [
                        h('button', {
                          style: unlocking ? S.btnDanger : S.btn,
                          onClick: doUnlock,
                          title: L.unlockTooltip(),
                        }, [
                          faSvg(MS_LOCK_OPEN, 14),
                          unlocking ? L.confirmUnlock() : L.manualUnlock(),
                        ]),
                        unlocking && h('button', { style: S.btnGhost, onClick: () => setUnlocking(false) }, L.neverMind()),
                      ]),
                      unlocking && h('div', { style: S.dim, marginTop: 4 }, L.unlockingNote()),
                    ]),
                    d.waiters.length > 0 && h('div', { style: { ...S.card, marginTop: 6 } },
                      h('div', { style: S.dim }, L.waiting(d.waiters.length)),
                      d.waiters.map((w, i) => h('div', { key: i },
                        `– ${w.sessionId ?? `pid ${w.pid}`} · ${L.waited()} ${fmtDur(w.waitedMs)}${w.why ? ` · ${w.why}` : ''}`))),
                  ),

                  h('details', { style: { marginTop: 8 } }, [
                    h('summary', { style: S.dim }, L.recentJournal()),
                    h('pre', { style: S.pre },
                      (d.recentJournal ?? []).map((j) => `${j.ts.slice(11, 19)} ${j.event}${j.sessionId ? ` [${j.sessionId}]` : ''}${j.reason ? ` (${j.reason})` : ''}`).join('\n') || L.emptyJournal()),
                  ]),
                ]),
        ]))
    }

    // ── ② 常驻挂点(footer.action):桥接 + 轮询点亮 ─────────────────────────
    function FooterEntry(props) {
      const [open, setOpen] = useState(null)
      openPanelFor = setOpen
      const items = props.useWorkspaces?.((s) => s.items) ?? []

      useEffect(() => {
        wsByTitle.clear()
        for (const w of items) wsByTitle.set(w.title, w)
      }, [items])

      useEffect(() => {
        let alive = true
        let consecutiveFail = 0
        const refresh = async () => {
          if (document.visibilityState === 'hidden') return
          for (const w of items) {
            if (!alive) return
            try {
              const d = await queryStatus(w.path)
              consecutiveFail = 0
              lights.set(w.title, !d.found ? 'hidden' : d.holder ? 'lit' : 'off')
            } catch {
              // 旧页面 + 新 host 的组合会在这里持续失败(schema/字段随版本演进)。
              // 连续多拍全失败 → 判定 bundle 过期,自动硬刷新自愈,而不是永远 FREE。
              if (++consecutiveFail >= Math.max(3, items.length)) {
                console.warn('[git-merge-lock] RPC keeps failing — stale page detected, reloading')
                location.reload()
                return
              }
            }
          }
          applyLights()
        }
        refresh()
        const timer = setInterval(refresh, POLL_LIGHTS_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [items])

      return open ? createPortal(h(LockDialog, { ws: open, onClose: () => setOpen(null) }), document.body) : null
    }

    // ── ③ 行内按钮注入(MutationObserver,rAF 合帧,幂等) ───────────────────
    function startDomInjection() {
      const injectRow = (row) => {
        if (row.hasAttribute(ROW_MARK)) return
        const title = row.querySelector(ROW_TITLE)?.textContent?.trim() ?? ''
        if (!title) return
        // git 守卫:非 git 仓库(或探测中未确认)不渲染锁。
        // probeGit 是异步的——同步阶段先放行已确认 true 的,其余异步复核后下帧处理。
        const known = gitOk.get(title)
        if (known === false) {
          row.setAttribute(ROW_MARK, '') // 已确认非 git:不再注入
          return
        }
        void probeGit(title).then((ok) => {
          if (ok === false) { applyLights(); return }      // 非 git:清残留即可(row 已 mark)
          if (ok === true) { schedule(); return }           // git:下一帧注入按钮
          // null = workspace 数据未就绪:稍后单独重试这一行,不触发全表重扫
          setTimeout(() => schedule(), 2000)
        })
        if (known !== true) return
        // 挂进官方 _rowActions hover 组:与 Menu/[+] 同排,hover 一起出现消失。
        const actions = [...row.children].find((c) => c.matches(ROW_ACTIONS))
        if (!actions) return // 官方结构变化时放弃注入(保持零侵入)
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute(BTN_ATTR, title)
        btn.className = 'gml-lock-btn'
        btn.setAttribute('aria-label', `Git merge lock — ${title}`)
        // Material Symbols lock 内联 SVG(fill=currentColor);视觉规范对齐官方 iconButton:
        // 16×16 热区、15px 图标、三级文字色、radius 4、hover 提亮。插入位置:Menu 前(最左)。
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MS_LOCK.viewBox}" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="${MS_LOCK.d}"/></svg>`
        btn.style.cssText = 'cursor:pointer;background:none;border:none;border-radius:4px;padding:0;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:var(--dsw-alias-label-tertiary,#adb2b8)'
        btn.addEventListener('mouseenter', () => { if (btn.style.color !== '') btn.style.filter = 'brightness(1.3)' })
        btn.addEventListener('mouseleave', () => { btn.style.filter = '' })
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault()
          const wsView = wsByTitle.get(btn.getAttribute(BTN_ATTR)) ?? null
          if (wsView) openPanelFor?.(wsView)
        })
        actions.insertBefore(btn, actions.firstChild) // 排在最左:🔒 [menu] [+]
        row.setAttribute(ROW_MARK, '')
        applyLights()
      }
      let scheduled = false
      const sweep = () => document.querySelectorAll(`${WS_SLOT} ${PROJECT_ROW}`).forEach(injectRow)
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => { scheduled = false; sweep() })
      }
      sweep()
      const mo = new MutationObserver(schedule)
      mo.observe(document.body, { childList: true, subtree: true })
      return () => {
        mo.disconnect()
        document.querySelectorAll(`[${BTN_ATTR}]`).forEach((b) => b.remove())
        document.querySelectorAll(`[${ROW_MARK}]`).forEach((r) => r.removeAttribute(ROW_MARK))
      }
    }

    // ── 工具 ────────────────────────────────────────────────────────────────
    function fmtDur(ms) {
      const s = Math.max(0, Math.round(ms / 1000))
      if (s < 90) return `${s}s`
      const m = Math.round(s / 60)
      if (m < 90) return `${m}m`
      return `${Math.round(m / 60)}h`
    }

    // 样式:全部内联 + 主题变量兜底(session-id 同策略)
    // 按钮:size 令牌统一(高度 28 / 字号 12 / padding 对齐)——btn/primary/danger 共用一套尺度。
    const BTN = {
      base: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        height: 28, padding: '0 14px', borderRadius: 6, fontSize: 12, fontWeight: 500,
        cursor: 'pointer', lineHeight: 1, whiteSpace: 'nowrap',
        transition: 'opacity .12s ease, background .12s ease',
      },
      disabled: { opacity: .5, cursor: 'default' },
    }
    const S = {
      overlay: { position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      mask: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(2px)' },
      panel: {
        position: 'relative', width: 520, maxWidth: '92vw', maxHeight: '82vh', overflowY: 'auto',
        background: 'var(--dsw-bg-elevated, #1e1f22)', color: 'var(--dsw-text-primary, #e6e6e6)',
        borderRadius: 12, padding: '18px 20px', boxShadow: '0 18px 50px rgba(0,0,0,.5)', fontSize: 13,
      },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
      h2: { margin: 0, fontSize: 15, fontWeight: 600 },
      x: { background: 'none', border: 'none', color: 'inherit', fontSize: 20, cursor: 'pointer', lineHeight: 1,
           width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
      sub: { fontFamily: 'monospace', fontSize: 11, opacity: .7, wordBreak: 'break-all', marginBottom: 10 },
      section: { margin: '12px 0', padding: '12px 14px', border: '1px solid rgba(128,128,128,.25)', borderRadius: 8 },
      label: { fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
      card: { background: 'rgba(128,128,128,.12)', borderRadius: 6, padding: '6px 9px', marginTop: 4 },
      // 编辑态按钮行:输入框与三个按钮同一水平线、等高(34px,跟大号分支文字协调)
      btn: { ...BTN.base, background: 'transparent', border: '1px solid rgba(128,128,128,.4)', color: 'inherit' },
      btnPrimary: { ...BTN.base, background: 'var(--dsw-color-accent, #4f7cff)', border: 'none', color: '#fff' },
      btnDanger: { ...BTN.base, background: 'rgba(220,69,69,.15)', border: '1px solid rgba(220,69,69,.6)',
                   color: '#ff7a7a' },
      btnGhost: { ...BTN.base, background: 'transparent', border: 'none', color: 'inherit', opacity: .75 },
      err: { color: 'crimson' },
      dim: { opacity: .65, fontSize: 12 },
      note: { marginTop: 8, opacity: .85, fontSize: 12 },
      pre: { fontSize: 11, whiteSpace: 'pre-wrap', margin: '6px 0 0' },
    }

    // ── 插件出口 ────────────────────────────────────────────────────────────
    const inject = ['slots', 'workspaces', 'locale']   // fiber 门禁:slots 注册 + workspaces + locale 快照
    function apply(ctx) {
      // 初始化文案语言:读宿主 locale 服务的当前激活语言(含 Settings 语言偏好)。
      try {
        const snap = ctx.locale?.getLocale?.() ?? ctx.get?.('locale')?.getLocale?.()
        L = makeL(snap?.active)
      } catch { L = makeL(null) }
      if (!L) L = makeL(null)

      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'git-merge-lock' },
          FooterEntry,
        ))
      } catch (e) {
        console.warn('[git-merge-lock] footer mount unavailable:', e?.message ?? e)
      }
      const stopInj = typeof document !== 'undefined' ? startDomInjection() : () => {}
      return () => { stopInj(); openPanelFor = null }
    }
    return module.exports = { apply, inject }
  },
})
