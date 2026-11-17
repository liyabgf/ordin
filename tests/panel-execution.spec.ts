import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
function fixture(post = vi.fn(async () => ({ backend:'codex', ok:true }))) {
  const start = html.indexOf('  const checkExecutionTool = async () => {')
  const end = html.indexOf('  const loadSettings = () => {', start)
  expect(start).toBeGreaterThan(0)
  const nodes: Record<string, any> = { settings:{value:'saved'}, 'execution-check':{disabled:false,addEventListener:vi.fn()}, 'execution-check-result':{textContent:''} }
  const context = { $:(id:string) => nodes[id], savedSettingsJson:'saved', post }
  const handler = runInNewContext(html.slice(start,end) + '\ncheckExecutionTool', context)
  return {handler,nodes,post}
}
describe('execution panel', () => {
  it('collects backend/access selections into settings without dropping executor fields', () => {
    const start = html.indexOf('    const w = Number(')
    const end = html.indexOf('    const inbox = {', start)
    const nodes: Record<string, any> = {
      'sq-workers': {value:'2'}, 'sq-backend': {value:'claude'}, 'sq-access': {value:'read'},
      'sq-model': {value:'model-a'}, 'sq-prepare': {value:''},
    }
    const doc = {executor:{sandbox:'local',backend:'dsh',access:'edit'}}
    runInNewContext(html.slice(start,end), {doc,$:(id:string)=>nodes[id]})
    expect(doc.executor).toMatchObject({backend:'claude',access:'read',sandbox:'local',maxWorkers:2})
  })

  it('checks saved settings and restores the disabled button', async () => {
    const f=fixture()
    await f.handler()
    expect(f.post).toHaveBeenCalledWith('execution/check')
    expect(f.nodes['execution-check-result'].textContent).toContain('codex 检查通过')
    expect(f.nodes['execution-check'].disabled).toBe(false)
  })
  it('does not check an unsaved selection', async () => {
    const f=fixture();f.nodes.settings.value='unsaved'
    await f.handler()
    expect(f.post).not.toHaveBeenCalled()
    expect(f.nodes['execution-check-result'].textContent).toContain('先保存')
  })
  it('shows unavailable and network errors as text', async () => {
    const unavailable=fixture(vi.fn(async()=>({backend:'codex',ok:false,problems:['not logged in']})) as any)
    await unavailable.handler()
    expect(unavailable.nodes['execution-check-result'].textContent).toContain('not logged in')
    const broken=fixture(vi.fn(async()=>{throw new Error('<network error>')}) as any)
    await broken.handler()
    expect(broken.nodes['execution-check-result'].textContent).toBe('检查失败：<network error>')
    expect(broken.nodes['execution-check'].disabled).toBe(false)
  })
})
