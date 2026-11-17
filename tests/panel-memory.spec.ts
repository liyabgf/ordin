import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
// Minimal DOM only: behavior comes from the shipped main script, including el/api/show and tab clicks.
class Node {
  nodeType = 1
  children: Node[] = []
  attrs: Record<string, string> = {}
  dataset: Record<string, string> = {}
  listeners: Record<string, Function> = {}
  value = ''; disabled = false; hidden = false; className = ''; ownText = ''
  classList = { toggle: vi.fn() }
  constructor(public tag: string) {}
  set textContent(v: string) { this.ownText = String(v); this.children = [] }
  get textContent(): string { return this.ownText + this.children.map(n => n.textContent).join('') }
  set innerHTML(_v: string) { throw new Error('HTML assignment is forbidden in memory rendering') }
  setAttribute(k: string, v: unknown) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v) }
  append(...kids: Node[]) { this.children.push(...kids) }
  replaceChildren(...kids: Node[]) { this.children = kids; this.ownText = '' }
  addEventListener(k: string, f: Function) { this.listeners[k] = f }
  async click() { if (!this.disabled) await this.listeners.click?.({ target: this }) }
}
const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)]
const row = (extra = {}) => ({ id:'mem-a',kind:'preference',content:'Use concise answers',scope:'global',confidence:'inferred',revision:7,...extra })
function fixture(initial: any[] = []) {
  const nodes: Record<string, Node> = {}
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes[match[1]!] = new Node('div')
  const settingsTab = new Node('button'); settingsTab.dataset.tab = 'settings'
  nodes.tabs!.append(settingsTab)
  ;(nodes.tabs as any).querySelectorAll = () => [settingsTab]
  nodes['memory-kind'] && (nodes['memory-kind'].value = 'preference')
  nodes['memory-scope'] && (nodes['memory-scope'].value = 'global')
  let rows = structuredClone(initial), fail = '', forceConflict = false
  const calls: {path: string, method: string, body: any}[] = []
  const fetch = vi.fn(async (url: string, init: any) => {
    const path = url.replace('/ordin/api/', ''), method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({path, method, body})
    expect(init.headers['x-ordin-request']).toBe('1')
    if (fail) return {ok:false,status:503,json:async()=>({error:fail})}
    if (method === 'GET') {
      expect(path).toBe('memories?includeExpired=true')
      return {ok:true,json:async()=>({memories:structuredClone(rows)})}
    }
    if (path === 'memories') {
      expect(method).toBe('POST')
      expect(body).toEqual({kind:'task-lesson',content:'New lesson',scope:'global',expiresAt:null})
      rows.push(row({id:'mem-new',...body,revision:1}))
    } else {
      const current = rows.find((r: any) => path.startsWith('memories/' + encodeURIComponent(r.id)))!
      expect(current).toBeDefined()
      expect(body.expectedRevision).toBe(current.revision)
      if (forceConflict) return {ok:false,status:409,json:async()=>({error:'Memory revision conflict'})}
      if (path.endsWith('/confirm')) {
        expect(method).toBe('POST'); expect(body).toEqual({expectedRevision:current.revision})
        current.confidence = 'confirmed'
      } else if (method === 'PATCH') {
        expect(Object.keys(body).sort()).toEqual(['content','expectedRevision','expiresAt'])
        if (body.content !== current.content) current.confidence = 'inferred'
        Object.assign(current, {content:body.content,expiresAt:body.expiresAt})
      } else {
        expect(method).toBe('DELETE'); expect(body).toEqual({expectedRevision:current.revision})
        rows = rows.filter((r: any) => r !== current)
      }
      current.revision++
    }
    return {ok:true,json:async()=>({ok:true})}
  })
  const chunk = (start: string, end: string) => {
    const s = html.indexOf(start), e = html.indexOf(end, s)
    expect(s, start).toBeGreaterThan(0); expect(e, end).toBeGreaterThan(s)
    return html.slice(s,e)
  }
  runInNewContext([
    chunk('  const HEADER =', '  // Reconcile in place:'),
    chunk('  const api = async', '  /**\n   * 把一段文本'),
    chunk('  // ------------------------------------------------------------- memories', '  // ------------------------------------------------------------- settings'),
    chunk('  const show = name => {', '  /** A notification or deep link'),
    html.split('\n').find(line => line.includes("for (const button of $('tabs').querySelectorAll('button[data-tab]')) button.addEventListener")),
  ].join('\n'), {
    document:{getElementById:(id: string)=>nodes[id],createElement:(tag: string)=>new Node(tag),createTextNode:(v: string)=>{const n=new Node('#text');n.nodeType=3;n.textContent=v;return n}},
    fetch, window:{}, localStorage:{setItem:vi.fn()}, loadSettings:vi.fn(), stopPolling:vi.fn(), tab:'overview',
  })
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)) }
  return {
    nodes,calls,settingsTab,settle, rows:()=>rows,
    fail:(value: string)=>{fail=value}, conflict:()=>{forceConflict=true},
    button:(text: string, root = nodes['memory-list']!)=>{const n=all(root).find(n=>n.tag==='button'&&n.textContent===text);expect(n,text).toBeDefined();return n!},
    inputs:()=>all(nodes['memory-list']!).filter(n=>['textarea','input'].includes(n.tag)),
  }
}

describe('Settings memory management: actual panel handlers', () => {
  it('Settings click loads empty data and exposes API errors', async () => {
    const f=fixture(); await f.settingsTab.click(); await f.settle()
    expect(f.nodes['memory-list']!.textContent).toContain('暂无记忆')
    expect(f.calls).toHaveLength(1)
    f.fail('<service unavailable>'); await f.nodes['memory-refresh']!.click()
    expect(f.nodes['memory-error']!.textContent).toContain('<service unavailable>')
  })
  it('lists confirmed, inferred and expired with source/scope/revision as inert text', async () => {
    const attack='<img src=x onerror=alert(1)><script>attack()</script>'
    const f=fixture([row({content:attack,sourceTicketId:'ticket-a',sourceMessageId:'message-a'}),row({id:'b',confidence:'confirmed'}),row({id:'c',expiresAt:'2000-01-01T00:00:00Z'})])
    await f.settingsTab.click(); await f.settle()
    const text=f.nodes['memory-list']!.textContent
    for (const expected of [attack,'候选','已确认','已过期','ticket-a','message-a','global','修订 7']) expect(text).toContain(expected)
    expect(all(f.nodes['memory-list']!).filter(n=>n.tag==='img'||n.tag==='script')).toHaveLength(0)
    expect(all(f.nodes['memory-list']!).filter(n=>n.tag==='button'&&n.textContent==='确认候选')).toHaveLength(1)
    expect(f.calls.every(c=>c.method==='GET')).toBe(true)
    await f.button('确认候选').click()
    expect(f.rows()[0].confidence).toBe('confirmed')
    expect(f.calls.at(-1)?.method).toBe('GET')
  })
  it('creates a proposal without automatic confirmation', async () => {
    const f=fixture(); await f.settingsTab.click(); await f.settle()
    f.nodes['memory-kind']!.value='task-lesson';f.nodes['memory-content']!.value='New lesson'
    await f.nodes['memory-create']!.click()
    expect(f.rows()[0].confidence).toBe('inferred')
    expect(f.nodes['memory-content']!.value).toBe('')
    expect(f.calls.map(c=>c.method)).toEqual(['GET','POST','GET'])
  })
  it('PATCH edits content and expiry using the displayed revision and leaves inferred', async () => {
    const f=fixture([row({confidence:'confirmed'})]); await f.settingsTab.click(); await f.settle()
    const [content,expiry]=f.inputs(); content!.value='Corrected content';expiry!.value='2030-12-01T12:00'
    await f.button('保存修改').click()
    expect(f.rows()[0]).toMatchObject({content:'Corrected content',confidence:'inferred',revision:8,expiresAt:new Date('2030-12-01T12:00').toISOString()})
    expect(f.nodes['memory-list']!.textContent).toContain('候选')
    expect(f.calls.map(c=>c.method)).toEqual(['GET','PATCH','GET'])
  })
  it('requires explicit delete confirmation, supports cancel, then refreshes after soft delete', async () => {
    const f=fixture([row()]); await f.settingsTab.click(); await f.settle()
    await f.button('删除').click()
    expect(f.calls).toHaveLength(1)
    expect(f.nodes['memory-list']!.textContent).toContain('软删除')
    await f.button('取消').click(); expect(f.calls).toHaveLength(1)
    await f.button('删除').click();await f.button('确认删除').click()
    expect(f.rows()).toEqual([])
    expect(f.nodes['memory-list']!.textContent).toContain('暂无记忆')
    expect(f.calls.map(c=>c.method)).toEqual(['GET','DELETE','GET'])
  })
  it('409 and write errors preserve the exact user draft and never refresh or confirm', async () => {
    const f=fixture([row({confidence:'confirmed'})]); await f.settingsTab.click(); await f.settle()
    const [content,expiry]=f.inputs();content!.value='Unsaved <draft>';expiry!.value='2031-03-04T15:16'
    f.conflict();await f.button('保存修改').click()
    expect(f.nodes['memory-error']!.textContent).toContain('revision conflict')
    expect(f.nodes['memory-error']!.textContent).toContain('草稿保留')
    expect(f.inputs()[0]).toBe(content);expect(content!.value).toBe('Unsaved <draft>');expect(expiry!.value).toBe('2031-03-04T15:16')
    expect(f.calls.map(c=>c.method)).toEqual(['GET','PATCH'])
    f.fail('write failed');await f.button('保存修改').click()
    expect(f.nodes['memory-error']!.textContent).toContain('write failed')
    expect(content!.value).toBe('Unsaved <draft>')
  })
})
