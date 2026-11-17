// @ts-nocheck
import { readFileSync } from 'node:fs'
import { runInNewContext, Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8')
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))

class Element {
  nodeType = 1
  ownText = ''
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join('') }
  set textContent(value: string) { this.ownText = value; this.children = [] }
  innerHTML = ''
  children: Element[] = []
  attrs: Record<string, string> = {}
  onclick?: () => any
  constructor(public tag = 'div') {}
  append(...items: Element[]) { this.children.push(...items) }
  appendChild(item: Element) { this.children.push(item) }
  addEventListener(name: string, fn: () => any) { (this as any)['on' + name] = fn }
  querySelectorAll() { return [] }
  setAttribute(key: string, value: string) { this.attrs[key] = value }
  replaceChildren(...items: Element[]) { this.children = items; this.innerHTML = ''; this.ownText = '' }
}

const summary = (overrides: any = {}) => ({ id: 't-1', title: 'Task', stage: 'pending', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z', via: 'test', sender: 'user', waitsForPerson: false, preparationFailed: false, waitingForAnswer: false, inputDelivery: { state: 'delivered', total: 1, pending: 0, delivered: 1 }, summary: 'A summary', ...overrides })

function fixture(rows = [summary()]) {
  const nodes: Record<string, Element> = {}
  const get = (id: string) => nodes[id] || (nodes[id] = new Element())
  const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes('tickets?state=all') ? { tickets: rows } : {} }))
  const context: any = { document: { getElementById: get, createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => { const e = new Element('text'); e.textContent = text; return e }, addEventListener() {}, hidden: false }, window: { addEventListener() {}, setInterval() {} }, location: { origin: 'http://test', hash: '' }, fetch, URLSearchParams, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, console }
  const chunk = (start: string, end: string) => { const a = html.indexOf(start), b = html.indexOf(end, a); if (a < 0 || b < 0) return ''; return html.slice(a, b) }
  const navigate = vi.fn()
  runInNewContext([chunk('  const HEADER =', '  // Reconcile in place:'), chunk('  const api = async', '  /**\n   * 把一段文本'), chunk('  const classifyHomeTicket =', '  const loadFriendlyHome =')].join('\n'), { ...context, friendlyNavigate: navigate })
  return { nodes, fetch, navigate, home: context.window.HomeInbox }
}

describe('F5-U2 home inbox actual JavaScript', () => {
  it('parses the complete page script, not just extracted helpers', () => { expect(() => new Script(script)).not.toThrow() })
  it('partitions real summary states without duplicating active work into ended', async () => {
    const f = fixture([summary({id:'active',title:'Active only',stage:'running'}),summary({id:'closed',title:'Closed only',stage:'done',outcome:'done'}),summary({id:'question',title:'Question only',waitingForAnswer:true})])
    await f.home.refresh()
    expect(f.nodes['home-inbox'].textContent).toContain('Closed only')
    expect(f.nodes['home-inbox'].textContent).not.toContain('Active only')
    expect(f.nodes['home-active'].textContent).toContain('Active only')
    expect(f.nodes['home-attention'].textContent).toContain('Question only')
  })
  it('classifies seven real summary states without treating pending as running', () => {
    const f = fixture()
    const cases = [
      [summary({ waitingForAnswer: true, waitsForPerson: true }), 'needs-answer'],
      [summary({ preparationFailed: true, stage: 'failed', inputDelivery: { state: 'pending', total: 1, pending: 1, delivered: 0 } }), 'preparation-failed'],
      [summary({ stage: 'pending' }), 'pending'],
      [summary({ stage: 'running' }), 'running'],
      [summary({ stage: 'blocked' }), 'blocked'],
      [summary({ stage: 'failed' }), 'failed'],
      [summary({ stage: 'done', endedReason: 'done', outcome: 'done' }), 'ended-unverified'],
    ]
    for (const [ticket, expected] of cases) expect(f.home.classify(ticket).key).toBe(expected)
  })

  it('renders safe text, summary, updated time, status, and next action', () => {
    const f = fixture([summary({ id: 'evil', title: '<img src=x onerror=alert(1)>', summary: '<b>unsafe</b>', stage: 'running' })])
    const rendered = f.home.renderCards([summary({ id: 'evil', title: '<img src=x onerror=alert(1)>', summary: '<b>unsafe</b>', stage: 'running' })], 'home-inbox')
    expect(rendered.innerHTML).not.toContain('<img')
    expect(rendered.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(rendered.textContent).toContain('正在运行')
    expect(rendered.textContent).toContain('查看进度')
    expect(rendered.textContent).toContain('<b>unsafe</b>')
    expect(rendered.textContent).toContain('2026-01-01T01:00:00Z')
    rendered.children[0].onclick!()
    expect(f.navigate).toHaveBeenCalledWith('workspace','evil')
  })

  it('loads all summaries, keeps old cards on failure, and ignores stale generations', async () => {
    const f = fixture([summary({ id: 'old', title: 'Old' })])
    await f.home.refresh()
    expect(f.fetch).toHaveBeenCalledWith('/ordin/api/tickets?state=all&limit=200', expect.anything())
    const first = f.home.lastRows()
    expect(first[0].id).toBe('old')
    f.fetch.mockImplementationOnce(async () => { throw new Error('offline') })
    await f.home.refresh()
    expect(f.home.lastRows()[0].id).toBe('old')
    expect(f.home.error()).toContain('保留上次内容')
    let resolve: any
    f.fetch.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const stale = f.home.refresh()
    await f.home.refresh()
    resolve({ ok:true, json:async()=>({tickets:[summary({id:'stale',title:'STALE'})]}) })
    await stale
    expect(f.home.lastRows()[0].id).toBe('old')
    expect(f.nodes['home-inbox'].textContent).not.toContain('STALE')
    f.fetch.mockImplementationOnce(async()=>({ok:true,json:async()=>({wrong:[]})}))
    await f.home.refresh()
    expect(f.home.error()).toContain('响应格式不正确')
    expect(f.home.lastRows()[0].id).toBe('old')
  })

  it('mutating pending to running changes the human status', () => {
    const f = fixture()
    expect(f.home.classify(summary({ stage: 'pending' })).label).toBe('尚未开始')
    expect(f.home.classify(summary({ stage: 'running' })).label).toBe('正在运行')
  })
})
