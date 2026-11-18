/** Attach to DSH's existing task service. Model configuration stays entirely in DSH. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { TurnChannel } from './channel.ts'
import { parseWorkerReport } from './report.ts'
import { failedResult, type BackendSession, type DriverHealth, type LaunchSpec, type RunningTurn, type WorkerDriver, type WorkerSpec, type TurnResult } from './types.ts'

export interface DshServiceDriverOptions { readonly baseUrl: string; readonly token: string; readonly timeoutMs?: number; readonly useServiceSettings?: boolean }
type State = { cursor:number; running:boolean; queue:unknown[]|null; pendingInput:unknown[] }
type Event = { type:string; seq:number; data:any }
function taskStart(events:Event[],requestId:string):Event|undefined {
  const input=events.find(e=>e.type==='user/message'&&e.data?.source?.rpcId===requestId)
    ??events.find(e=>e.type==='agent/inbox/spliced'&&Array.isArray(e.data?.inserted)&&e.data.inserted.some((m:any)=>m?.source?.rpcId===requestId))
  if(!input)return undefined
  return input.type==='agent/inbox/spliced'?events.find(e=>e.type==='turn/start'&&e.seq>input.seq):events.filter(e=>e.type==='turn/start'&&e.seq<input.seq).at(-1)
}
function assistantText(event: Event): string {
  const content = event.data?.message?.content
  return Array.isArray(content) ? content.filter((b:any) => b?.type === 'text' && typeof b.text === 'string').map((b:any) => b.text).join('') : ''
}
export class DshServiceDriver implements WorkerDriver {
  readonly backend = 'dsh' as const
  private readonly base:string
  private readonly prefix:string
  private cookie?:string
  private authenticating?:Promise<void>
  constructor(private readonly options:DshServiceDriverOptions) {
    const u=new URL(options.baseUrl)
    if(u.username || u.password || u.search || u.hash || u.pathname!=='/' || !['http:','https:'].includes(u.protocol)) throw Error('DSH service URL must be an origin without credentials or path')
    if(u.protocol==='http:' && !['127.0.0.1','localhost','[::1]'].includes(u.hostname)) throw Error('Remote DSH service requires HTTPS')
    this.base=u.origin
    this.prefix='service:'+encodeURIComponent(this.base)+':'
    if(!options.token.trim() || /[\r\n]/.test(options.token)) throw Error('DSH service access token is required')
    if(options.timeoutMs!==undefined && (!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<=0)) throw Error('Invalid DSH timeout')
  }
  private message(error:unknown):string {
    return (error instanceof Error?error.message:String(error)).split(this.options.token).join('[redacted]').split(encodeURIComponent(this.options.token)).join('[redacted]')
  }
  private async authenticate():Promise<void> {
    if(this.cookie) return
    if(this.authenticating) return this.authenticating
    this.authenticating=(async()=>{
      const u=new URL('/connect',this.base); u.searchParams.set('token',this.options.token);u.searchParams.set('interactions','none')
      const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(10000)})
      if(r.status!==302) throw Error('DSH service authentication failed (HTTP '+r.status+')')
      const cookies=r.headers.getSetCookie().map(v=>v.split(';')[0]).filter(Boolean)
      if(!cookies.length) throw Error('DSH service authentication returned no API cookie')
      this.cookie=cookies.join('; ')
    })()
    try { await this.authenticating } finally { this.authenticating=undefined }
  }
  private async rpc(method:string,request:unknown,timeoutMs=15000):Promise<any> {
    await this.authenticate()
    const rpcId=randomUUID()
    const r=await fetch(this.base+'/api/session/'+method,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:this.cookie!},body:JSON.stringify({type:'client-request',rpcId,method:'session/'+method,payload:{args:method==='list'?{_request:request}:{request}}}),signal:AbortSignal.timeout(timeoutMs)})
    if(!r.ok) { if(r.status===401)this.cookie=undefined;throw Error('DSH '+method+' failed (HTTP '+r.status+'); request was not replayed') }
    const b:any=await r.json()
    if(b.type!=='server-response'||b.rpcId!==rpcId||typeof b.result?.ok!=='boolean') throw Error('Invalid DSH RPC response')
    if(!b.result.ok) throw Error('DSH '+method+': '+(b.result.error?.message??'request rejected'))
    return b.result.value
  }
  async probe():Promise<DriverHealth> {
    const checkedAt=new Date().toISOString()
    try { const v=await this.rpc('list',{});if(!Array.isArray(v?.items))throw Error('DSH session/list contract unavailable');return {backend:'dsh',ok:true,checkedAt,binary:this.base,auth:'ok',problems:[],warnings:['DSH service owns model and permissions; service access verified, execution requires a task receipt']} }
    catch(e){return {backend:'dsh',ok:false,checkedAt,binary:this.base,auth:'unknown',problems:[this.message(e)]}}
  }
  async prepare(spec:WorkerSpec,session?:BackendSession):Promise<LaunchSpec> {
    if(!this.options.useServiceSettings && spec.access!=='full')throw Error('DSH service cannot guarantee per-task read/edit permissions; no permission downgrade performed')
    if(!this.options.useServiceSettings && (spec.model?.trim() || spec.effort?.trim()))throw Error('DSH service owns its model selection; remove Ordin Worker model override')
    if(!isAbsolute(spec.cwd)||!spec.prompt.trim())throw Error('Absolute task directory and nonempty prompt are required')
    if(session)this.sessionId(session,spec)
    return {...spec,preparedAt:new Date().toISOString()}
  }
  private sessionId(session:BackendSession,spec:WorkerSpec):string {
    if(session.backend!=='dsh'||!session.id.startsWith(this.prefix)||session.cwd!==spec.cwd)throw Error('Session belongs to another DSH transport, endpoint or directory; automatic adoption refused')
    const id=session.id.slice(this.prefix.length);if(!id)throw Error('Missing DSH Session ID');return id
  }
  private state(v:any):State {
    if(!Number.isSafeInteger(v?.cursor)||v.cursor< -1||typeof v.running!=='boolean'||!(v.queue===null||Array.isArray(v.queue))||!Array.isArray(v.pendingInput))throw Error('Invalid DSH task state')
    return v
  }
  launch(spec:LaunchSpec):Promise<RunningTurn>{return this.start(spec)}
  resume(session:BackendSession,spec:LaunchSpec):Promise<RunningTurn>{this.sessionId(session,spec);return this.start(spec,session)}
  private async start(spec:LaunchSpec,resume?:BackendSession):Promise<RunningTurn> {
    await this.prepare(spec,resume)
    const channel=new TurnChannel(), id='dsh-service-'+randomUUID()
    let session=resume, rawId:string|undefined, stopping=false, settled=false, cancelPromise:Promise<void>|undefined
    const now=()=>new Date().toISOString()
    const deadline=Date.now()+(this.options.timeoutMs??1800000)
    const cancel=():Promise<void>=>cancelPromise??=(async()=>{
      stopping=true
      await ready
      if(!rawId)return
      const ack=await this.rpc('cancel',{sessionId:rawId})
      if(ack?.accepted!==true)throw Error('DSH did not acknowledge cancellation')
      const v=await this.rpc('wait',{sessionId:rawId,timeoutMs:5000,maxMessages:1},7000)
      const state=this.state(v.state)
      if(state.running||state.queue?.length||state.pendingInput.length)throw Error('DSH cancellation not confirmed quiescent; inspect task in DSH')
    })()
    let resolveReady!:()=>void
    const ready=new Promise<void>(r=>{resolveReady=r})
    const done=(async():Promise<TurnResult>=>{
      let result:TurnResult
      try {
        const created=resume?{sessionId:this.sessionId(resume,spec)}:await this.rpc('create',{cwd:spec.cwd})
        if(typeof created?.sessionId!=='string'||!created.sessionId)throw Error('DSH returned no Session ID')
        rawId=created.sessionId;session={backend:'dsh',id:this.prefix+rawId,cwd:spec.cwd,savedAt:now()}
        const before=this.state(await this.rpc('state',{sessionId:rawId}))
        if(before.running||before.queue?.length||before.pendingInput.length)throw Error('DSH Session is busy; prompt not sent')
        resolveReady()
        if(stopping){await cancelPromise;throw Error('Cancelled before prompt admission; no task prompt sent')}
        // The same assignment can span multiple turns in one session. Never replay an uncertain request.
        const requestId='ordin-'+randomUUID()
        const ack=await this.rpc('prompt',{sessionId:rawId,requestId,mode:'queue',content:[{type:'text',text:spec.prompt}]})
        if(ack?.accepted!==true)throw Error('DSH did not accept task input')
        // Ordin records included inputs as delivered on started, not on session allocation.
        channel.push({kind:'started',at:now(),session})
        let checkedCursor = before.cursor, lastSample = -Infinity, lastPublished = before.cursor, published = 0
        const readEvents = async (cursor: number) => {
          const page = await this.rpc('events',{address:{kind:'session',sessionId:rawId},throughSeq:cursor,maxMessages:200})
          if (!Array.isArray(page?.records)) throw Error('DSH task history is unavailable')
          const events:Event[] = page.records.slice(0,200).map((r:any)=>r.event).filter((e:any)=>e&&Number.isSafeInteger(e.seq)&&e.seq>before.cursor&&e.seq<=cursor).sort((a:Event,b:Event)=>a.seq-b.seq)
          return {events, hasMore:page.hasMore}
        }
        const publish = (events: Event[], start: Event, until = Infinity) => {
          if (!Number.isSafeInteger(start.data?.turn)) return
          for (const e of events) {
            if (e.seq <= Math.max(lastPublished, start.seq) || e.seq >= until || e.data?.turn !== start.data.turn || published >= 200) continue
            if (e.type === 'assistant/message') {
              const text = assistantText(e).slice(0,1200)
              if (!text.trim()) continue
              channel.push({kind:'text',at:now(),text})
            } else if (e.type === 'tool/call' && typeof e.data?.name === 'string' && /^[a-zA-Z0-9_.:/-]{1,80}$/.test(e.data.name)) {
              channel.push({kind:'tool',at:now(),name:e.data.name})
            } else continue
            lastPublished = e.seq
            published++
          }
        }
        let progressIncomplete = false
        for(;;){
          if(Date.now()>=deadline){await cancel();result=failedResult('timeout','DSH task deadline reached; cancellation confirmed',false,session);break}
          const waitMs=Math.max(1,Math.min(1000,deadline-Date.now()))
          const w=await this.rpc('wait',{sessionId:rawId,timeoutMs:waitMs,afterSeq:before.cursor,maxMessages:200},waitMs+10000)
          const state=this.state(w.state)
          if(stopping){await cancelPromise;result=failedResult('cancelled','DSH cancellation confirmed',false,session);break}
          if(w.reason==='input-required'||state.pendingInput.length){result=failedResult('backend_error','DSH needs approval or an answer in its own interface; task is not complete',false,session);break}
          if(w.reason==='timeout'){
            if(state.cursor > checkedCursor && Date.now()-lastSample >= 750) {
              lastSample=Date.now()
              try {
                const {events,hasMore}=await readEvents(state.cursor)
                const start=taskStart(events,requestId)
                if(hasMore||events.length&&(events[0]!.seq>checkedCursor+1||events.length>=200)){progressIncomplete=true;channel.push({kind:'error',at:now(),error:{code:'protocol_error',message:'DSH progress history is incomplete; final receipt will be checked independently',retryable:false}})}
                if(start&&!stopping)publish(events,start,events.find(e=>e.type==='turn/end'&&e.data?.turn===start.data?.turn)?.seq)
                checkedCursor=state.cursor
              } catch { progressIncomplete=true;channel.push({kind:'error',at:now(),error:{code:'protocol_error',message:'DSH progress history is incomplete or could not be refreshed; final receipt will be checked independently',retryable:false}}) }
            }
            continue
          }
          if(w.reason!=='idle'||state.running||state.queue?.length)throw Error('DSH returned inconsistent stopping state')
          const {events,hasMore}=await readEvents(state.cursor)
          if(hasMore && (!events.length||events[0]!.seq>before.cursor+1||events.length>=200))throw Error('DSH history window incomplete; cannot verify this turn')
          const end=events.filter(e=>e.type==='turn/end').at(-1)
          const reason=end?.data?.reason
          const start=taskStart(events,requestId)
          if(!start || !end || start.seq>=end.seq || !Number.isSafeInteger(start.data?.turn) || start.data.turn!==end.data?.turn)throw Error('DSH receipt is not correlated to the submitted task request')
          if(reason?.kind!=='completed'){result=failedResult('backend_error',reason?.error?.message??'DSH has no completed turn receipt',false,session);break}
          const text=events.filter(e=>e.type==='assistant/message'&&e.seq>start.seq&&e.seq<end.seq&&e.data?.turn===end.data?.turn).map(assistantText).filter(Boolean).join('\n')
          if(!text.trim())throw Error('DSH completed without task output')
          const parsed=parseWorkerReport(text,now())
          if(parsed.kind==='invalid')throw Error('Invalid DSH task report: '+parsed.error)
          publish(events,start,end.seq)
          if(progressIncomplete){const note='（进度记录不完整：事件窗口有缺口；最终回执完整）';if(parsed.kind==='valid')channel.push({kind:'report',at:now(),report:{...parsed.report,summary:parsed.report.summary+note}});channel.push({kind:'text',at:now(),text:note})}
          else if(parsed.kind==='valid')channel.push({kind:'report',at:now(),report:parsed.report})
          result={status:'completed',text,session};break
        }
      }catch(e){result=failedResult('protocol_error',this.message(e),false,session)}
      finally{resolveReady()}
      settled=true;channel.push({kind:'final',at:now(),result});channel.close();return result
    })()
    return {id,backend:'dsh',events:channel.iterable,done,feed:async()=>({status:'queued-for-next-turn',reason:'Input remains in Ordin until an explicit DSH turn can accept it'}),cancel:async()=>{if(!settled)await cancel()}}
  }
}
