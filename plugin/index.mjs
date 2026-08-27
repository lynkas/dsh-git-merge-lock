/**
 * git-merge-lock v2 — host-plane merge mutex ("方案1": 内存队列为唯一权威).
 *
 * 与 v1(文件锁)的区别:
 *   - 互斥权威 = 本 web host 进程内存中的 per-repo FIFO 队列(Promise 链),文件不再参与竞争。
 *   - 租约绑定调用生命周期:等待中被打断/超时 → 出队作废;持有中会话中断/超时/死亡
 *     → keeper 定时器自动释放;另有 60 分钟租约硬上限。没有陈旧判定、没有偷锁。
 *   - 文件降级为账本:<git-common-dir>/dsh-git-lock/journal.jsonl 只做审计与唤醒回放。
 *     进程重启锁即清空(内存态),历史仍在磁盘上。
 *   - 目标分支 = args.target_branch > workdir HEAD;symbols: 受保护分支列表走配置,
 *     全局 ~/.dsh/git-merge-lock.json + 项目覆盖 <repo>/dsh-merge-lock.json,每次调用实时重读。
 *   - 同一 session 重复 acquire 幂等;notify 留言进入持有者信箱,其下一次调用即可见。
 *
 * 边界:独立 CLI 进程不在本进程内,拿不到这把锁(它们也未注册本工具);journal 对其只读可见。
 */

export const name = 'git-merge-lock'

/** `tools` 注册模型工具;`subprocess` 用于 git rev-parse 探测。 */
export const inject = ['tools', 'subprocess']

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// 浏览器端点(Typert Gateway RPC):依赖经本目录 node_modules 软链到宿主同一份实例,
// 保证 zod schema 与网关侧 instanceof 校验同源。
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

// ── 常量 ─────────────────────────────────────────────────────────────────────

const POLL_KEEPER_MS = 5_000        // 持有期 abort 巡检间隔
const LEASE_CAP_MS = 60 * 60_000    // 租约硬上限:防止拿了不做
const JOURNAL_TAIL = 8

/** 会改动集成状态、需要互斥的 git 子命令(约束用途仅文档化;真正的强制不在此层)。 */
const LOCKED_SUBCOMMANDS = Object.freeze([
  'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'am',
])

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** 容错 JSONC:剥离字符串外的 // 与 /* *​/ 注释及尾逗号。 */
export function jsoncParse(text) {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    out += c
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'))
}

function readJsoncIfExists(file) {
  try {
    return { value: jsoncParse(fs.readFileSync(file, 'utf8')), file }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
}

// (branch-glob matching removed 2026-08-26 — the merge lock is repo-wide now.)

function homeDir() {
  return process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  branches: [],
  timeout_s: 110,
  desktop_notify: false,
})

function resolveConfig(repoTop) {
  const sources = []
  const g = readJsoncIfExists(path.join(homeDir(), 'git-merge-lock.json'))
  if (g) sources.push({ scope: 'global', file: g.file, ...g.value })
  const p = repoTop ? readJsoncIfExists(path.join(repoTop, 'dsh-merge-lock.json')) : undefined
  if (p) sources.push({ scope: 'project', file: p.file, ...p.value })
  const merged = { ...CONFIG_DEFAULTS, branches: [...CONFIG_DEFAULTS.branches] }
  for (const s of sources) {
    if (typeof s.enabled === 'boolean') merged.enabled = s.enabled
    if (Array.isArray(s.branches)) merged.branches = s.branches.filter((x) => typeof x === 'string')
    if (Number.isSafeInteger(s.timeout_s) && s.timeout_s > 0) merged.timeout_s = s.timeout_s
    if (typeof s.desktop_notify === 'boolean') merged.desktop_notify = s.desktop_notify
  }
  return { ...merged, _sources: sources.map((s) => `${s.scope}:${s.file}`) }
}

// ── 身份 ─────────────────────────────────────────────────────────────────────

function sessionOf(exec) {
  return exec?.agent?.session?.header?.id ?? process.env.DSH_SESSION_ID ?? null
}

function ident(exec) {
  return {
    sessionId: sessionOf(exec),
    pid: process.pid,
    host: os.hostname(),
    user: os.userInfo().username,
  }
}

// ── 账本(journal,只追加;不再是互斥真相) ──────────────────────────────────

async function journalAppend(journalPath, event) {
  try {
    await fsp.mkdir(path.dirname(journalPath), { recursive: true })
    await fsp.appendFile(journalPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', 'utf8')
  } catch { /* 账本失败不阻塞业务 */ }
}

async function journalTail(journalPath, n = JOURNAL_TAIL) {
  try {
    const raw = await fsp.readFile(journalPath, 'utf8')
    return raw.split('\n').filter(Boolean).slice(-n)
  } catch { return [] }
}

async function journalSize(journalPath) {
  try { return (await fsp.stat(journalPath)).size } catch { return 0 }
}

/** 回放 [offset, 现在) 区间的事件行——唤醒时告诉新持有者“你等的时候发生了什么”。 */
async function journalDeltaSince(journalPath, offset) {
  try {
    const fh = await fsp.open(journalPath, 'r')
    try {
      const size = (await fh.stat()).size
      if (size <= offset) return []
      const buf = Buffer.alloc(size - offset)
      await fh.read(buf, 0, buf.length, offset)
      return buf.toString('utf8').split('\n').filter(Boolean)
    } finally { await fh.close() }
  } catch { return [] }
}

function fmtJournal(lines) {
  return lines.length > 0
    ? lines.map((l) => {
        try {
          const j = JSON.parse(l)
          return `- ${j.ts} ${j.event}${j.session_id ? ` [${j.session_id}]` : ''}${j.reason ? ` (${j.reason})` : ''}`
        } catch { return `- ${l}` }
      }).join('\n')
    : '- (empty)'
}

function fmtHolder(cur) {
  if (!cur) return '(free)'
  const heldS = Math.round((Date.now() - (cur.handedAt ?? cur.enqueuedAt)) / 1000)
  return [
    `session: ${cur.sessionId ?? '?'}`,
    `pid: ${cur.pid}`,
    `user@host: ${cur.user}@${cur.host}`,
    `held_s: ${heldS}`,
    cur.why ? `why: ${cur.why}` : null,
  ].filter(Boolean).join(', ')
}

// ── 互斥内核(per-repo FIFO 队列;唯一权威,纯内存) ──────────────────────────

const repos = new Map() // repoKey(commondir) -> repo

function getRepo(repoKey, journalPath) {
  let r = repos.get(repoKey)
  if (!r) {
    r = {
      key: repoKey,
      journalPath,
      current: null,           // 持有者 Entry | null
      queue: [],               // 等待 Entry[]
      notes: new Map(),        // sessionId -> [{from, msg, ts}]
    }
    repos.set(repoKey, r)
  }
  return r
}

/** 把队头交给合法等待者;跳过已取消的条目。 */
function pump(repo) {
  while (!repo.current && repo.queue.length > 0) {
    const entry = repo.queue.shift()
    if (entry.abandoned) continue // 已被超时/打断路径放弃
    repo.current = entry
    entry.handedAt = Date.now()
    entry.keeper = setInterval(() => {
      if (entry.signal?.aborted) autoRelease(repo, entry, 'caller session interrupted/aborted')
    }, POLL_KEEPER_MS)
    entry.keeper?.unref?.()
    entry.deadline = setTimeout(() => autoRelease(repo, entry, `lease cap exceeded (${LEASE_CAP_MS / 60000}min)`), LEASE_CAP_MS)
    entry.deadline?.unref?.()
    journalDeltaSince(repo.journalPath, entry.journalOffset)
      .then((delta) => entry.resolve({
        ok: true,
        waited_ms: entry.handedAt - entry.enqueuedAt,
        delta,
        notes: takeNotes(repo, entry.sessionId),
      }))
      .catch(() => entry.resolve({ ok: true, waited_ms: 0, delta: [], notes: [] }))
  }
}

function removeQueued(repo, entry) {
  const i = repo.queue.indexOf(entry)
  if (i >= 0) repo.queue.splice(i, 1)
}

/** 从信箱取走属于 sessionId 的留言(消费即清除)。 */
function takeNotes(repo, sessionId) {
  if (!sessionId) return []
  const list = repo.notes.get(sessionId)
  repo.notes.delete(sessionId)
  return list ?? []
}

function peekNotes(repo, sessionId) {
  return (sessionId && repo.notes.get(sessionId)) ?? []
}

async function doRelease(repo, entry, event, reason) {
  if (repo.current !== entry) return
  repo.current = null
  clearInterval(entry.keeper)
  clearTimeout(entry.deadline)
  await journalAppend(repo.journalPath, {
    event,
    session_id: entry.sessionId,
    held_ms: Date.now() - (entry.handedAt ?? entry.enqueuedAt),
    reason: reason ?? null,
  })
  pump(repo)
}

function autoRelease(repo, entry, reason) {
  void doRelease(repo, entry, 'auto_released', reason)
}

/** 排队获取。永不 reject;超时返回 {ok:false,busy},被打断返回 {ok:false,aborted}。 */
function acquireLock(repo, exec, { why, timeoutMs }) {
  const me = ident(exec)
  const entry = {
    sessionId: me.sessionId,
    pid: me.pid,
    user: me.user,
    host: me.host,
    why: why ?? null,
    signal: exec?.signal,
    enqueuedAt: Date.now(),
    journalOffset: undefined,
    abandoned: false,
    resolve: undefined,
    keeper: undefined,
    deadline: undefined,
    handedAt: undefined,
  }
  return Promise.all([journalSize(repo.journalPath)]).then(([offset]) => {
    entry.journalOffset = offset
    return new Promise((resolve) => {
      // 唯一出口:settle()。三条路径(授予/超时/打断)都必须经过它,
      // 保证排队期计时器与 abort 监听器恰好清理一次。
      // 持有期的 keeper/deadline 由 pump() 独立负责(doRelease 清理),此处不管。
      let settled = false
      const settle = (payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.signal?.removeEventListener('abort', abortNow)
        if (!payload.ok && repo.current !== entry) entry.abandoned = true // 让 pump 跳过
        resolve(payload)
      }
      const abortNow = () => {
        if (repo.current === entry || settled) return
        removeQueued(repo, entry)
        settle({ ok: false, aborted: true })
      }

      let timer = undefined
      timer = timeoutMs > 0
        ? setTimeout(() => {
            if (repo.current === entry || settled) return
            removeQueued(repo, entry)
            settle({
              ok: false,
              busy: summarizeEntry(repo.current),
              waited_ms: Date.now() - entry.enqueuedAt,
            })
          }, timeoutMs)
        : undefined
      timer?.unref?.()

      entry.resolve = (value) => {
        if (!value?.ok) { settle(value); return }
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.signal?.removeEventListener('abort', abortNow)
        resolve(value)
      }

      // 入队前已死(调用即被中断):直接作废,不进队列浪费队头
      if (entry.signal?.aborted) {
        settle({ ok: false, aborted: true })
        return
      }
      entry.signal?.addEventListener('abort', abortNow, { once: true })

      repo.queue.push(entry)
      if (repo.queue.length > 1 || repo.current) {
        void journalAppend(repo.journalPath, {
          event: 'waiting',
          session_id: entry.sessionId,
          held_by: repo.current?.sessionId ?? null,
        })
      }
      pump(repo)
    })
  })
}

/** 超时/展示用的持有者摘要 —— 字段与 Entry/fmtHolder/StatusResult 同一形状。 */
function summarizeEntry(e) {
  if (!e) return undefined
  return {
    sessionId: e.sessionId,
    pid: e.pid,
    user: e.user,
    host: e.host,
    acquiredAtMs: e.handedAt ?? e.enqueuedAt,
    why: e.why,
  }
}

// ── git 探测(经 subprocess;未挂载时失败即报错) ─────────────────────────────

async function runGit(ctx, exec, cwd, ...argv) {
  const handle = ctx.subprocess.spawn({
    argv: ['git', '-C', cwd, ...argv],
    stdio: { stdin: 'ignore', stdout: { maxBytes: 16_000 }, stderr: { maxBytes: 4_000 } },
    ...(exec?.signal ? { signal: exec.signal } : {}),
    graceMs: 2000,
  })
  let outcome
  try { outcome = await handle.done } catch { return undefined }
  if (outcome.exitCode !== 0) return undefined
  try { return handle.collected.stdout.readFrom(0).text.trim() || undefined } catch { return undefined }
}

/**
 * 探测工作区是否遗留"未完成的合并/变基"状态(上一个持有者半途而废的现场)。
 * 只读探测(rev-parse --verify),不触碰任何仓库文件。
 * 注意:走 exitCode 而非 stdout(--quiet 成功时无输出,truthy 判断必须看退出码)。
 */
async function refExists(ctx, exec, top, ref) {
  const handle = ctx.subprocess.spawn({
    argv: ['git', '-C', top, 'rev-parse', '--verify', '--quiet', ref],
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1_000 }, stderr: { maxBytes: 1_000 } },
    ...(exec?.signal ? { signal: exec.signal } : {}),
    graceMs: 2000,
  })
  try {
    const outcome = await handle.done
    return outcome.exitCode === 0
  } catch { return false }
}

async function detectPendingIntegration(ctx, exec, top) {
  if (await refExists(ctx, exec, top, 'MERGE_HEAD')) {
    return {
      kind: 'merge',
      hint: 'run `git status` — an unfinished MERGE is in progress (MERGE_HEAD exists). '
        + 'Either resolve conflicts and `git commit` to conclude it, or `git merge --abort` to back out. '
        + 'Do NOT start another merge before settling this one.',
    }
  }
  for (const [ref, kind] of [
    ['REBASE_HEAD', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ]) {
    if (await refExists(ctx, exec, top, ref)) {
      return {
        kind,
        hint: `run \`git status\` — an unfinished ${kind} is in progress (${ref} exists). `
          + `Conclude with the matching \`--continue\`/\`--quit\` after resolving, or abort via \`--abort\`. `
          + `Do NOT start other history operations before settling this one.`,
      }
    }
  }
  return undefined
}

/** 解析仓库上下文;top/commondir 失败返回 undefined,detached 时 branch 为 null。 */
async function locate(ctx, exec, workdir) {
  const cwd = typeof workdir === 'string' && workdir.length > 0
    ? workdir
    : exec?.agent?.session?.header?.cwd
  if (!cwd) return { error: 'no workdir resolvable — pass args.workdir' }
  const top = await runGit(ctx, exec, cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel')
  const commondir = await runGit(ctx, exec, cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!top || !commondir) return { error: `not a git repository: ${cwd}` }
  const branch = (await runGit(ctx, exec, cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD')) ?? null
  return { top, commondir, branch }
}


// ── 插件装配 ─────────────────────────────────────────────────────────────────


export function apply(ctx) {
  const paramsSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['acquire', 'release', 'force_release', 'status', 'notify'],
        description: 'acquire=排队拿锁(FIFO 公平队列,可等待); release=持锁者用完释放; force_release=人工强制解锁(需 confirm=true); status=查看持锁者/等待队列/受保护分支/日志; notify=给当前持锁 session 留言催促',
      },
      workdir: { type: 'string', description: '仓库内任意路径; 默认当前会话工作目录' },
      why: { type: 'string', description: 'acquire 时说明本次要做的合并操作, 展示给等待者与 status' },
      target_branch: { type: 'string', description: '合并目标分支; 不填则取 workdir 当前分支(HEAD), 用于受保护分支过滤' },
      timeout_s: { type: 'integer', minimum: 5, maximum: 3600, description: 'acquire 最长排队等待秒数; 缺省走配置(timeout_s)' },
      confirm: { type: 'boolean', description: 'force_release 必须传 true 才执行' },
      reason: { type: 'string', description: 'force_release 的原因 / notify 的留言内容' },
    },
    required: ['action'],
    additionalProperties: false,
  }

  /** 组装“可立即并入下一条输出”的前缀信息:给本人的待阅留言。 */
  function notesPrefix(repo, sessionId) {
    const notes = takeNotes(repo, sessionId)
    if (notes.length === 0) return null
    return 'Pending messages for you:\n' +
      notes.map((n) => `- [${n.ts}] from ${n.from}: ${n.msg}`).join('\n')
  }

  ctx.tools.register({
    name: 'git_merge_lock',
    description: [
      'Repo-wide merge mutex: serializes ALL git history-mutating operations (merge, pull, rebase, cherry-pick, revert, am) within this repository — regardless of target branch. One holder at a time, fully single-threaded merges.',
      '',
      'MANDATORY WORKFLOW whenever you are about to run one of those git subcommands:',
      '  1. git_merge_lock(action="acquire", why="merging feature/x into main") — queues FIFO; you are granted in turn.',
      '  2. Run your git command(s) via bash NOW, while holding the lock.',
      '  3. git_merge_lock(action="release") immediately afterwards.',
      'If your call was interrupted mid-wait or mid-hold, the lease self-heals automatically — never needs manual cleanup.',
      'On acquire success you receive a journal delta: what other sessions did while you waited.',
      'action="status" shows holder/waiters/journal. action="notify" pings the holder.',
      'force_release is a HUMAN decision: only use it when the user explicitly asks (requires confirm=true).',
      'Config: ~/.dsh/git-merge-lock.json (global; enabled/timeout_s/desktop_notify), overridden by <repo>/dsh-merge-lock.json. Re-read on every call.',
    ].join('\n'),
    parameters: paramsSchema,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },

    async execute(args, exec) {
      const action = args.action
      const mySession = sessionOf(exec)

      // ---- status:非仓库目录也给出可读答复(不再 throw) --------------------
      if (action === 'status') {
        const loc = await locate(ctx, exec, args.workdir)
        if (loc.error) return { text: `[git_merge_lock status] ${loc.error}` }
        const repo = getRepo(loc.commondir, path.join(loc.commondir, 'dsh-git-lock', 'journal.jsonl'))
        const cfg = resolveConfig(loc.top)
        const notes = notesPrefix(repo, mySession)
        const lines = [
          `[git_merge_lock status]`,
          `repo: ${loc.top} (whole-repo merge serialization)`,
          `current_branch: ${loc.branch ?? '(detached HEAD)'}`,
          `config_sources: ${cfg._sources.join(' | ') || '(defaults only)'}`,
          `holder: ${fmtHolder(repo.current)}`,
          `waiters(${repo.queue.length}):` + (repo.queue.length
            ? '\n' + repo.queue.map((w, i) =>
              `  ${i + 1}. ${w.sessionId ?? '?'} pid=${w.pid} waited=${Math.round((Date.now() - w.enqueuedAt) / 1000)}s${w.why ? ` why=${w.why}` : ''}`).join('\n')
            : ' (none)'),
          `recent_journal:\n${fmtJournal(await journalTail(repo.journalPath))}`,
        ]
        if (notes) lines.unshift(notes)
        return { text: lines.join('\n') }
      }

      const loc = await locate(ctx, exec, args.workdir)
      if (loc.error) return { text: `[git_merge_lock] ${loc.error}` }
      const repo = getRepo(loc.commondir, path.join(loc.commondir, 'dsh-git-lock', 'journal.jsonl'))
      const cfg = resolveConfig(loc.top)

      // ---- notify ----------------------------------------------------------
      if (action === 'notify') {
        const target = repo.current
        if (!target) return { text: '[git_merge_lock] nobody holds the lock — nothing to notify.' }
        const list = repo.notes.get(target.sessionId) ?? []
        list.push({ ts: new Date().toISOString(), from: mySession ?? 'unknown', msg: args.reason ?? '(no message)' })
        repo.notes.set(target.sessionId, list)
        await journalAppend(repo.journalPath, {
          event: 'notified', session_id: mySession, to: target.sessionId, message: args.reason ?? '(no message)',
        })
        if (cfg.desktop_notify && process.platform === 'darwin') {
          try {
            const { spawn } = await import('node:child_process')
            spawn('osascript', ['-e',
              `display notification "${String(args.reason ?? 'someone is waiting').replace(/["\\]/g, '')}" with title "dsh merge lock"`]).unref()
          } catch { /* best effort */ }
        }
        return { text: `[git_merge_lock] message delivered to holder ${target.sessionId}. They will see it on their next lock call or in status.` }
      }

      // ---- force_release ---------------------------------------------------
      if (action === 'force_release') {
        if (args.confirm !== true) {
          return { text: '[git_merge_lock] force_release steals another session\'s lease — pass confirm=true (and ask the human first).' }
        }
        const victim = repo.current
        if (!victim) return { text: '[git_merge_lock] no one holds the lock.' }
        await doRelease(repo, victim, 'force_released', args.reason ?? 'manual unlock')
        return { text: `[git_merge_lock] force_release done — lock taken from ${victim.sessionId}; next waiter has been granted.` }
      }

      // ---- release ---------------------------------------------------------
      if (action === 'release') {
        const cur = repo.current
        const mine = cur && (cur.sessionId === mySession ||
          (!cur.sessionId && cur.pid === process.pid)) // 无 session 身份的降级匹配
        if (!mine) {
          const holderNote = cur
            ? `lock is held by ${cur.sessionId ?? `pid ${cur.pid}`}; to take it away use action="force_release" (confirm=true)`
            : 'no lock is currently held'
          return { text: `[git_merge_lock] release skipped: ${holderNote}.` }
        }
        const waitersBefore = repo.queue.length
        // 释放前的自我检查:确认自己没有留下未完成的合并/变基现场
        const pending = await detectPendingIntegration(ctx, exec, loc.top)
        const parts0 = []
        if (pending) {
          parts0.push(`⚠️ You are releasing while an incomplete ${pending.kind.toUpperCase()} is still in progress in ${loc.top}. `
            + `${pending.hint} If you leave it as-is, the NEXT lock holder will be told about it on acquire.`)
          await journalAppend(repo.journalPath, { event: 'released_pending_left', session_id: mySession, kind: pending.kind })
        }
        await doRelease(repo, cur, 'released', args.reason ?? null)
        const parts = [`[git_merge_lock] lock released.`, waitersBefore > 0 ? `${waitersBefore} session(s) were waiting — first in line acquires automatically.` : null, ...parts0]
        const notes = notesPrefix(repo, mySession)
        if (notes) parts.push(notes)
        return { text: parts.filter(Boolean).join('\n') }
      }

      // ---- acquire ---------------------------------------------------------
      if (action === 'acquire') {
        // 整仓单线程:enabled 即一切合并操作都需要锁,不看分支。
        if (!cfg.enabled) {
          return { text: '[git_merge_lock] lock not required: enabled=false in config. Proceed without locking.' }
        }
        // 幂等:本人已持有
        if (repo.current && repo.current.sessionId === mySession) {
          const parts = ['[git_merge_lock] you already hold this lock — run your git operation(s) NOW, then release.']
          const notes = notesPrefix(repo, mySession)
          if (notes) parts.push(notes)
          return { text: parts.join('\n') }
        }
        const timeoutS = Number.isSafeInteger(args.timeout_s) && args.timeout_s > 0
          ? args.timeout_s : cfg.timeout_s
        const r = await acquireLock(repo, exec, { why: args.why, timeoutMs: timeoutS * 1000 })
        if (!r.ok) {
          if (r.aborted) return { text: '[git_merge_lock] acquire cancelled (call interrupted while waiting).' }
          return { text: [
            `[git_merge_lock] TIMEOUT after ${r.waited_ms}ms — still held by:`,
            fmtHolder(r.busy),
            `Options: retry acquire (bigger timeout_s), do independent work,`,
            `notify(action="notify", reason="..."), or ask the human about force_release.`,
          ].join('\n') }
        }
        const parts = [
          `[git_merge_lock] ACQUIRED (waited ${(r.waited_ms / 1000).toFixed(1)}s) for ${loc.top}.`,
          `You hold the exclusive merge lease. Run your git operation(s) NOW,`,
          `then call git_merge_lock(action="release") immediately.`,
        ]
        // 上一个持有者可能半途而废:拿到锁先看现场
        const pending = await detectPendingIntegration(ctx, exec, loc.top)
        if (pending) {
          parts.push(`⚠️ INCOMPLETE ${pending.kind.toUpperCase()} DETECTED — a previous holder left this mid-operation.\n${pending.hint}`)
          await journalAppend(repo.journalPath, { event: 'pending_detected', session_id: mySession, kind: pending.kind })
        }
        if (r.delta?.length > 0) parts.push(`While waiting, these events happened:\n${fmtJournal(r.delta)}`)
        if (r.notes?.length > 0) parts.push(`Messages left for you:\n${r.notes.map((n) => `- [${n.ts}] from ${n.from}: ${n.msg}`).join('\n')}`)
        return { text: parts.join('\n') }
      }

      return { text: `[git_merge_lock] unknown action: ${action}` }
    },
  })

  // ── 浏览器端点(Typert Gateway RPC,供 web UI 锁按钮调用) ──────────────────
  // 信封:POST /api/gitMergeLock/<method>,payload.args = { projectPath[, branches] }
  // 手工 register(不经 typert-loader;schema zod v4 与网关同源实例)。

  async function statusPayload(projectPath) {
    const loc = await locate(ctx, undefined, projectPath)
    if (loc.error) return { found: false, error: loc.error }
    const repo = getRepo(loc.commondir, path.join(loc.commondir, 'dsh-git-lock', 'journal.jsonl'))
    const cfg = resolveConfig(loc.top)
    return {
      found: true,
      error: null,
      repo: loc.top,
      currentBranch: loc.branch,
      enabled: cfg.enabled,
      timeoutS: cfg.timeout_s,
      holder: repo.current ? summarizeEntry(repo.current) : null,
      waiters: repo.queue.map((w) => ({
        sessionId: w.sessionId, pid: w.pid,
        waitedMs: Math.max(0, Date.now() - w.enqueuedAt), why: w.why,
      })),
      recentJournal: (await journalTail(repo.journalPath, 12)).map((l) => {
        try { const j = JSON.parse(l); return { ts: j.ts ?? '', event: j.event ?? '', sessionId: j.session_id ?? null, reason: j.reason ?? null } }
        catch { return { ts: '', event: 'unparsed', sessionId: null, reason: null } }
      }),
    }
  }

  const StatusResult = z.object({
    found: z.boolean(),
    error: z.string().nullable(),
    repo: z.string().nullable(),
    currentBranch: z.string().nullable(),
    enabled: z.boolean(),
    timeoutS: z.number(),
    holder: z.object({
      sessionId: z.string().nullable(), pid: z.number(),
      user: z.string(), host: z.string(),
      acquiredAtMs: z.number(), why: z.string().nullable(),
    }).nullable(),
    waiters: z.array(z.object({
      sessionId: z.string().nullable(), pid: z.number(),
      waitedMs: z.number(), why: z.string().nullable(),
    })),
    recentJournal: z.array(z.object({
      ts: z.string(), event: z.string(), sessionId: z.string().nullable(), reason: z.string().nullable(),
    })),
  })

  const gitMergeLockService = {
    typertRemote: undefined, // 紧随其后绑定
    async queryMergeStatus(projectPath) {
      return statusPayload(String(projectPath ?? ''))
    },
    /**
     * 手动解锁(UI 锁按钮弹窗里的🔓按钮)。
     * 只释放内存租约并把事件记入 journal——绝不触碰任何 session/回合,
     * 持有者下次调用 lock 工具时会看到"锁已不在你手上"的提示。
     */
    async manualUnlock(projectPath, reason) {
      const loc = await locate(ctx, undefined, projectPath)
      if (loc.error) throw new Error(loc.error)
      const repo = getRepo(loc.commondir, path.join(loc.commondir, 'dsh-git-lock', 'journal.jsonl'))
      const victim = repo.current
      if (!victim) return { released: false, detail: 'no lock is currently held' }
      await doRelease(repo, victim, 'force_released', `manual unlock via web UI: ${reason ?? '(no reason given)'}`)
      return { released: true, formerHolder: victim.sessionId ?? `pid ${victim.pid}` }
    },

  }
  gitMergeLockService.typertRemote = bindTypertRemote(gitMergeLockService, 'gitMergeLock')
  try {
    ctx.provide?.('gitMergeLock', gitMergeLockService)
  } catch (e) {
    // HMR 热重载等场景的重复挂载:已有实例时保留旧实例即可
    console.warn(`[git-merge-lock] provide skipped: ${e?.message}`)
  }

  // 浏览器端点描述符:guard 掉无 inject 能力的裸环境(离线单测)
  if (typeof ctx.inject !== 'function') return

  const zs = (symbol, schema) => ({ mode: 'strict', typeSymbol: `git-merge-lock#${symbol}`, schema })
  ctx.inject(['typert'], (tc) => {
    try {
      tc.typert.register({
      package: 'git-merge-lock',
      face: 'host',
      schemas: [],
      invocations: [
        {
          id: 'git-merge-lock#gitMergeLock/queryMergeStatus',
          service: 'gitMergeLock',
          namespace: 'gitMergeLock',
          method: 'queryMergeStatus',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'projectPath', wire: 'projectPath', source: 'json', codec: zs('ProjectPath', z.string()) },
          ],
          result: { mode: 'strict', typeSymbol: 'git-merge-lock#MergeStatus', schema: StatusResult },
        },
        {
          id: 'git-merge-lock#gitMergeLock/manualUnlock',
          service: 'gitMergeLock',
          namespace: 'gitMergeLock',
          method: 'manualUnlock',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'projectPath', wire: 'projectPath', source: 'json', codec: zs('ProjectPath', z.string()) },
            { name: 'reason', wire: 'reason', source: 'json', codec: zs('Reason', z.string().nullable()) },
          ],
          result: {
            mode: 'strict',
            typeSymbol: 'git-merge-lock#UnlockResult',
            schema: z.object({ released: z.boolean(), detail: z.string().nullable(), formerHolder: z.string().nullable() }),
          },
        },
      ],
      model: { services: [], events: [], objects: [] },
      })
    } catch (e) {
      console.warn(`[git-merge-lock] typert register skipped: ${e?.message}`)
    }
  })
}

// 测试专用内部件(勿在生产路径使用)
export const __internals = { jsoncParse, resolveConfig, getRepo, acquireLock, repos }
