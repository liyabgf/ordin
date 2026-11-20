import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../panel/chat.html', import.meta.url), 'utf8')
class Element {
  children: Element[] = []; attrs: Record<string,string> = {}; listeners: Record<string,Function> = {}
  value = ''; disabled = false; hidden = false; className = ''; ownText = ''
  constructor(public tag: string) {}
  set textContent(value: string) { this.ownText = String(value); this.children = [] }
  get textContent(): string { return this.ownText + this.children.map(n => n.textContent).join('') }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML assignment') }
  appendChild(node: Element) { this.children.push(node); return node }
  append(...nodes: Element[]) { this.children.push(...nodes) }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.ownText = '' }
  setAttribute(key: string, value: string) { this.attrs[key] = String(value) }
  addEventListener(key: string, fn: Function) { this.listeners[key] = fn }
  focus() {}
  async event(key: string, event: any = {}) { if (!this.disabled) await this.listeners[key]?.({ preventDefault() {}, ...event }) }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const asset = (id = 'report', overrides: any = {}) => ({ id, name: '友好报告', revision: 3, contentHash: 'a'.repeat(64), managed: true, status: 'active', archived: false, ...overrides })
const pin = (a: any) => ({ id: a.id, revision: a.revision, contentHash: a.contentHash })
function fixture(storage = new Map<string,string>(), omitAssets = false) {
  const nodes: Record<string,Element> = {}
  for (const match of html.matchAll(/<([a-z]+)[^>]*id="([^"]+)"[^>]*>([^<]*)/g)) {
    if (omitAssets && match[2]!.startsWith('asset-')) continue
    const n = nodes[match[2]!] = new Element(match[1]!); n.textContent = match[3]!; n.hidden = /\bhidden\b/.test(match[0]!.split('>')[0]!)
  }
  const calls: {path: string, method: string, body: any}[] = [], listeners: Record<string,Function> = {}
  let assets = [asset()], fail = false, response: any = {reply:'ok',toolOutcomes:[{name:'create_task',ok:true,data:{}}]}, deferred = false
  let release: (value: any) => void = () => { throw new Error('No pending send') }
  let detail = asset(), detailDeferred = false, releaseDetail: (value: any) => void = () => { throw new Error('No pending detail') }
  const ok = (body: any) => ({ok:true, status:200, json:async () => structuredClone(body)})
  const parent = {postMessage() {}}
  const win: any = {parent, location:{search:'',origin:'http://ordin.test'}, addEventListener:(name:string, fn:Function) => {listeners[name] = fn}, history:{replaceState() {}}, confirm:()=>true}
  runInNewContext(html.split('<script>')[1]!.split('</script>')[0]!, {
    document:{getElementById:(id:string)=>nodes[id], createElement:(tag:string)=>new Element(tag)}, window:win, URLSearchParams, crypto:{randomUUID},
    localStorage:{getItem:(key:string)=>storage.get(key) ?? null, setItem:(key:string,value:string)=>storage.set(key,value), removeItem:(key:string)=>storage.delete(key)},
    fetch:async (url:string, init:any = {}) => {
      const path = url.replace('/ordin/api/',''), method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : undefined
      calls.push({path,method,body}); expect(init.headers['x-ordin-request']).toBe('1')
      if (path === 'model/config') return ok({models:[]})
      if (path === 'execution/status') return ok({health:{ok:true}})
      if (path.startsWith('conversations?')) return ok({conversations:['a','b'].map(id=>({id,title:id,revision:1}))})
      if (path.startsWith('conversations/a/actions/')) return {ok:false,status:404,json:async()=>({error:'not found'})}
      if (/conversations\/[ab]\/messages/.test(path)) return ok({messages:[]})
      if (path.startsWith('assets?')) return fail ? {ok:false,status:503,json:async()=>({error:'catalog down'})} : ok({assets})
      if (path.startsWith('assets/')) { if (detailDeferred) return new Promise<any>(r=>{releaseDetail=r}); return ok(detail) }
      if (/conversations\/[ab]\/message$/.test(path)) {
        if (fail) return {ok:false,status:409,json:async()=>({error:'rejected'})}
        if (deferred) return new Promise<any>(r=>{release=r})
        return ok(response)
      }
      throw new Error('Unexpected request '+method+' '+path)
    },
  })
  return {nodes,calls,storage,win,setAssets:(value:any[])=>{assets=value},setDetail:(value:any)=>{detail=value},fail:(value:boolean)=>{fail=value},response:(value:any)=>{response=value},
    defer:()=>{deferred=true},release:()=>release(ok(response)),deferDetail:()=>{detailDeferred=true},releaseDetail:()=>releaseDetail(ok(detail)),
    select:async(id:string)=>{await nodes['conversation-list']!.children.find(n=>n.attrs['data-id']===id)!.event('click')},
    message:async(data:any, source:any=parent, origin='http://ordin.test')=>listeners.message!({data,source,origin}),
    open:async()=>{await nodes['asset-open']!.event('click');await settle()},
    choose:async(index=0)=>nodes['asset-results']!.children[index]!.event('click'),
    send:async()=>{nodes.input!.value='use report';return nodes.send!.event('click')},
  }
}

describe('chat asset selection actual script in VM',()=>{
  it('opens a searchable catalog, selects only managed active non-archived assets and removes safe friendly chips',async()=>{
    const f=fixture();await settle()
    f.setAssets([asset('safe',{name:'<img src=x onerror=attack()> 文件'}),asset('old',{archived:true}),asset('inactive',{status:'inactive'}),asset('legacy',{managed:false})])
    await f.open();expect(f.nodes['asset-picker']!.hidden).toBe(false)
    expect(f.calls).toContainEqual({path:'assets?limit=200&query=',method:'GET',body:undefined})
    f.nodes['asset-query']!.value='报告 & 图';await f.nodes['asset-query']!.event('input');await settle()
    expect(f.calls.at(-1)!.path).toBe('assets?limit=200&query='+encodeURIComponent('报告 & 图'))
    expect(f.nodes['asset-results']!.children).toHaveLength(1)
    await f.choose();expect(f.nodes['asset-chips']!.textContent).toContain('<img src=x onerror=attack()> 文件 · r3')
    expect(f.nodes['asset-chips']!.children[0]!.children[0]!.children).toHaveLength(0)
    await f.nodes['asset-chips']!.children[0]!.children[1]!.event('click');expect(f.nodes['asset-chips']!.children).toHaveLength(0)
    expect(f.calls.some(c=>c.path.endsWith('/message')||c.method==='POST')).toBe(false)
  })
  it('persists choices separately from drafts and isolates switching and reloads',async()=>{
    const f=fixture();await settle();await f.open();await f.choose();await f.select('b')
    expect(f.nodes['asset-chips']!.children).toHaveLength(0)
    f.setAssets([asset('second',{name:'Second'})]);await f.open();await f.choose();await f.select('a')
    expect(f.nodes['asset-chips']!.textContent).toContain('友好报告');expect(f.nodes['asset-chips']!.textContent).not.toContain('Second')
    const saved=JSON.parse(f.storage.get('ordin.chat.conversationAssets')!);expect(saved.a[0].id).toBe('report');expect(saved.b[0].id).toBe('second')
    const again=fixture(f.storage);await settle();expect(again.nodes['asset-chips']!.textContent).toContain('友好报告')
  })
  it('submits exact pins to the existing message endpoint; network and tool failure preserve choices, success clears only submitted choices',async()=>{
    const f=fixture();await settle();await f.open();await f.choose();f.fail(true);await f.send()
    expect(f.nodes['asset-chips']!.children).toHaveLength(1)
    const sent = () => f.calls.filter(c=>c.path==='conversations/a/message')
    expect(sent()).toHaveLength(1)
    const original = sent()[0]!
    expect(original.body).toEqual({text:'use report',assetRefs:[pin(asset())],actionId:expect.any(String)})
    expect(f.calls.at(-1)?.path).toBe('conversations/a/actions/'+original.body.actionId)
    expect(f.nodes['resend-action']!.hidden).toBe(false)
    f.fail(false);f.response({toolOutcomes:[{name:'create_task',ok:false,error:'no executor'}]})
    await f.nodes['send-retry']!.event('click');expect(sent()).toEqual([original])
    await f.nodes['resend-action']!.event('click');expect(sent()).toEqual([original, original]);expect(f.nodes['asset-chips']!.children).toHaveLength(1)
    f.response({reply:'chat only'});await f.send();expect(f.nodes['asset-chips']!.children).toHaveLength(1)
    f.response({reply:'ok',toolOutcomes:[{name:'create_task',ok:true,data:{ticketId:'task-late'}}]});f.defer();const pending=f.send();await settle();f.setAssets([asset('late',{name:'Added while sending'})]);await f.open();await f.choose();f.release();await pending
    expect(f.nodes['asset-chips']!.textContent).toContain('Added while sending');expect(f.nodes['asset-chips']!.textContent).not.toContain('友好报告')
  })
  it('successful delayed submits clear origin choices without touching another conversation',async()=>{
    const f=fixture();await settle();await f.open();await f.choose();f.response({reply:'ok',toolOutcomes:[{name:'create_task',ok:true,data:{ticketId:'task-origin'}}]});f.defer();const pending=f.send();await settle();await f.select('b')
    f.setAssets([asset('second',{name:'Second'})]);await f.open();await f.choose();f.release();await pending
    expect(f.nodes['asset-chips']!.textContent).toContain('Second');await f.select('a');expect(f.nodes['asset-chips']!.children).toHaveLength(0)
  })
  it('accepts only same-origin parent messages and verifies latest pin before adding without sending or creating',async()=>{
    const f=fixture();await settle();const data={type:'ordin:use-asset',assetRef:pin(asset())}
    await f.message(data,{},'http://ordin.test');await f.message(data,undefined,'https://evil.test')
    expect(f.calls.some(c=>c.path.startsWith('assets/'))).toBe(false)
    await f.message({...data,assetRef:{...data.assetRef,revision:2}});expect(f.nodes['asset-error']!.textContent).toContain('版本已变化');expect(f.nodes['asset-chips']!.children).toHaveLength(0)
    await f.message({...data,assetRef:{...data.assetRef,contentHash:'b'.repeat(64)}});expect(f.nodes['asset-chips']!.children).toHaveLength(0)
    await f.message(data);expect(f.nodes['asset-chips']!.textContent).toContain('友好报告 · r3');expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(0)
    await f.message(data);expect(f.nodes['asset-chips']!.children).toHaveLength(1)
  })
  it('rejects unavailable parent assets and ignores delayed detail after switching',async()=>{
    const f=fixture();await settle();const data={type:'ordin:use-asset',assetRef:pin(asset())}
    for (const overrides of [{managed:false},{archived:true},{status:'inactive'}]) { f.setDetail(asset('report',overrides));await f.message(data);expect(f.nodes['asset-chips']!.children).toHaveLength(0);expect(f.nodes['asset-error']!.textContent).toContain('不可用') }
    f.setDetail(asset());f.deferDetail();const pending=f.message(data);await settle();await f.select('b');f.releaseDetail();await pending;expect(f.nodes['asset-chips']!.children).toHaveLength(0)
  })
  it('shows catalog failures and supports older fixtures with asset nodes missing',async()=>{
    const f=fixture();await settle();f.fail(true);await f.open();expect(f.nodes['asset-error']!.textContent).toContain('catalog down')
    const old=fixture(undefined,true);await settle();await old.send();expect(old.calls.at(-1)!.body).toEqual({text:'use report',actionId:expect.any(String)})
  })
})
