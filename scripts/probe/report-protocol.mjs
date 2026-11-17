/**
 * P0 的 L1 报告协议实验：最终回复中的 ordin-report 代码块。
 * 这里是探针实现，不是产品驱动；通过实测后再迁入 src/drivers。
 */
const STATES = new Set(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])

export function parseReport(text) {
  const blocks = [...String(text).matchAll(/```ordin-report[ \t]*\n([\s\S]*?)\n?```/g)]
  if (blocks.length !== 1) return { ok: false, error: `expected exactly one ordin-report block, got ${blocks.length}` }
  let value
  try { value = JSON.parse(blocks[0][1]) } catch (error) { return { ok: false, error: `invalid JSON: ${error.message}` } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'report must be an object' }
  if (!STATES.has(value.state)) return { ok: false, error: `invalid state: ${String(value.state)}` }
  if (typeof value.summary !== 'string' || value.summary.trim() === '') return { ok: false, error: 'summary must be non-empty' }
  if (['waiting', 'blocked', 'failed'].includes(value.state) && (typeof value.question !== 'string' || value.question.trim() === '')) {
    return { ok: false, error: `${value.state} requires a non-empty question` }
  }
  if (value.files !== undefined && (!Array.isArray(value.files) || value.files.some(f => typeof f !== 'string' || f.trim() === ''))) {
    return { ok: false, error: 'files must be an array of non-empty strings' }
  }
  return { ok: true, report: value }
}

export const REPORT_PROMPT = `任务结束后，在正常结论之后附加且只附加一个 ordin-report 代码块：
\`\`\`ordin-report
{"state":"ready","summary":"一句话说明结果","files":[]}
\`\`\`
state 只能是 progress/waiting/ready/blocked/failed/dropped。
waiting/blocked/failed 必须额外给 question 字段，向人提出一个可回答的问题。
除该代码块外不要输出第二个 ordin-report 代码块。`

function selfTest() {
  const good = `已完成。\n\`\`\`ordin-report\n{"state":"ready","summary":"完成","files":[]}\n\`\`\``
  const badState = good.replace('ready', 'done')
  const noQuestion = good.replace('ready', 'waiting')
  const cases = [
    ['valid ready', parseReport(good).ok === true],
    ['invalid state', parseReport(badState).ok === false],
    ['waiting needs question', parseReport(noQuestion).ok === false],
    ['missing block', parseReport('没有报告').ok === false],
    ['duplicate block', parseReport(good + '\n' + good).ok === false],
  ]
  const failed = cases.filter(([, ok]) => !ok)
  console.log(JSON.stringify(cases.map(([name, ok]) => ({ name, ok })), null, 2))
  if (failed.length) process.exitCode = 1
}

if (process.argv.includes('--self-test')) selfTest()
