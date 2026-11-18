// @ts-nocheck
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../panel/workspace.html', import.meta.url), 'utf8')
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
class Element {
  value = ''; textContent = ''; innerHTML = ''; disabled = false; hidden = false; className = ''
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {}; children: Element[] = []
  onclick?: () => any; oninput?: () => any
  setAttribute(key: string, value: string) { this.attrs[key] = value }
  appendChild(child: Element) { this.children.push(child) }
  querySelectorAll() { return [...this.innerHTML.matchAll(/data-file="([^"]+)"/g)].map(m=>{const e=new Element();e.dataset.file=m[1];this.children.push(e);return e}) }
  replaceChildren(...children: Element[]) { this.children = children; this.innerHTML = ''; this.textContent = '' }
}
const waiting = { id: 't-wait', title: 'Plan a launch', stage: 'waiting', waitsForPerson: true, waitingForAnswer: true, question: 'Which audience?', summary: 'Draft is ready', currentNextStep: 'Waiting for your answer', assignments: [], notes: [], inputs: [] }
const failed = { id: 't-fail', title: 'Repair import', stage: 'failed', waitsForPerson: true, preparationFailed: true, summary: 'Import failed', assignments: [], notes: [], inputs: [] }
const completed = { id: 't-done', title: 'Write report', stage: 'done', waitsForPerson: false, ended: { outcome: 'done' }, result: { text: 'A report was produced' }, assignments: [], notes: [], inputs: [] }
const response = (value: any, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => value })
function fixture(search = '?ticket=t-wait') {
  const nodes: Record<string, Element> = {}
  const get = (id: string) => nodes[id] || (nodes[id] = new Element())
  const tabs = ['all', 'open', 'attention', 'ended'].map(value => { const e = new Element(); e.dataset.state = value; return e })
  get('tabs').children = tabs
  const tickets: any[] = [structuredClone(waiting), structuredClone(failed), structuredClone(completed)]
  const events: Record<string, any[]> = {}; const progress: Record<string, any> = {}; const calls: any[] = []
  let listError = false; let postError = false; let deferredList: Promise<any> | null = null; let deferredDetail: Promise<any> | null = null; let deferredPost: Promise<any> | null = null
  const fetch = vi.fn(async (url: string, options: any) => {
    calls.push([url, options]); const path = url.replace('/ordin/api/', '')
    if (path === 'model/config') return response({ configuredKey: false, defaultModel: 'small-model' })
    if (path === 'execution/status') return response({ selected: 'codex', health: null })
    if (path.startsWith('assets?')) return response({assets:[{id:'ref-one',name:'Dataset',managed:true,status:'active',revision:2,contentHash:'a'.repeat(64)}]});
    if (path.startsWith('tickets?')) { if (deferredList) { const p = deferredList; deferredList = null; return p } return response(listError ? { error: 'list offline' } : { tickets }, !listError) }
    const match = new RegExp('^tickets/([^/]+)(?:/(.*))?$').exec(path); if (!match) throw Error('unexpected route ' + path)
    const [, id, action] = match; const ticket = tickets.find(t => t.id === id)
    if (options.method === 'POST') { if (deferredPost) { const p = deferredPost; deferredPost = null; return p } return response(postError ? { error: 'write offline' } : ticket, !postError) }
    if (action === 'progress') return response(progress[id] || { loaded: true, sessionId: 's', lastSaid: 'Preparing outline', recentTools: [{ name: 'read', at: 'now' }] })
    if (action?.startsWith('events')) return response({ events: events[id] || [] })
    if (action?.startsWith('file?')) return response({path:'report.md',text:true,base64:Buffer.from('你好 <script>alert(1)</script>').toString('base64')});
    if (action === 'files') return response({ files: [{ path: 'report.md', size: 42, mtime: '2026-01-02', directory: false }], count: 1, truncated: false })
    if (!action) { if (deferredDetail) { const p = deferredDetail; deferredDetail = null; return p } return response(ticket) }
    throw Error('unexpected route ' + path)
  })
  const window: any = { parent: { postMessage: vi.fn() }, confirm: vi.fn(() => true) }
  const context: any = { document: { getElementById: get, createElement: () => new Element() }, window, location: { search, origin: 'http://ordin.test' }, fetch, URLSearchParams, console, atob, Uint8Array, TextDecoder }
  runInNewContext(script, context)
  return { nodes, tabs, tickets, events, progress, calls, fetch, window, workspace: window.Workspace, errorList: (v = true) => { listError = v }, errorPost: (v = true) => { postError = v }, deferList: (p: Promise<any>) => { deferredList = p }, deferDetail: (p: Promise<any>) => { deferredDetail = p }, deferPost: (p: Promise<any>) => { deferredPost = p } }
}
const titles = (f: ReturnType<typeof fixture>) => f.nodes.list.children.map(c => c.innerHTML).join(' ')
const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise<any>(r => { resolve = r }); return { promise, resolve } }

describe('friendly workspace actual JavaScript', () => {
  it('selects a pinned asset for an open task, preserves retry identity and refuses ended tasks',async()=>{
    const f=fixture();await f.workspace.init();await f.nodes['asset-search'].onclick();await f.nodes['asset-results'].children[0].onclick();
    expect(f.nodes['asset-selection'].textContent).toContain('Dataset · v2');f.errorPost(true);await f.nodes['asset-send'].onclick();
    const first=JSON.parse(f.calls.find(([u])=>u.endsWith('/asset-inputs'))[1].body);
    expect(first.assetRefs).toEqual([{id:'ref-one',revision:2,contentHash:'a'.repeat(64)}]);
    expect(f.nodes['asset-selection'].textContent).toContain('Dataset');f.errorPost(false);await f.nodes['asset-send'].onclick();
    expect(JSON.parse(f.calls.filter(([u])=>u.endsWith('/asset-inputs')).at(-1)[1].body).requestId).toBe(first.requestId);
    await f.workspace.select('t-done');expect(f.nodes['asset-input-area'].hidden).toBe(true);
    const n=f.calls.filter(([u])=>u.endsWith('/asset-inputs')).length;await f.nodes['asset-send'].onclick();expect(f.calls.filter(([u])=>u.endsWith('/asset-inputs'))).toHaveLength(n);
  });
  it('opens UTF-8 deliverables safely inside the panel and closes the preview', async()=>{
    const f=fixture(); await f.workspace.init();
    const link=f.nodes.files.children.at(-1); expect(link.dataset.file).toBe('report.md');
    await link.onclick(); expect(f.nodes['file-preview'].hidden).toBe(false);
    expect(f.nodes['file-preview-content'].textContent).toBe('你好 <script>alert(1)</script>');
    expect(f.nodes['file-preview-content'].innerHTML).toBe('');
    expect(f.calls.some(([u])=>u.endsWith('/file?path=report.md'))).toBe(true);
    f.nodes['file-preview-close'].onclick();expect(f.nodes['file-preview'].hidden).toBe(true);
  })
  it('offers explicit local removal for recovery and never sends external stop', async () => {
    const f=fixture(); f.tickets[0].recovery={state:'uncertain'}; await f.workspace.init();
    expect(f.nodes.stop.hidden).toBe(true); expect(f.nodes.dismiss.hidden).toBe(false);
    f.window.confirm.mockReturnValueOnce(false); await f.nodes.dismiss.onclick();
    expect(f.calls.some(([u,o])=>u.endsWith('/dismiss')&&o.method==='POST')).toBe(false);
    await f.nodes.dismiss.onclick();
    expect(f.window.confirm).toHaveBeenCalledWith(expect.stringContaining('不会停止'));
    expect(f.calls.filter(([u,o])=>u.endsWith('/dismiss')&&o.method==='POST')).toHaveLength(1);
    expect(f.calls.some(([u,o])=>u.endsWith('/stop')&&o.method==='POST')).toBe(false);
  })
  it('requires recovery reconciliation instead of an ordinary answer', async () => {
    const f = fixture(); f.tickets[0].recovery = { state:'uncertain', reason:'external process unknown' }; f.tickets[0].canRetry = false; await f.workspace.init();
    expect(f.nodes['answer-area'].hidden).toBe(true); expect(f.nodes['note-area'].hidden).toBe(true); expect(f.nodes['answer-send'].disabled).toBe(true);
    expect(f.nodes.detail.innerHTML).toContain('需要人工核对恢复状态'); f.nodes.answer.value='try resume'; await f.nodes['answer-send'].onclick!(); expect(f.calls.some(([u,o])=>u.endsWith('/answer') && o.method==='POST')).toBe(false);
  })
  it('selects an existing query ticket, searches summaries and filters real statuses', async () => {
    const f = fixture(); await f.workspace.init(); expect(f.nodes.question.textContent).toBe('Which audience?'); expect(f.nodes.detail.innerHTML).toContain('Plan a launch');
    f.nodes.search.value = 'report'; f.nodes.search.oninput!(); expect(titles(f)).toContain('Write report'); expect(titles(f)).not.toContain('Plan a launch');
    f.nodes.search.value = ''; f.nodes.search.oninput!(); f.tabs[1].onclick!(); expect(titles(f)).not.toContain('Write report'); expect(titles(f)).toContain('Plan a launch');
    f.tabs[2].onclick!(); expect(titles(f)).toContain('Repair import'); f.tabs[3].onclick!(); expect(titles(f)).toContain('Write report'); expect(titles(f)).not.toContain('Plan a launch');
    f.tabs[0].onclick!(); await f.nodes.list.children[2].onclick!(); expect(f.nodes.detail.innerHTML).toContain('A report was produced'); expect(f.nodes.detail.innerHTML).toContain('验收状态以任务结果/详情为准'); expect(f.nodes.retry.hidden).toBe(true); expect(f.nodes.retry.disabled).toBe(true)
  })
  it('does not claim verification for stage done without acceptance, and only accepts explicit acceptance', async () => {
    const f = fixture('?ticket=t-done'); await f.workspace.init(); expect(f.nodes.detail.innerHTML).toContain('验收状态以任务结果/详情为准'); expect(f.nodes.detail.innerHTML).not.toContain('验收已通过');
    f.tickets[2].acceptance = { status: 'unverified' }; await f.workspace.select('t-done'); expect(f.nodes.detail.innerHTML).not.toContain('验收已通过');
    f.tickets[2].acceptance = { status: 'accepted' }; await f.workspace.select('t-done'); expect(f.nodes.detail.innerHTML).toContain('验收已通过')
  })
  it('renders all API acceptance states distinctly and never accepts missing or unknown verdicts', async () => {
    const f = fixture('?ticket=t-done'); await f.workspace.init()
    for (const [status, label] of [['pending', '验收进行中'], ['accepted', '验收已通过'], ['rework', '验收要求返工'], ['unverified', '验收未验证'], ['future-state', '未知验收状态：future-state']]) {
      f.tickets[2].acceptance = { status }; await f.workspace.select('t-done')
      expect(f.nodes.detail.innerHTML).toContain(label)
      if (status !== 'accepted') expect(f.nodes.detail.innerHTML).not.toContain('验收已通过')
    }
  })
  it('uses only explicit API retry permission, including pending and waiting, and guards POSTs', async () => {
    const f = fixture('?ticket=t-fail'); await f.workspace.init()
    for (const permission of [undefined, false, 'true', 1]) {
      f.tickets[1].canRetry = permission; await f.workspace.select('t-fail')
      expect(f.nodes.retry.hidden).toBe(true); expect(f.nodes.retry.disabled).toBe(true)
      await f.nodes.retry.onclick!()
    }
    expect(f.calls.filter(([url, o]) => url.endsWith('/retry') && o.method === 'POST')).toHaveLength(0)
    for (const stage of ['pending', 'waiting', 'running', 'failed', 'blocked']) {
      Object.assign(f.tickets[1], { stage, canRetry: true }); await f.workspace.select('t-fail')
      expect(f.nodes.retry.hidden).toBe(false); expect(f.nodes.retry.disabled).toBe(false)
      await f.nodes.retry.onclick!()
    }
    expect(f.calls.filter(([url, o]) => url.endsWith('/retry') && o.method === 'POST')).toHaveLength(5)
  })
  it('uses answer and note bodies, preserves drafts on errors and per task navigation', async () => {
    const f = fixture(); await f.workspace.init(); f.nodes.answer.value = 'Growth teams'; f.errorPost(); await f.nodes['answer-send'].onclick!(); expect(f.nodes.answer.value).toBe('Growth teams'); expect(f.nodes.error.textContent).toContain('write offline');
    await f.workspace.select('t-fail'); f.nodes.note.value = 'Repair the path'; await f.nodes['note-send'].onclick!(); expect(f.nodes.note.value).toBe('Repair the path');
    await f.workspace.select('t-wait'); expect(f.nodes.answer.value).toBe('Growth teams'); f.errorPost(false); await f.nodes['answer-send'].onclick!(); expect(f.nodes.answer.value).toBe('');
    const call = f.calls.find(([u, o]) => u.endsWith('/answer') && o.method === 'POST'); expect(JSON.parse(call[1].body)).toEqual({ text: 'Growth teams' }); expect(call[1].headers['x-ordin-request']).toBe('1')
  })
  it('disables pending controls, prevents double submission and keeps a newer selection intact', async () => {
    const f = fixture(); await f.workspace.init(); const gate = deferred(); f.deferPost(gate.promise); f.nodes.answer.value = 'Audience'; const write = f.nodes['answer-send'].onclick!(); expect(f.nodes['answer-send'].disabled).toBe(true); await f.nodes['answer-send'].onclick!(); expect(f.calls.filter(([u]) => u.endsWith('/answer'))).toHaveLength(1);
    await f.workspace.select('t-fail'); f.nodes.note.value = 'new draft'; gate.resolve(response(waiting)); await write; expect(f.nodes.detail.innerHTML).toContain('Repair import'); expect(f.nodes.note.value).toBe('new draft')
  })
  it('requires cancellation confirmation, remains stopping until stop_result confirms, and handles negative evidence', async () => {
    const f = fixture(); await f.workspace.init(); f.window.confirm.mockReturnValueOnce(false); await f.nodes.stop.onclick!(); expect(f.calls.filter(([u]) => u.endsWith('/stop'))).toHaveLength(0);
    await f.nodes.stop.onclick!(); expect(f.window.confirm).toHaveBeenCalledWith(expect.stringContaining('请求排队不代表')); expect(f.nodes['action-message'].textContent).toContain('停止请求已排队'); expect(f.nodes.detail.innerHTML).not.toContain('已停止');
    f.tickets[0].stage = 'stopped'; f.tickets[0].ended = { outcome: 'stopped' }; await f.workspace.select('t-wait'); expect(f.nodes.detail.innerHTML).not.toContain('已停止');
    f.events['t-wait'] = [{ type: 'stop_result', detail: { ok: false } }]; await f.workspace.select('t-wait'); expect(f.nodes.detail.innerHTML).toContain('停止未获确认');
    f.events['t-wait'] = [{ type: 'stop_result', detail: { ok: true } }]; await f.workspace.select('t-wait'); expect(f.nodes.detail.innerHTML).toContain('已停止（执行端已确认）')
  })
  it('continues the selected ticket with a same-origin message, including completed work, with no manual ID entry', async () => {
    const f = fixture('?ticket=t-done'); await f.workspace.init(); f.nodes.continue.onclick!(); expect(f.window.parent.postMessage).toHaveBeenCalledWith({ type: 'ordin:continue-task', ticketId: 't-done' }, 'http://ordin.test'); expect(html).not.toContain('placeholder="Ticket ID"')
  })
  it('renders actual file metadata and truthful absent health without launching checks', async () => {
    const f = fixture(); await f.workspace.init(); expect(f.nodes.health.textContent).toContain('尚无检查结果'); expect(f.nodes.health.textContent).not.toContain('检查通过'); expect(f.calls.some(([u]) => u.includes('execution/check'))).toBe(false); expect(f.nodes.files.innerHTML).toContain('report.md'); expect(f.nodes.files.innerHTML).toContain('42 字节'); expect(f.nodes.files.innerHTML).not.toContain('href='); expect(f.nodes.technical.textContent).toContain('t-wait')
  })
  it('preserves the last task list on errors and rejects malformed list responses visibly', async () => {
    const f = fixture(); await f.workspace.init(); f.errorList(); await f.workspace.refresh(); expect(f.nodes.error.textContent).toContain('保留上次内容'); expect(titles(f)).toContain('Plan a launch'); expect(f.nodes.refresh.disabled).toBe(false); f.errorList(false); f.deferList(Promise.resolve(response({ wrong: [] }))); await f.workspace.refresh(); expect(f.nodes.error.textContent).toContain('响应格式不正确'); expect(titles(f)).toContain('Plan a launch')
  })
  it('ignores stale list and detail responses when newer requests finish first', async () => {
    const f = fixture(); await f.workspace.init(); const list = deferred(); f.deferList(list.promise); const old = f.workspace.refresh(); await f.workspace.refresh(); list.resolve(response({ tickets: [{ id: 'stale', title: 'STALE' }] })); await old; expect(titles(f)).not.toContain('STALE');
    const detail = deferred(); f.deferDetail(detail.promise); const previous = f.workspace.select('t-wait'); await f.workspace.select('t-fail'); detail.resolve(response({ ...waiting, title: 'STALE DETAIL' })); await previous; expect(f.nodes.detail.innerHTML).toContain('Repair import'); expect(f.nodes.detail.innerHTML).not.toContain('STALE DETAIL')
  })
  it('does not fetch a nonexistent query ticket and escapes untrusted content', async () => {
    const f = fixture('?ticket=not-real'); f.tickets[0].title = '<img src=x onerror=alert(1)>'; await f.workspace.init(); expect(f.calls.some(([u]) => u.includes('/not-real'))).toBe(false); expect(f.nodes.error.textContent).toContain('指定任务'); expect(titles(f)).toContain('&lt;img'); expect(titles(f)).not.toContain('<img')
  })
})
