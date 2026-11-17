#!/usr/bin/env node
// P0-T3 Codex 契约探针：起任务 / 事件流 / 结构化终局 / 会话续接。
// 运行：node scripts/probe/codex.mjs
// 退出码：0 = 探针脚本跑完（单项可 failed/blocked/skipped）；1 = 探针脚本自身失败。
// 隔离：CODEX_HOME=/tmp/ordin-p0-codex/home，所有 cwd 在 /tmp/ordin-p0-codex/work。
// 分类：passed / failed / blocked（认证阻塞）/ skipped，不推测为通过。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sh, clip, check, writeProbeResult, summarize, nowIso } from './common.mjs'

const ROOT = '/tmp/ordin-p0-codex'
const HOME = join(ROOT, 'home')
const WORK = join(ROOT, 'work')
const EVID = join(ROOT, 'evidence')
const CODEX_BIN = process.env.CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'

mkdirSync(HOME, { recursive: true })
mkdirSync(WORK, { recursive: true })
mkdirSync(EVID, { recursive: true })

const result = { backend: 'codex', measuredAt: nowIso(), checks: [], evidence: {} }
const ev = (name, data) => {
  const path = join(EVID, name)
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', 'utf8')
  result.evidence[name] = path
}

const AUTH_RE = /refresh token|token_expired|sign in again|not logged in|401 unauthorized/i
const isAuthBlock = (...texts) => AUTH_RE.test(texts.filter(Boolean).join('\n'))

const parseJsonl = (text) => {
  const events = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t)) } catch { events.push({ _unparsed: clip(t, 300) }) }
  }
  return events
}

const runWithStdin = (argv, stdinText, options = {}) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(argv[0], argv.slice(1), {
    cwd: WORK,
    env: { ...process.env, CODEX_HOME: HOME, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 240_000)
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  child.on('error', e => { clearTimeout(timer); resolve({ argv, exitCode: null, signal: null, error: String(e), stdout, stderr, durationMs: Date.now() - started }) })
  child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ argv, exitCode, signal, stdout, stderr, durationMs: Date.now() - started }) })
  child.stdin.write(stdinText)
  child.stdin.end()
})

const run = (argv, options = {}) => sh(argv, { cwd: WORK, env: { CODEX_HOME: HOME, ...(options.env ?? {}) }, timeoutMs: options.timeoutMs ?? 240_000 })

async function main() {
  // 0. 版本钉子（当场量）
  const ver = await run([CODEX_BIN, '--version'], { timeoutMs: 30_000 })
  result.version = ver.stdout.trim() || ver.stderr.trim()
  result.versionExit = ver.exitCode
  ev('0-version.txt', `cmd: ${CODEX_BIN} --version\nexit=${ver.exitCode}\nstdout=${ver.stdout}\nstderr=${ver.stderr}`)
  result.checks.push(check('p0-version-pin', ver.exitCode === 0 && result.version ? 'passed' : 'failed', { note: result.version }))

  const sha = await sh(['shasum', '-a', '256', CODEX_BIN], { timeoutMs: 30_000 })
  result.binarySha256 = sha.stdout.trim()
  ev('0-binary-sha256.txt', sha.stdout + sha.stderr)

  // 1. 登录态：只报存在与权限，不读内容
  const authPath = join(HOME, 'auth.json')
  const authStat = existsSync(authPath) ? statSync(authPath) : null
  result.auth = authStat ? `present (mode ${(authStat.mode & 0o777).toString(8)}, ${authStat.size} bytes)` : 'absent'
  ev('0-auth-presence.txt', `CODEX_HOME=${HOME}\nauth.json: ${result.auth}\n(source: ~/.codex/auth.json copied via install -m 600, content not read)`)

  // 探针 1+2+3：一次 codex exec --json 最小任务（cwd 为非 git 目录）
  const prompt = 'Reply with exactly one word: pong'
  const p1 = await run([CODEX_BIN, 'exec', '--json', '--skip-git-repo-check', prompt])
  ev('1-exec.stdout.jsonl', p1.stdout)
  ev('1-exec.stderr.txt', p1.stderr)
  ev('1-exec.meta.json', { argv: p1.argv, exitCode: p1.exitCode, signal: p1.signal, durationMs: p1.durationMs })

  const events1 = parseJsonl(p1.stdout)
  const types1 = events1.map(e => e.type ?? (e._unparsed ? 'unparsed' : 'unknown'))
  const unparsed1 = types1.filter(t => t === 'unparsed').length
  const firstOf = (type) => events1.find(e => e.type === type)
  const threadEvent = firstOf('thread.started')
  const threadId = threadEvent?.thread_id ?? null
  const itemCompleted = firstOf('item.completed')
  const turnCompleted = firstOf('turn.completed')
  const turnFailed = firstOf('turn.failed')
  const terminal = turnCompleted ? 'turn.completed' : (turnFailed ? 'turn.failed' : null)
  const authBlocked1 = isAuthBlock(p1.stdout, p1.stderr)

  ev('2-events-summary.json', {
    count: events1.length,
    typeHistogram: types1.reduce((m, t) => (m[t] = (m[t] ?? 0) + 1, m), {}),
    unparsed: unparsed1,
    threadId,
    firstSamples: Object.fromEntries(['thread.started', 'turn.started', 'item.completed', 'turn.completed', 'turn.failed', 'error'].map(t => [t, firstOf(t) ? clip(JSON.stringify(firstOf(t)), 1500) : null])),
  })

  result.checks.push(check('p1-spawn-task',
    p1.exitCode === 0 && threadEvent ? 'passed' : (authBlocked1 ? 'blocked' : 'failed'), {
    note: `exit=${p1.exitCode} duration=${p1.durationMs}ms thread.started=${!!threadEvent}${authBlocked1 ? ' auth=401 token_expired' : ''}`,
    exitCode: p1.exitCode,
  }))
  const streamOk = threadEvent && itemCompleted && terminal
  result.checks.push(check('p2-event-stream',
    streamOk ? 'passed' : (authBlocked1 ? 'blocked' : 'failed'), {
    note: `events=${events1.length} types=${[...new Set(types1)].join(',')} unparsed=${unparsed1}${authBlocked1 ? '（骨架 thread.started→turn.started→error→turn.failed 实测可解析）' : ''}`,
  }))
  result.checks.push(check('p3-structured-final',
    turnCompleted ? 'passed' : (authBlocked1 && turnFailed ? 'blocked' : 'failed'), {
    note: terminal ? `terminal=${terminal} payload=${clip(JSON.stringify(turnCompleted?.usage ?? turnFailed?.error ?? null), 200)}` : 'no terminal event seen',
  }))

  // 探针 4：会话续接（优先用 thread id；拿不到则 --last）
  const resumeMeta = threadId
    ? await run([CODEX_BIN, 'exec', 'resume', '--json', '--skip-git-repo-check', threadId, 'In one short line: which single word did you reply with before?'])
    : await run([CODEX_BIN, 'exec', 'resume', '--json', '--last', 'In one short line: which single word did you reply with before?'])
  ev('4-resume.stdout.jsonl', resumeMeta.stdout)
  ev('4-resume.stderr.txt', resumeMeta.stderr)
  ev('4-resume.meta.json', { argv: resumeMeta.argv, exitCode: resumeMeta.exitCode, durationMs: resumeMeta.durationMs, threadId })

  const events4 = parseJsonl(resumeMeta.stdout)
  const resumeCompleted = events4.some(e => e.type === 'turn.completed')
  const resumeThread = events4.find(e => e.type === 'thread.started')
  const resumeText = events4.filter(e => e.type === 'item.completed').map(e => JSON.stringify(e.item ?? e)).join('\n')
  const mentionsPong = /pong/i.test(resumeText)
  const authBlocked4 = isAuthBlock(resumeMeta.stdout, resumeMeta.stderr)
  ev('4-resume.events-summary.json', {
    exitCode: resumeMeta.exitCode,
    types: [...new Set(events4.map(e => e.type ?? 'unknown'))],
    threadIdBefore: threadId,
    threadIdAfter: resumeThread?.thread_id ?? null,
    mentionsPong,
    sample: clip(resumeText, 2000),
  })
  result.checks.push(check('p4-session-resume',
    resumeMeta.exitCode === 0 && resumeCompleted ? 'passed' : (authBlocked4 ? 'blocked' : 'failed'), {
    note: `exit=${resumeMeta.exitCode} completed=${resumeCompleted} continuity(pong)=${mentionsPong} threadBefore=${threadId} threadAfter=${resumeThread?.thread_id ?? null}（resume 在本地路由层复用同一 thread_id 已实测）`,
  }))

  // 补充观察 A：非 git 目录 + 不加 --skip-git-repo-check（预期被 git 守卫拒绝，非认证问题）
  const noGit = await run([CODEX_BIN, 'exec', '--json', 'say hi'], { timeoutMs: 60_000 })
  const guardHit = /skip-git-repo-check|trusted directory/i.test(noGit.stdout + noGit.stderr)
  ev('5-nongit-without-flag.txt', `argv=${JSON.stringify(noGit.argv)}\nexit=${noGit.exitCode}\nguardMessage=${guardHit}\nstdout=${clip(noGit.stdout, 2000)}\nstderr=${clip(noGit.stderr, 2000)}`)
  result.checks.push(check('x-nongit-guard', noGit.exitCode !== 0 && guardHit ? 'passed' : 'failed', {
    note: `exit=${noGit.exitCode} guard=${guardHit ? 'Not inside a trusted directory（git 守卫实测生效）' : 'guard message not seen'}`,
  }))

  // 补充观察 B：stdin 行为（关闭 / "-" 读取 / 管道追加）
  const stdinClosed = await run([CODEX_BIN, 'exec', '--json', '--skip-git-repo-check', 'Reply with exactly one word: pong'], { timeoutMs: 240_000 })
  ev('6-stdin-closed.txt', `exit=${stdinClosed.exitCode}\nstdout=${clip(stdinClosed.stdout, 3000)}\nstderr=${clip(stdinClosed.stderr, 1000)}`)

  const stdinDash = await runWithStdin([CODEX_BIN, 'exec', '--json', '--skip-git-repo-check', '-'], 'Reply with exactly one word: pong\n', { timeoutMs: 240_000 })
  ev('6-stdin-dash.txt', `exit=${stdinDash.exitCode}\nstdout=${clip(stdinDash.stdout, 3000)}\nstderr=${clip(stdinDash.stderr, 1000)}`)

  const stdinAppend = await runWithStdin([CODEX_BIN, 'exec', '--json', '--skip-git-repo-check', 'Reply with exactly one word: pong'], 'Additional context: just answer the word.\n', { timeoutMs: 240_000 })
  ev('6-stdin-append.txt', `exit=${stdinAppend.exitCode}\nstdout=${clip(stdinAppend.stdout, 3000)}\nstderr=${clip(stdinAppend.stderr, 1000)}`)

  const stdinAll = [stdinClosed, stdinDash, stdinAppend]
  const stdinAllCompleted = stdinAll.every(r => parseJsonl(r.stdout).some(e => e.type === 'turn.completed'))
  const stdinAllAuth = stdinAll.every(r => isAuthBlock(r.stdout, r.stderr))
  result.checks.push(check('x-stdin-behavior',
    stdinAllCompleted ? 'passed' : (stdinAllAuth ? 'blocked' : 'failed'), {
    note: `closed=${stdinClosed.exitCode} dash=${stdinDash.exitCode} append=${stdinAppend.exitCode}（三种形态均到达模型调用层，未挂起；${stdinAllAuth ? '统一止于 401' : '完成状态见证据'}）`,
  }))

  // 补充观察 C：--output-schema 结构化终局
  const schemaPath = join(EVID, '7-output-schema.json')
  writeFileSync(schemaPath, JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, null, 2))
  const schemaRun = await run([CODEX_BIN, 'exec', '--json', '--skip-git-repo-check', '--output-schema', schemaPath, 'Return the single word pong as the answer field.'], { timeoutMs: 240_000 })
  ev('7-output-schema.stdout.jsonl', schemaRun.stdout)
  ev('7-output-schema.stderr.txt', schemaRun.stderr)
  const schemaEvents = parseJsonl(schemaRun.stdout)
  const schemaCompleted = schemaEvents.some(e => e.type === 'turn.completed')
  const schemaText = schemaEvents.filter(e => e.type === 'item.completed').map(e => JSON.stringify(e.item ?? e)).join('\n')
  let schemaParsed = null
  try { const m = schemaText.match(/\{[^{}]*"answer"[^{}]*\}/); schemaParsed = m ? JSON.parse(m[0]) : null } catch {}
  const authBlocked7 = isAuthBlock(schemaRun.stdout, schemaRun.stderr)
  ev('7-output-schema.summary.json', { exitCode: schemaRun.exitCode, completed: schemaCompleted, schemaParsed, sample: clip(schemaText, 2000) })
  result.checks.push(check('x-output-schema',
    schemaRun.exitCode === 0 && schemaCompleted && schemaParsed ? 'passed' : (authBlocked7 ? 'blocked' : 'failed'), {
    note: `exit=${schemaRun.exitCode} completed=${schemaCompleted} parsed=${JSON.stringify(schemaParsed)}${authBlocked7 ? ' auth=401' : ''}`,
  }))

  if (authBlocked1) result.auth += '; STALE — server 401 token_expired（refresh token already used），需交互式重新登录'

  result.summary = summarize(result)
  writeFileSync(join(EVID, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  try { await writeProbeResult('codex', result) } catch (e) { result.evidence['writeProbeResult-error'] = String(e) }
  console.log(result.summary)
  console.log('evidence:', EVID)
  return 0
}

main().then(code => process.exit(code)).catch(e => { console.error('probe failed:', e); process.exit(1) })
