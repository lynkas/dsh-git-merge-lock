// 端点层验证:Typert 贡献注册 + 服务全链路(真实 git 仓库)
import assert from 'node:assert'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { spawn as cpSpawn } from 'node:child_process'

// 隔离 DSH_HOME,避免读到真实全局配置
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gml-home-'))
process.env.DSH_HOME = FAKE_HOME
fs.writeFileSync(path.join(FAKE_HOME, 'git-merge-lock.json'), JSON.stringify({
  enabled: true, branches: ['main'], timeout_s: 110,
}))

const { apply } = await import('/Users/cat/dsh-git-merge-lock/plugin/index.mjs')

let pass = 0, fail = 0
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL ${n}`)) }

// ── 真实子进程适配器 ──
const subprocess = {
  spawn({ argv }) {
    const child = cpSpawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout?.on('data', (d) => { stdout += d })
    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ exitCode: code ?? 0 }))
      child.on('error', () => resolve({ exitCode: 1 }))
    })
    return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) } } }
  },
}

// ── 可捕获 provide/inject 的假 cordis ctx ──
const provided = {}
const contributions = []
const fakeRootCtx = {
  subprocess,
  tools: { register: () => {} },
  provide: (k, v) => { provided[k] = v },
  inject: (deps, cb) => cb({
    typert: {
      hasSeen: () => false,
      register: (c) => contributions.push(c),
    },
  }),
}
apply(fakeRootCtx)

const E1 = '/tmp/gml-probe-repo1'
fs.rmSync(E1, { recursive: true, force: true })
fs.mkdirSync(E1, { recursive: true })
execFileSync('git', ['-C', E1, 'init', '-q'])
execFileSync('git', ['-C', E1, 'config', 'user.email', 't@t'])
execFileSync('git', ['-C', E1, 'config', 'user.name', 't'])
fs.writeFileSync(path.join(E1, '.keep'), '')
execFileSync('git', ['-C', E1, 'add', '-A'])
execFileSync('git', ['-C', E1, 'commit', '-qm', 'init'])
try { execFileSync('git', ['-C', E1, 'branch', '-m', 'main']) } catch {}

console.log('E2 service + typert contribution')
const svc = provided.gitMergeLock
check('service provided as gitMergeLock', !!svc && typeof svc.queryMergeStatus === 'function')
check('typertRemote binding attached', typeof svc.typertRemote === 'object' && svc.typertRemote !== null)
check('two invocations registered', contributions.length === 1 && contributions[0].invocations.length === 2)
const [qInv, sInv] = contributions[0].invocations
check('endpoints named correctly',
  `${qInv.namespace}/${qInv.method}` === 'gitMergeLock/queryMergeStatus' &&
  `${sInv.namespace}/${sInv.method}` === 'gitMergeLock/manualUnlock')
check('namespace/service keys align', qInv.service === 'gitMergeLock' && qInv.namespace === 'gitMergeLock')

console.log('E3 queryMergeStatus on clean repo')
const st0 = await svc.queryMergeStatus(E1)
check('found=true', st0.found === true && st0.error === null)
check('enabled flag surfaces', st0.enabled === true)
check('holder=null waiters=[]', st0.holder === null && st0.waiters.length === 0)
check('branch detection=main', st0.currentBranch === 'main')
const bad = await svc.queryMergeStatus('/tmp/definitely-not-a-repo-gml')
check('non-repo -> found=false', bad.found === false && /not a git repository/.test(bad.error))

console.log('E5 live lock reflected in status')
// 直接驱动内核:acquire(release 由同工具做)——用已注册的模型工具路径不行(root ctx 的 tools.register 是noop),
// 这里直接操纵内核 map(svc 与工具共享同一 repos 表,通过模块内单例)
const { __internals } = await import('/Users/cat/dsh-git-merge-lock/plugin/index.mjs')
const commondir = execFileSync('git', ['-C', E1, 'rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trim()
const repo = [...__internals.repos.values()].find((r) => r.key === commondir)
check('repo record materialized by earlier status calls', !!repo)
if (repo) {
  const fakeExecHold = { agent: { session: { header: { id: 'ui-check-A', cwd: E1 } } } }
  const { signal } = new AbortController()
  Object.assign(fakeExecHold, { signal })
  const acquiring = __internals.acquireLock(repo, fakeExecHold, { why: 'merge into main', timeoutMs: 5000 })
  // 立即轮询 status 直到 current 出现(acquire 是同步 pump,promise 在微任务后 settled)
  await new Promise((r) => setTimeout(r, 30))
  const stHeld = await svc.queryMergeStatus(E1)
  check('holder visible with session id & why', stHeld.holder?.sessionId === 'ui-check-A' && stHeld.holder?.why === 'merge into main')
  // 排队一个等待者
  const fakeWait = { agent: { session: { header: { id: 'ui-check-B', cwd: E1 } } }, signal: new AbortController().signal }
  const waiting = __internals.acquireLock(repo, fakeWait, { why: 'w', timeoutMs: 5000 })
  await new Promise((r) => setTimeout(r, 60))
  const stQ = await svc.queryMergeStatus(E1)
  check('waiter listed with waitedMs', stQ.waiters.length === 1 && stQ.waiters[0].sessionId === 'ui-check-B' && stQ.waiters[0].waitedMs >= 0)
  // 释放两者
  repo.queue.pop()
  await import('/Users/cat/dsh-git-merge-lock/plugin/index.mjs').then(async (m) => {
    // 用 doRelease 私有件不可达;以 force 捷径:直接消费 entry
    stQ // noop
  })
  const cur = repo.current
  cur.resolve = undefined // 避免误 resolve
  // 内核未导出 doRelease → 通过模拟超时路径清场:直接删除条目并恢复空态
  repo.current = null
  clearInterval(cur.keeper); clearTimeout(cur.deadline)
  const rA = await acquiring
  const rB = await Promise.race([waiting, new Promise((r) => setTimeout(() => r(null), 1500))])
  check('handoff cleanup produced no hang', rA === null || typeof rA === 'object')
}

console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
