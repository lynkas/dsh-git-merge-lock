// 离线语义验证:git-merge-lock v2 内核(方案1)
import { apply } from '/Users/cat/dsh-git-merge-lock/plugin/index.mjs'
import { __internals } from '/Users/cat/dsh-git-merge-lock/plugin/index.mjs'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 全局保活:插件计时器全部 unref(生产语义正确);裸脚本需要自持事件循环
// (注意:此 interval 绝不能 unref——它就是循环的持有者;结束靠底部 process.exit)
const WATCHDOG = setInterval(() => {}, 3_600_000)
let pass = 0, fail = 0
const check = (name, cond) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ FAIL ${name}`)) }

// ---- 假 ctx:捕获工具注册;subprocess 按固定 repo 应答 ----
const registered = []
const REPO = { top: '/tmp/gml-fake-repo', commondir: mkdtempSync(path.join(tmpdir(), 'gml-commondir-')), branch: 'main' }
const gitPlan = [
  [['rev-parse', '--path-format=absolute', '--show-toplevel'], REPO.top],
  [['rev-parse', '--path-format=absolute', '--git-common-dir'], REPO.commondir],
  [['symbolic-ref', '--quiet', '--short', 'HEAD'], REPO.branch],
]
const fakeCtx = {
  tools: { register: (t) => registered.push(t) },
  subprocess: {
    spawn({ argv }) {
      const sub = argv.slice(argv.indexOf('git') + 3) // skip git -C <cwd>
      const hit = gitPlan.find(([key]) => key.every((k, i) => sub[i] === k))
      const text = hit ? hit[1] : ''
      return {
        done: Promise.resolve({ exitCode: text ? 0 : 1 }),
        collected: { stdout: { readFrom: () => ({ text }) } },
      }
    },
  },
}
apply(fakeCtx)
const tool = registered[0]
check('tool registered as git_merge_lock', tool?.name === 'git_merge_lock')

function exec(sessionId) {
  const ac = new AbortController()
  return {
    signal: ac.signal,
    abort: () => ac.abort(),
    agent: { session: { header: { id: sessionId, cwd: REPO.top } } },
  }
}
const run = (args, e) => tool.execute(args, e).then((r) => r.text)

// ---- S1 FIFO 公平性 ----
{
  console.log('S1 FIFO fairness')
  const A = exec('sess-A'), B = exec('sess-B'), C = exec('sess-C')
  const rA = await run({ action: 'acquire', why: 'a' }, A)
  check('A granted immediately as first caller', rA.includes('ACQUIRED'))
  const pB = run({ action: 'acquire', why: 'b' }, B)
  await sleep(30)
  const pC = run({ action: 'acquire', why: 'c' }, C)
  await sleep(30)
  const st = await run({ action: 'status' }, A)
  check('waiters listed in order [B, C]', /waiters\(2\):[\s\S]*?sess-B[\s\S]*?sess-C/.test(st))
  const rel = await run({ action: 'release' }, A)
  check('release reports 2 waiters', rel.includes('2 session(s) were waiting'))
  const rB = await pB
  check('B granted next (FIFO head), sees wakeup delta', rB.includes('ACQUIRED') && rB.includes('these events happened'))
  await run({ action: 'release' }, B)
  const rC = await pC
  check('C granted after B', rC.includes('ACQUIRED'))
  await run({ action: 'release' }, C)
}

// ---- S2 等待中被 abort → 出队作废 ----
{
  console.log('S2 abort while waiting')
  const A = exec('s2-A'), D = exec('s2-D')
  await run({ action: 'acquire' }, A)
  const pD = run({ action: 'acquire', timeout_s: 60 }, D)
  await sleep(50)
  D.abort()
  const rD = await pD
  check('D aborted cleanly', rD.includes('cancelled'))
  const st = await run({ action: 'status' }, A)
  check('queue empty after abort', st.includes('waiters(0)'))
  await run({ action: 'release' }, A)
}

// ---- S3 持有中 abort → keeper 自动释放(≤6s),等待者接管 ----
{
  console.log('S3 auto-release on interrupted holder')
  const A = exec('s3-A'), E = exec('s3-E')
  await run({ action: 'acquire' }, A)
  const pE = run({ action: 'acquire', timeout_s: 60 }, E)
  await sleep(50)
  // 保活:keeper/deadline 均为 unref 计时器,裸脚本若无其他 loop 持有者会被 node 排空
  const keepAlive = setTimeout(() => {}, 10_000)
  A.abort() // 模拟会话被打断/死亡
  const t0 = Date.now()
  const rE = await pE
  clearTimeout(keepAlive)
  const dt = Date.now() - t0
  check(`E auto-granted after ${dt}ms (<8s)`, rE.includes('ACQUIRED') && dt < 8000)
  const st = await run({ action: 'status' }, E)
  check('journal shows auto_released', st.includes('auto_released'))
  await run({ action: 'release' }, E)
}

// ---- S4 幂等 acquire + 越权 release 拒绝 ----
{
  console.log('S4 idempotency & ownership')
  const A = exec('s4-A'), B = exec('s4-B')
  await run({ action: 'acquire' }, A)
  const again = await run({ action: 'acquire' }, A)
  check('same session re-acquire is idempotent hint', again.includes('already hold'))
  const foreign = await run({ action: 'release' }, B)
  check("foreign release refused", foreign.includes('held by s4-A'))
  await run({ action: 'release' }, A)
}

// ---- S5 超时返回 busy ----
{
  console.log('S5 timeout -> busy')
  const A = exec('s5-A'), F = exec('s5-F')
  await run({ action: 'acquire', why: 'long merge' }, A)
  const rF = await run({ action: 'acquire', timeout_s: 5 }, F)
  check('busy payload names holder & options', rF.includes('TIMEOUT') && rF.includes('s5-A') && rF.includes('force_release'))
  await run({ action: 'release' }, A)
}

// ---- S6 notify 信箱 ----
{
  console.log('S6 notify mailbox')
  const A = exec('s6-A'), G = exec('s6-G')
  const none = await run({ action: 'notify', reason: 'hi' }, G)
  check('notify without holder says so', none.includes('nobody holds'))
  await run({ action: 'acquire' }, A)
  const sent = await run({ action: 'notify', reason: 'please release soon' }, G)
  check('notify delivered note', sent.includes('message delivered'))
  const got = await run({ action: 'acquire' }, A)
  check('holder receives mail on next call', got.includes('please release soon'))
  await run({ action: 'release' }, A)
}

// ---- S7 force_release(需 confirm)+ 立即移交 ----
{
  console.log('S7 force_release')
  const A = exec('s7-A'), H = exec('s7-H'), X = exec('s7-X')
  await run({ action: 'acquire' }, A)
  const pH = run({ action: 'acquire', timeout_s: 30 }, H)
  await sleep(40)
  const noConfirm = await run({ action: 'force_release' }, X)
  check('refuses without confirm=true', noConfirm.includes('confirm=true'))
  const done = await run({ action: 'force_release', confirm: true, reason: 'human asked' }, X)
  check('steals and journals', done.includes('taken from s7-A'))
  const rH = await pH
  check('next waiter got the lease', rH.includes('ACQUIRED'))
  await run({ action: 'release' }, H)
}

// ---- S8 整仓单线程:enabled 开关即一切(分支概念已移除) ----
{
  console.log('S8 repo-wide semantics (no branch filter)')
  check('needsLock removed from internals', __internals.needsLock === undefined)
}

// ---- S9 双仓库隔离 ----
{
  console.log('S9 repo isolation')
  const r1 = __internals.getRepo('/tmp/repoOne/.git', path.join(__internals.repos.size + '', 'j1.jsonl'))
  const r2 = __internals.getRepo('/tmp/repoTwo/.git', path.join(__internals.repos.size + '', 'j2.jsonl'))
  check('distinct repo records', r1 !== r2 && __internals.repos.size >= 2)
}

console.log(`\n== ${pass} passed, ${fail} failed ==`)
process.exit(fail ? 1 : 0)
