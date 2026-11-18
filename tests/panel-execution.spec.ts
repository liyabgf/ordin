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
    expect(broken.nodes['execution-check-result'].textContent).toContain('连接检查未取得结果：<network error>')
    expect(broken.nodes['execution-check'].disabled).toBe(false)
  })
})

function connectionsFixture(withControls = true) {
  function chunk(start: string, end: string) {
    const s = html.indexOf(start), e = html.indexOf(end, s)
    expect(s, start).toBeGreaterThan(0)
    expect(e, end).toBeGreaterThan(s)
    return html.slice(s, e)
  }
  const ui = chunk('        <div class="set-sec" id="sec-execution-connections">', '        <div class="set-sec" id="sec-inbox">')
  function node() {
    const listeners = new Map<string, () => unknown>()
    return {
      value: '', type: '', textContent: '', placeholder: '', disabled: false, checked: false,
      classList: { toggle: vi.fn() },
      addEventListener: (event: string, listener: () => unknown) => listeners.set(event, listener),
      fire: (event: string) => listeners.get(event)!(),
    }
  }
  const controls = Object.fromEntries([...ui.matchAll(/<[^>]+ id="execution-connection-([\w-]+)"[^>]*>/g)].map(([tag, id]) => {
    const el = node()
    el.type = /type="([^"]+)"/.exec(tag)?.[1] ?? ''
    return [id!, el] as const
  }))
  controls.backend!.value = /<option value="([^"]+)">/.exec(ui)![1]!
  const nodes: Record<string, ReturnType<typeof node>> = {
    'sq-backend': node(), settings: node(), 'settings-revision': node(), 'settings-error': node(),
  }
  if (withControls) for (const [id, el] of Object.entries(controls)) nodes['execution-connection-' + id] = el
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
  const executor = { backend: 'claude', access: 'edit', model: 'keep-me' }
  const load = runInNewContext([
    chunk('  const HEADER =', '  // Reconcile in place:'),
    chunk('  const api = async', '  /**\n   * 把一段文本'),
    chunk('  // Connection credentials', '  const loadPrompts = async'),
    'loadSettings',
  ].join('\n'), {
    document: { getElementById: (id: string) => nodes[id] ?? null }, URL, fetch, savedSettingsJson: '',
    state: { settings: { executor } }, markDirty: vi.fn(),
    renderSections: () => { nodes['sq-backend']!.value = executor.backend },
  })
  return {
    fetch, load, nodes, ui, controls, executor,
    select: (key: string) => { controls.backend!.value = key; controls.backend!.fire('change') },
    save: () => controls.save!.fire('click'),
    settle: () => new Promise(resolve => setImmediate(resolve)),
  }
}

const blankSummary = { dsh: { configured: false }, codex: { configured: false }, claude: { configured: false } }
const apiPath = '/ordin/api/execution/connections'
const token = 'mock-private-token-579'
const link = 'http://127.0.0.1:3080/?token=' + token
const json = (body: unknown, status = 200) => Response.json(body, { status })

describe('execution connections: actual settings JS', () => {
  it('loads summaries and saves DSH only after consent, without changing default settings', async () => {
    const f = connectionsFixture()
    const { value, result, summary, 'dsh-allow': allow } = f.controls
    f.fetch.mockResolvedValueOnce(json(blankSummary))
    f.load()
    await f.settle()
    expect(f.fetch).toHaveBeenCalledExactlyOnceWith(apiPath, expect.objectContaining({ headers: expect.objectContaining({ 'x-ordin-request': '1' }) }))
    expect(summary!.textContent).toBe('尚未配置连接')
    expect(value!.type).toBe('password')
    expect(allow!.type).toBe('checkbox')
    expect(f.ui).toContain('Ordin 无法限制为只读或仅任务目录')
    value!.value = link.replace('127.0.0.1', 'example.invalid')
    await f.save()
    expect(result!.textContent).toContain('?token=')
    value!.value = link
    await f.save()
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(result!.textContent).toContain('请先确认')
    allow!.checked = true
    f.fetch.mockResolvedValueOnce(json({ ...blankSummary, dsh: { configured: true, address: 'http://127.0.0.1:3080' } }))
    await f.save()
    expect(f.fetch).toHaveBeenNthCalledWith(2, apiPath + '/dsh', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ value: link, allowDshPermissions: true }),
    }))
    expect(value!.value).toBe('')
    expect(allow!.checked).toBe(false)
    expect(summary!.textContent).toBe('已配置连接 · http://127.0.0.1:3080')
    expect(result!.textContent).toContain('已保存')
    expect(f.nodes['sq-backend']!.value).toBe('claude')
    expect(JSON.parse(f.nodes.settings!.value)).toEqual({ executor: f.executor })
  })

  it('does not echo credentials from a malformed summary or a failed save', async () => {
    const f = connectionsFixture()
    const { value, result, summary, save, 'dsh-allow': allow } = f.controls
    f.fetch.mockResolvedValueOnce(json({ ...blankSummary, dsh: { configured: true, address: link } }))
    f.load()
    await f.settle()
    expect(summary!.textContent).toBe('已配置连接')
    value!.value = link
    allow!.checked = true
    f.fetch.mockResolvedValueOnce(json({ error: 'Rejected ' + link }, 400))
    await f.save()
    expect(result!.textContent).toContain('连接保存结果未知')
    expect(value!.value).toBe(link)
    expect(f.fetch).toHaveBeenCalledTimes(2)
    expect(result!.textContent).not.toContain(token)
    expect(f.nodes.settings!.value).not.toContain(token)
    expect(value!.type).toBe('password')
    expect(save!.disabled).toBe(false)
    f.select('codex')
    expect(value!.value).toBe('')
    expect(value!.type).toBe('text')
    expect(allow!.checked).toBe(false)
    expect(f.controls['dsh-permissions']!.classList.toggle).toHaveBeenLastCalledWith('hidden', true)
  })

  it('saves CLI auto-detect or an absolute path, never requiring DSH consent', async () => {
    const f = connectionsFixture()
    const { value, help, result, summary } = f.controls
    f.select('codex')
    expect(help!.textContent).toContain('自动检测 codex')
    value!.value = 'codex --help'
    await f.save()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(result!.textContent).toContain('可执行文件的绝对路径')
    value!.value = ''
    const codexSummary = { ...blankSummary, codex: { configured: true, binary: 'codex' } }
    f.fetch.mockResolvedValueOnce(json(codexSummary))
    await f.save()
    expect(f.fetch).toHaveBeenNthCalledWith(1, apiPath + '/codex', expect.objectContaining({ method: 'PUT', body: '{"value":""}' }))
    expect(summary!.textContent).toBe('已配置连接 · codex')
    f.select('claude')
    value!.value = '/opt/CLI Tools/claude'
    f.fetch.mockResolvedValueOnce(json({ ...codexSummary, claude: { configured: true, binary: value!.value } }))
    await f.save()
    expect(f.fetch).toHaveBeenNthCalledWith(2, apiPath + '/claude', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: value!.value }) }))
    expect(summary!.textContent).toBe('已配置连接 · /opt/CLI Tools/claude')
  })

  it('explains an outdated Ordin process, blocks save, and recovers after reconnecting', async () => {
    const f = connectionsFixture()
    const { value, result, summary, save } = f.controls
    f.fetch.mockResolvedValueOnce(json({ error: 'No route for GET /ordin/api/execution/connections' }, 404))
    f.load()
    await f.settle()
    expect(summary!.textContent).toContain('Ctrl+C')
    expect(save!.disabled).toBe(true)
    value!.value = link
    await f.save()
    expect(f.fetch).toHaveBeenCalledTimes(1)
    f.fetch.mockResolvedValueOnce(json(blankSummary))
    f.load()
    await f.settle()
    expect(save!.disabled).toBe(false)
    value!.value = 'http://127.0.0.1:3080/'
    await f.save()
    expect(result!.textContent).toContain('你粘贴的是 DSH 首页地址')
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('refreshes and switches current connection versions without changing drafts or resaving', async () => {
    const f = connectionsFixture()
    const { version, refresh, value } = f.controls
    const savedId = '1c6a44a9-82f1-4e6b-b15e-6d766e27da53'
    const updatedId = '94a71d8b-ade2-447b-b587-3880d8db13a7'
    const dsh = { configured: true, address: 'http://127.0.0.1:3080', connectionId: savedId }
    f.fetch.mockResolvedValueOnce(json({ ...blankSummary, dsh, codex: { configured: true, binary: 'codex' }, claude: { configured: true, connectionId: link } }))
    f.load()
    await f.settle()
    expect(version!.textContent).toBe('当前连接版本：' + savedId)
    f.select('codex')
    expect(version!.textContent).toBe('当前连接版本：未知')
    f.select('claude')
    expect(version!.textContent).toBe('当前连接版本：未知')
    f.select('dsh')
    value!.value = link
    f.fetch.mockResolvedValueOnce(json({ ...blankSummary, dsh: { ...dsh, connectionId: updatedId } }))
    await refresh!.fire('click')
    expect(version!.textContent).toBe('当前连接版本：' + updatedId)
    expect(value!.value).toBe(link)
    expect(f.fetch.mock.calls.map(([url, init]) => [url, init.method ?? 'GET'])).toEqual([[apiPath, 'GET'], [apiPath, 'GET']])
  })

  it('does not request connections when older fixtures omit the controls', async () => {
    const f = connectionsFixture(false)
    f.load()
    await f.settle()
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
