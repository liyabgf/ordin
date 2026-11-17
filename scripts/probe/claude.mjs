#!/usr/bin/env node
// P0-T4 · Claude Code 四探针实测（起任务 / 事件流 / 结构化终局 / 会话续接）
// 纪律：退出码从命令本身取；结论只用 passed/failed/blocked/skipped；不打印任何凭据。
// 隔离：CLAUDE_CONFIG_DIR 与 HOME 均在 /tmp/ordin-p0-claude/，局部 npm 安装，不碰全局与现役宿主。
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sh, clip, check, writeProbeResult, summarize, nowIso } from './common.mjs'

const ROOT = '/tmp/ordin-p0-claude'
const LOGS = join(ROOT, 'logs')
// common.mjs 的 sh 默认 cwd=/tmp/ordin-p0（可能不存在 → spawn ENOENT，已实测）；统一显式用隔离 ROOT。
const CWD = ROOT
const BIN = join(ROOT, 'npm', 'node_modules', '.bin', 'claude')
const ENV = { CLAUDE_CONFIG_DIR: join(ROOT, 'config'), HOME: join(ROOT, 'home') }
const TIMEOUT = 180_000
const PROMPT = 'Reply with exactly: OK'

mkdirSync(LOGS, { recursive: true })
const SH = (argv, opt = {}) => sh(argv, { cwd: CWD, ...opt })
const result = { backend: 'claude', startedAt: nowIso(), version: null, auth: 'unknown', checks: [], evidence: {} }

function saveLog(name, r) {
  const p = join(LOGS, name)
  writeFileSync(p, ['# argv: ' + JSON.stringify(r.argv), '# exitCode: ' + r.exitCode + ' signal: ' + r.signal + ' timedOut: ' + r.timedOut + ' durationMs: ' + r.durationMs,
    r.error ? '# spawnError: ' + r.error : '', '--- stdout ---', r.stdout, '--- stderr ---', r.stderr].join('\n'), 'utf8')
  return p
}

const AUTH_RE = /(invalid api key|not logged in|please run \/login|please login|authentication_error|unauthorized|\b401\b|oauth token|api key.*(missing|required)|credit balance)/i
function classify(r, ok) {
  if (ok(r)) return 'passed'
  if (AUTH_RE.test(r.stdout + '\n' + r.stderr)) return 'blocked'
  return 'failed'
}

// ---------- 0. 版本钉子 ----------
const v = await SH([BIN, '--version'], { env: ENV, timeoutMs: 60_000 })
saveLog('version.log', v)
result.version = v.exitCode === 0 ? v.stdout.trim() : null
result.checks.push(check('version', v.exitCode === 0 && v.stdout.trim() ? 'passed' : 'failed', {
  command: BIN + ' --version', exitCode: v.exitCode, durationMs: v.durationMs, note: clip(v.stdout.trim() || v.stderr.trim(), 300),
}))

// ---------- 登录态（只看存在性） ----------
const credFile = join(ENV.CLAUDE_CONFIG_DIR, '.credentials.json')
result.auth = existsSync(credFile) || process.env.ANTHROPIC_API_KEY ? 'present' : 'none-found'
result.evidence.authNote = 'checks: isolated config credentials file, inherited ANTHROPIC_API_KEY; no secret content read'

// ---------- 1. 起任务 ----------
const p1 = await SH([BIN, '-p', PROMPT], { env: ENV, timeoutMs: TIMEOUT })
const p1log = saveLog('probe1-start.log', p1)
const s1 = classify(p1, r => r.exitCode === 0 && r.stdout.trim().length > 0)
result.checks.push(check('start', s1, {
  command: BIN + ' -p "' + PROMPT + '"', exitCode: p1.exitCode, signal: p1.signal, timedOut: p1.timedOut,
  durationMs: p1.durationMs, log: p1log, note: clip((p1.stdout + p1.stderr).trim(), 500),
}))

// ---------- 2. 事件流 stream-json ----------
const p2 = await SH([BIN, '-p', PROMPT, '--output-format', 'stream-json', '--verbose'], { env: ENV, timeoutMs: TIMEOUT })
const p2log = saveLog('probe2-stream.log', p2)
writeFileSync(join(LOGS, 'probe2-stream.jsonl'), p2.stdout, 'utf8')
const events = []
for (const line of p2.stdout.split('\n')) {
  if (!line.trim()) continue
  try { events.push(JSON.parse(line)) } catch { /* 宽容解析：不认识的行跳过 */ }
}
const types = events.map(e => e.type + (e.subtype ? '/' + e.subtype : ''))
const initEv = events.find(e => e.type === 'system' && e.subtype === 'init')
const assistantEv = events.find(e => e.type === 'assistant')
const resultEv = events.find(e => e.type === 'result')
const s2 = classify(p2, r => r.exitCode === 0 && !!initEv && !!assistantEv && !!resultEv)
result.sessionId = initEv?.session_id ?? resultEv?.session_id ?? null
result.checks.push(check('stream', s2, {
  command: BIN + ' -p "' + PROMPT + '" --output-format stream-json --verbose', exitCode: p2.exitCode, timedOut: p2.timedOut,
  durationMs: p2.durationMs, log: p2log, eventTypes: types,
  init: !!initEv, assistant: !!assistantEv, result: !!resultEv,
  note: s2 === 'passed' ? 'event types: ' + types.join(',') : clip((p2.stdout + p2.stderr).trim(), 500),
}))
if (events.length) {
  result.evidence.eventSamples = { init: initEv ?? null, result: resultEv ?? null }
}

// ---------- 3. 结构化终局（--output-format json） ----------
const p3 = await SH([BIN, '-p', PROMPT, '--output-format', 'json'], { env: ENV, timeoutMs: TIMEOUT })
const p3log = saveLog('probe3-json.log', p3)
let finalJson = null
try { finalJson = JSON.parse(p3.stdout) } catch { /* 非 JSON 输出则保持 null */ }
const s3 = classify(p3, r => r.exitCode === 0 && finalJson && typeof finalJson === 'object' && 'result' in finalJson && finalJson.is_error === false)
result.checks.push(check('structured-final', s3, {
  command: BIN + ' -p "' + PROMPT + '" --output-format json', exitCode: p3.exitCode, timedOut: p3.timedOut,
  durationMs: p3.durationMs, log: p3log,
  fields: finalJson ? Object.keys(finalJson) : [],
  note: s3 === 'passed' ? 'is_error=false, result 字段存在' : clip((p3.stdout + p3.stderr).trim(), 500),
}))
if (finalJson) result.evidence.structuredFinal = finalJson
if (!result.sessionId && finalJson?.session_id) result.sessionId = finalJson.session_id

// ---------- 4. 会话续接（--resume） ----------
// 有真实 session_id 用真实值；认证阻塞拿不到时用全零 uuid 实测 --resume 的真实报错路径。
const sid = result.sessionId ?? '00000000-0000-0000-0000-000000000000'
const p4 = await SH([BIN, '-p', '--resume', sid, 'What did I ask you to reply with? Answer in one word.', '--output-format', 'stream-json', '--verbose'], { env: ENV, timeoutMs: TIMEOUT })
const p4log = saveLog('probe4-resume.log', p4)
const rEvents = []
for (const line of p4.stdout.split('\n')) {
  if (!line.trim()) continue
  try { rEvents.push(JSON.parse(line)) } catch { /* skip */ }
}
const rResult = rEvents.find(e => e.type === 'result')
const resumedInit = rEvents.find(e => e.type === 'system' && e.subtype === 'init')
const s4 = classify(p4, r => r.exitCode === 0 && !!rResult && rResult.is_error === false)
result.checks.push(check('resume', s4, {
  command: BIN + ' -p --resume ' + sid + ' "What did I ask you to reply with? Answer in one word." --output-format stream-json --verbose',
  usedRealSessionId: !!result.sessionId, exitCode: p4.exitCode, timedOut: p4.timedOut,
  durationMs: p4.durationMs, log: p4log,
  resumedSessionId: resumedInit?.session_id ?? rResult?.session_id ?? null,
  note: s4 === 'passed' ? 'resume result received, is_error=false' : clip((p4.stdout + p4.stderr).trim(), 500),
}))
if (rEvents.length) result.evidence.resumeResult = rResult ?? null

result.finishedAt = nowIso()
const outPath = await writeProbeResult('claude', result)
writeFileSync(join(ROOT, 'results', 'claude.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
console.log(summarize(result))
console.log('resultJson: ' + outPath)
process.exitCode = 0 // 探针脚本自身跑完即 0；单项状态见 JSON
