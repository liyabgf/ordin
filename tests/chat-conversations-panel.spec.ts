import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../panel/chat.html', import.meta.url), 'utf8')
class Node {
  children: Node[] = []; attrs: Record<string,string> = {}; listeners: Record<string,Function> = {}
  value = ''; disabled = false; hidden = false; className = ''; ownText = ''
  constructor(public tag: string) {}
  set textContent(v: string) { this.ownText = String(v); this.children = [] }
  get textContent(): string { return this.ownText + this.children.map(n=>n.textContent).join('') }
  set innerHTML(_v: string) { throw new Error('Unsafe HTML assignment') }
  appendChild(n: Node) { this.children.push(n); return n }
  append(...n: Node[]) { this.children.push(...n) }
  prepend(...n: Node[]) { this.children.unshift(...n) }
  replaceChildren(...n: Node[]) { this.children = n; this.ownText = '' }
  setAttribute(k: string,v: string) { this.attrs[k] = String(v) }
  addEventListener(k: string,f: Function) { this.listeners[k] = f }
  focus() {}
  async event(k: string, event: any = {}) { if (!this.disabled) await this.listeners[k]?.({preventDefault(){},...event}) }
}
const settle = () => new Promise<void>(r=>setImmediate(r))
const conversation = (id: string, title=id) => ({id,title,revision:1,profileId:'default'})
function fixture(initial = [conversation('panel-default'),conversation('b')], storage = new Map<string,string>(), query = '') {
  const nodes: Record<string,Node> = {}
  for (const m of html.matchAll(/<([a-z]+)[^>]*id="([^"]+)"[^>]*>([^<]*)/g)) { const n=nodes[m[2]!] = new Node(m[1]!); n.textContent=m[3]!; n.hidden=/\bhidden\b/.test(m[0]!.split('>')[0]!); }
  for (const id of ['conversation-new','conversation-list','conversation-title','conversation-rename','conversation-archive','conversation-delete','conversation-error','history-older','history-retry','task-id','continue-task']) expect(nodes[id], 'required control '+id).toBeDefined()
  let rows: any[] = structuredClone(initial), fail = '', defer = false, deferHistory = false, deferContinue = false, deferList = false, continueFailure = ''
  let release: ((v: any)=>void) | undefined, releaseHistory: ((v: any)=>void) | undefined, releaseContinue: ((v: any)=>void) | undefined, releaseList: ((v: any)=>void) | undefined
  const histories: Record<string,any[]> = Object.fromEntries(initial.map(c=>[c.id,[{id:c.id+'-1',role:'ordin',content:'history '+c.id}]]))
  const calls: {path:string,method:string,body:any}[] = []
  const messages: any[]=[]; let messageResponse: any = null, loseNextMessageResponse = false
  const ok = (body: any) => ({ok:true,status:200,json:async()=>structuredClone(body)})
  const fetch = async (url: string,init: any = {}) => {
    const path = url.replace('/ordin/api/',''), method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : undefined
    calls.push({path,method,body}); expect(init.headers['x-ordin-request']).toBe('1')
    if (path==='model/config') return ok({models:['model-a'],defaultModel:'model-a',configuredKey:true})
    if (path==='execution/status') return {ok:false,status:501,json:async()=>({error:'not wired'})}
    if (fail) return {ok:false,status:503,json:async()=>({error:fail})}
    if (path.startsWith('conversations?')) { if (deferList) { deferList=false; return new Promise<any>(r=>{releaseList=r}) }; return ok({conversations:rows}) }
    if (path==='conversations') { const c=conversation('new-'+rows.length,'新对话');rows.push(c);histories[c.id]=[];return ok({conversation:c}) }
    if (path==='conversations/from-task') {
      if (continueFailure) return {ok:false,status:400,json:async()=>({error:continueFailure})}
      if (deferContinue) { deferContinue=false;return new Promise<any>(r=>{releaseContinue=r}) }
      const c=conversation('task-'+body.ticketId,'接续任务');rows.push(c);histories[c.id]=[];return ok({conversation:c})
    }
    const [_,encoded,actionQuery] = path.split('/'), id=decodeURIComponent(encoded!), action=actionQuery?.split('?')[0]
    const current=rows.find(c=>c.id===id); expect(current,'existing target '+id).toBeDefined()
    if (action==='messages') {
      if (deferHistory) { deferHistory=false;return new Promise<any>(r=>{releaseHistory=r}) }
      if (path.includes('before=')) return ok({messages:[{id:'older',role:'user',content:'older '+id}]})
      return ok({messages:histories[id],nextCursor:id+'-1'})
    }
    if (action==='message') {
      histories[id]!.push({role:'user',content:body.text}); const response=ok(messageResponse || {reply:'reply '+id}); messageResponse=null
      if (loseNextMessageResponse) { loseNextMessageResponse = false; throw new Error("response lost") }
      if (defer) return new Promise<any>(r=>{release=r})
      return response
    }
    expect(body.expectedRevision).toBe(current.revision)
    if (method==='PATCH') current.title=body.title
    else if (action==='archive') current.archivedAt='now'
    else if (action==='restore') delete current.archivedAt
    else if (method==='DELETE') rows=rows.filter(c=>c.id!==id)
    else throw new Error('Unexpected API '+method+' '+path)
    current.revision++;return ok({conversation:current})
  }
  runInNewContext(html.split("<script>")[1]!.split("</script>")[0]!, {
    document:{getElementById:(id: string)=>nodes[id],createElement:(tag: string)=>new Node(tag),body:{scrollHeight:0}},
    URLSearchParams, window:{location:{search:query,origin:'http://ordin.test'},history:{replaceState(_state:any,_title:string,url:string){ query=url }},parent:{postMessage:(body:any,origin:string)=>{expect(origin).toBe('http://ordin.test');messages.push(body)}},addEventListener(){},scrollTo(){},confirm:()=>true},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},fetch,
  })
  return {nodes,calls,storage,settle,messages,query:()=>query,respondMessage:(v:any)=>{messageResponse=v},loseMessageResponse:()=>{loseNextMessageResponse=true},rows:()=>rows,fail:(s:string)=>{fail=s},defer:()=>{defer=true},deferHistory:()=>{deferHistory=true},
    release:(reply='OLD RESPONSE')=>release!(ok({reply})),releaseHistory:()=>releaseHistory!(ok({messages:[{content:'OLD HISTORY'}]})),releaseContinue:(id='late-task')=>{const c=conversation(id,'接续任务');rows.push(c);histories[c.id]=[];releaseContinue!(ok({conversation:c}))},deferContinue:()=>{deferContinue=true},deferList:()=>{deferList=true},releaseList:()=>releaseList!(ok({conversations:rows})),continueFailure:(s:string)=>{continueFailure=s},
    select:async(id:string)=>{const b=nodes['conversation-list']!.children.find(n=>n.attrs['data-id']===id);expect(b).toBeDefined();await b!.event('click')},
    type:async(text:string)=>{nodes.input!.value=text;await nodes.input!.event('input')},
  }
}
describe('conversation panel actual script (minimal DOM, no browser)',()=>{
  it('lists legacy history, switches isolated histories, persists selection and sends to captured target with model',async()=>{
    const f=fixture();await f.settle();expect(f.nodes.log!.textContent).toContain('history panel-default')
    await f.select('b');expect(f.nodes.log!.textContent).toContain('history b');expect(f.nodes.log!.textContent).not.toContain('panel-default')
    f.nodes['chat-model']!.value='model-a';await f.type('hello');await f.nodes.input!.event('keydown',{key:'Enter',shiftKey:false})
    expect(f.calls.find(c=>c.path==='conversations/b/message')).toMatchObject({method:'POST',body:{text:'hello',model:'model-a'}})
    expect(f.nodes.log!.textContent).toContain('reply b');expect([...f.storage.values()]).toContain('b')
    const again=fixture(undefined,f.storage);await again.settle();expect(again.nodes.log!.textContent).toContain('history b')
  })
  it('creates once for empty list, refresh reuses it; explicit new creates a fresh target',async()=>{
    const f=fixture([]);await f.settle();expect(f.calls.filter(c=>c.path==='conversations')).toHaveLength(1)
    await f.nodes['conversation-refresh']!.event('click');await f.type('one');await f.nodes.send!.event('click')
    expect(f.calls.filter(c=>c.path==='conversations')).toHaveLength(1)
    await f.nodes['conversation-new']!.event('click');expect(f.calls.filter(c=>c.path==='conversations')).toHaveLength(2)
    expect(f.nodes.log!.textContent).toBe('');await f.type('two');await f.nodes.send!.event('click')
    expect(f.calls.some(c=>c.path==='conversations/new-1/message')).toBe(true)
  })
  it('renames, archives, restores and deletes using the displayed revision',async()=>{
    const f=fixture();await f.settle();await f.nodes['conversation-rename']!.event('click');f.nodes['conversation-title-input']!.value='<new title>'
    await f.nodes['conversation-rename']!.event('click');expect(f.nodes['conversation-title']!.textContent).toContain('<new title>')
    await f.nodes['conversation-archive']!.event('click');expect(f.rows()[0].archivedAt).toBe('now');expect(f.nodes.send!.disabled).toBe(true)
    await f.nodes['conversation-archive']!.event('click');expect(f.rows()[0].archivedAt).toBeUndefined();expect(f.nodes.send!.disabled).toBe(false)
    await f.nodes['conversation-delete']!.event('click');expect(f.rows().map(c=>c.id)).toEqual(['b']);expect(f.nodes.log!.textContent).toContain('history b')
    expect(f.calls.filter(c=>['PATCH','DELETE'].includes(c.method)||/archive|restore/.test(c.path)).map(c=>c.body.expectedRevision)).toEqual([1,2,3,4])
  })
  it('preserves exact per-conversation drafts across selection and reload',async()=>{
    const f=fixture();await f.settle();await f.type(' A\n draft ');await f.select('b');expect(f.nodes.input!.value).toBe('')
    await f.type('B draft');await f.select('panel-default');expect(f.nodes.input!.value).toBe(' A\n draft ')
    const again=fixture(undefined,f.storage);await again.settle();expect(again.nodes.input!.value).toBe(' A\n draft ')
  })
  it('makes list and history failures visible without auto-creating; retries and pages history',async()=>{
    const f=fixture();await f.settle();f.fail('history denied');await f.select('b');expect(f.nodes['conversation-error']!.textContent).toContain('history denied');expect(f.nodes.send!.disabled).toBe(true)
    f.fail('');await f.nodes['history-retry']!.event('click');expect(f.nodes.log!.textContent).toContain('history b')
    await f.nodes['history-older']!.event('click');expect(f.nodes.log!.textContent).toBe('older bhistory b')
    f.fail('list denied');await f.nodes['conversation-refresh']!.event('click');expect(f.nodes['conversation-error']!.textContent).toContain('list denied')
    expect(f.calls.filter(c=>c.path==='conversations')).toHaveLength(0)
  })
  it('does not render deferred old send response into a new selection (even switched away and back)',async()=>{
    const f=fixture();await f.settle();f.defer();await f.type('old request');const pending=f.nodes.send!.event('click');await f.settle();await f.select('b')
    f.release();await pending;expect(f.nodes.log!.textContent).toBe('history b');expect(f.nodes.send!.disabled).toBe(false)
  })
  it('does not render a stale history read after switching',async()=>{
    const f=fixture();await f.settle();f.deferHistory();const pending=f.select('b');await f.settle();await f.select('panel-default');f.releaseHistory();await pending
    expect(f.nodes.log!.textContent).toBe('history panel-default')
  })
  it('continues an explicitly entered task into a new empty conversation without sending',async()=>{
    const f=fixture();await f.settle();await f.type('keep my draft');f.nodes['task-id']!.value='T-123';await f.nodes['continue-task']!.event('click');
    expect(f.calls.find(c=>c.path==='conversations/from-task')).toMatchObject({method:'POST',body:{ticketId:'T-123'}});
    expect(f.nodes.log!.textContent).toBe('');expect(f.nodes.input!.value).toBe('');expect(f.storage.get('ordin.chat.conversationDrafts')).toContain('keep my draft');
    expect(f.calls.some(c=>c.path.endsWith('/message'))).toBe(false);expect(f.nodes['conversation-list']!.textContent).toContain('接续任务')
  })
  it('shows rejected or foreign task errors and preserves task ID and selected conversation',async()=>{
    const f=fixture();await f.settle();f.continueFailure('任务不可访问');f.nodes['task-id']!.value='foreign-id';await f.nodes['continue-task']!.event('click');
    expect(f.nodes['conversation-error']!.textContent).toContain('任务不可访问');expect(f.nodes['task-id']!.value).toBe('foreign-id');expect(f.storage.get('ordin.chat.selectedConversation')).toBe('panel-default')
  })
  it('disables task continuation while pending and sends one request for double click',async()=>{
    const f=fixture();await f.settle();f.deferContinue();f.nodes['task-id']!.value='once';const pending=f.nodes['continue-task']!.event('click');await f.settle();
    expect(f.nodes['continue-task']!.disabled).toBe(true);await f.nodes['continue-task']!.event('click');expect(f.calls.filter(c=>c.path==='conversations/from-task')).toHaveLength(1);f.releaseContinue();await pending
  })
  it('does not switch on late task creation after selection generation changes',async()=>{
    const f=fixture();await f.settle();f.deferContinue();f.nodes['task-id']!.value='late';const pending=f.nodes['continue-task']!.event('click');await f.settle();await f.select('b');f.releaseContinue();await pending;
    expect(f.storage.get('ordin.chat.selectedConversation')).toBe('b');expect(f.nodes.log!.textContent).toBe('history b')
  })
  it('ignores a late list response after the user changes selection',async()=>{
    const f=fixture();await f.settle();f.deferList();const pending=f.nodes['conversation-refresh']!.event('click');await f.settle();await f.select('b');f.releaseList();await pending;expect(f.storage.get('ordin.chat.selectedConversation')).toBe('b');expect(f.nodes.log!.textContent).toBe('history b')
  })
  it('example prompts only fill the draft and Enter composition never submits',async()=>{
    const f=fixture();await f.settle();
    expect(f.nodes['welcome-title']!.textContent).toContain('交代一件事');
    const example=f.nodes['example-summarize'];expect(example).toBeDefined();await example!.event('click');
    expect(f.nodes.input!.value).toContain('总结');expect(f.calls.some(c=>c.path.endsWith('/message'))).toBe(false);
    await f.nodes.input!.event('keydown',{key:'Enter',shiftKey:false,isComposing:true});
    expect(f.calls.some(c=>c.path.endsWith('/message'))).toBe(false);
    await f.nodes.input!.event('keydown',{key:'Enter',shiftKey:false,isComposing:false});
    expect(f.calls.some(c=>c.path.endsWith('/message'))).toBe(true);
  });
  it('keeps chat available when optional setup readiness endpoints fail',async()=>{
    const f=fixture();await f.settle();
    expect(f.nodes['readiness-status']!.textContent).toMatch(/未能读取|检查设置/);
    expect(f.nodes.send!.disabled).toBe(false);
  });
  it('shows created task cards and navigates parent workspace with exact message',async()=>{
    const f=fixture();await f.settle();
    f.respondMessage({reply:'已创建',toolOutcomes:[{name:'create_task',ok:true,data:{ticketId:'TASK-42',title:'整理报告',dispatch:{state:'claimed'}}}]});
    await f.type('整理报告');await f.nodes.send!.event('click');
    expect(f.nodes.log!.textContent).toContain('TASK-42');
    expect(f.nodes.log!.textContent).toContain('已派发');
    expect(f.nodes.log!.children.some(n=>n.attrs['data-task-id']==='TASK-42')).toBe(true);
    f.nodes.log!.children.find(n=>n.attrs['data-task-id']==='TASK-42')!.children.at(-1)!.event('click');
    expect(f.messages).toContainEqual({type:'ordin:navigate',tab:'workspace',ticketId:'TASK-42'});
  });
  it.each([undefined, '', '   ', 123])('keeps selected assets when a successful task receipt has invalid ID %j', async ticketId => {
    const ref = { id:'asset-1', revision:3, contentHash:'fixed-hash' }
    const asset = { ...ref, name:'参考资料' }
    const key = 'ordin.chat.conversationAssets'
    const f = fixture(undefined, new Map([[key, JSON.stringify({ 'panel-default':[asset] })]]))
    await f.settle()
    expect(f.nodes['asset-chips']!.children).toHaveLength(1)
    f.respondMessage({reply:'',toolOutcomes:[{name:'create_task',ok:true,data:{ticketId}}]})
    await f.type(' 交办草稿 ')
    await f.nodes.send!.event('click')
    expect(f.calls.filter(c=>c.method==='POST')).toEqual([
      {path:'conversations/panel-default/message',method:'POST',body:{text:'交办草稿',assetRefs:[ref]}},
    ])
    expect(f.nodes['asset-chips']!.textContent).toContain('参考资料 · r3')
    expect(JSON.parse(f.storage.get(key)!)).toEqual({ 'panel-default':[asset] })
    expect(f.nodes.input!.value).toBe(' 交办草稿 ')
    expect(f.nodes.log!.children.some(n=>'data-task-id' in n.attrs)).toBe(false)
    expect(f.nodes['send-feedback']!.textContent).toContain('缺少有效任务 ID')
  })

  it('preserves drafts and only reads history after an unknown send result',async()=>{
    const f=fixture();await f.settle();await f.type(' exact draft\n ');f.loseMessageResponse();await f.nodes.send!.event('click');
    expect(f.nodes.input!.value).toBe(' exact draft\n ');expect(f.nodes['send-recovery']!.hidden).toBe(false);expect(f.nodes['send-feedback']!.textContent).toContain('发送结果未知');
    const beforeCheck = f.calls.length
    await f.nodes['send-retry']!.event('click')
    expect(f.calls.slice(beforeCheck)).toEqual([{path:'conversations/panel-default/messages?limit=50',method:'GET',body:undefined}])
    expect(f.nodes.log!.textContent).toBe('history panel-defaultexact draft')
    expect(f.nodes.input!.value).toBe(' exact draft\n ')
    expect(f.calls.filter(c=>c.path.endsWith('/message'))).toHaveLength(1)
    const g=fixture();await g.settle();g.respondMessage({reply:'',toolOutcomes:[{name:'create_task',ok:false,error:'No executor'}]});
    await g.type('please create a task');await g.nodes.send!.event('click');
    expect(g.nodes['send-feedback']!.textContent).toContain('No executor');expect(g.nodes.input!.value).toBe('please create a task');expect(g.nodes['send-retry']!.hidden).toBe(false);expect(g.nodes['send-feedback']!.textContent).toContain('先查看任务工作台核对');expect(g.calls.filter(c=>c.path.endsWith('/message'))).toHaveLength(1);
  });
  it('only continues tasks explicitly requested by URL, consumes URL and selects conversation links',async()=>{
    const f=fixture(undefined,undefined,'?task=T-explicit');await f.settle();await f.settle();
    expect(f.calls.filter(c=>c.path==='conversations/from-task')).toHaveLength(1);
    expect(f.calls.find(c=>c.path==='conversations/from-task')!.body).toEqual({ticketId:'T-explicit'});
    expect(f.query()).not.toContain('task=');expect(f.calls.some(c=>c.path.endsWith('/message'))).toBe(false);
    const again=fixture(undefined,undefined,f.query());await again.settle();expect(again.calls.some(c=>c.path==='conversations/from-task')).toBe(false);
    const linked=fixture(undefined,undefined,'?conversation=b');await linked.settle();expect(linked.storage.get('ordin.chat.selectedConversation')).toBe('b');
  });
  it('renders malicious task IDs as text and never HTML',async()=>{
    const attack='<img src=x onerror=alert(1)>';const f=fixture();await f.settle();f.continueFailure(attack);f.nodes['task-id']!.value=attack;await f.nodes['continue-task']!.event('click');
    expect(f.nodes['conversation-error']!.textContent).toContain(attack);expect(f.nodes['conversation-error']!.children).toHaveLength(0);expect(f.nodes['task-id']!.value).toBe(attack)
  })
  it('renders malicious user/model/title text only as textContent',async()=>{
    const attack='<img src=x onerror=alert(1)><script>attack()</script>',f=fixture([conversation('a',attack)]);await f.settle()
    await f.type(attack);await f.nodes.send!.event('click');expect(f.nodes.log!.textContent).toContain(attack);expect(f.nodes['conversation-list']!.textContent).toContain(attack)
    f.defer();await f.type('again');const pending=f.nodes.send!.event('click');await f.settle();f.release(attack);await pending
    expect(f.nodes.log!.textContent.split(attack)).toHaveLength(3)
    expect(f.nodes.log!.children.every(n=>n.children.every(c=>c.tag==='div'))).toBe(true)
  })
})