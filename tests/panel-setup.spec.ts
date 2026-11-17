import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
const html=readFileSync(new URL('../panel/index.html',import.meta.url),'utf8')
function between(start:string,end:string){return html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)))}
function node():any {return {value:'',checked:false,disabled:false,hidden:false,textContent:'',children:[],appendChild(child:any){this.children.push(child)},replaceChildren(...children:any[]){this.children=children},addEventListener(_event:string,fn:any){this.click=fn}}}
function fixture(){
 const nodes:Record<string,any>={};for(const id of ['desk-provider','desk-base-url','desk-default-model','desk-api-key','desk-clear-api-key','desk-api-key-env','desk-temperature','desk-max-tokens','desk-save-config','desk-save-models','desk-config-hint','desk-selected-count','desk-list-models','desk-test-connection','desk-model-test-status','desk-model-list'])nodes[id]=node()
 let settings:any={deskLlm:{baseUrl:'https://llm.test/v1',model:'a',models:['a'],provider:'custom',temperature:0,maxTokens:4096,apiKeyEnv:''}}
 const api=vi.fn(async(route:string,options?:any):Promise<any>=>{if(route==='state')return {settings};if(route==='model/models')return {models:['a','b','c']};if(route==='model/test')return {model:'a',ok:true};if(route==='model/config'){if(options?.method==='PUT')settings={deskLlm:JSON.parse(options.body)};return {configuredKey:true}}throw Error(route)})
 const context={window:{},$:(id:string)=>nodes[id],document:{createElement:node},api,toast:vi.fn()}
 const handlers=runInNewContext(between('  let modelCandidates =','  window.__initDeskTab = initDeskTab')+';({loadDeskConfig,initModelSettings})',context)
 return {nodes,api,handlers,context}
}
describe('model library selection and saving',()=>{
 it('loads saved selection and zero temperature without revealing key',async()=>{const f=fixture();await f.handlers.loadDeskConfig();expect(f.nodes['desk-default-model'].value).toBe('a');expect(f.nodes['desk-temperature'].value).toBe('0');expect(f.nodes['desk-api-key'].value).toBe('');expect(f.nodes['desk-selected-count'].textContent).toContain('已保存')})
 it('fetches candidates without overwriting saved choices, then explicitly saves selected subset',async()=>{const f=fixture();await f.handlers.loadDeskConfig();f.handlers.initModelSettings();await f.nodes['desk-list-models'].click();expect(f.nodes['desk-model-list'].children).toHaveLength(3);expect(f.nodes['desk-save-models'].disabled).toBe(true);const checkbox=f.nodes['desk-model-list'].children[1].children[0];checkbox.checked=true;checkbox.onchange();expect(f.nodes['desk-selected-count'].textContent).toContain('尚未保存');await f.nodes['desk-save-models'].onclick();const write=f.api.mock.calls.find(c=>c[1]?.method==='PUT')!;expect(JSON.parse(write[1].body).models).toEqual(['a','b']);expect(f.nodes['desk-config-hint'].textContent).toContain('已保存 2');await f.handlers.loadDeskConfig();expect(f.nodes['desk-model-list'].children).toHaveLength(2)})
 it('saves default separately and preserves selection on failure',async()=>{const f=fixture();await f.handlers.loadDeskConfig();f.handlers.initModelSettings();f.nodes['desk-api-key'].value='test-secret';await f.nodes['desk-save-config'].onclick();expect(f.nodes['desk-api-key'].value).toBe('');f.api.mockRejectedValue(new Error('offline'));await f.nodes['desk-save-models'].onclick();expect(f.nodes['desk-config-hint'].textContent).toContain('offline');expect(f.nodes['desk-save-models'].disabled).toBe(false)})
 it('tests the selected default using current draft',async()=>{const f=fixture();await f.handlers.loadDeskConfig();f.handlers.initModelSettings();await f.nodes['desk-test-connection'].click();expect(f.nodes['desk-model-test-status'].textContent).toContain('连接成功');const call=f.api.mock.calls.find(c=>c[0]==='model/test')!;expect(JSON.parse(call[1].body).model).toBe('a')})
  it('navigates by a real tab click to embedded chat without changing the address or reloading it', () => {
    const nodes:Record<string,any>={}
    const chatButton={dataset:{tab:'chat'},setAttribute:vi.fn(),addEventListener:vi.fn()}
    nodes.tabs={children:[chatButton],querySelectorAll:()=>[chatButton]}; nodes['more-nav']={open:false}
    for(const id of ['overview','about','tickets','works','new','decisions','chat','settings','desk','prompts']) nodes['tab-'+id]={classList:{toggle:vi.fn()}}
    let src=''
    nodes['chat-frame']={getAttribute:()=>src,setAttribute:vi.fn((_key:string,value:string)=>{src=value})}
    const location={href:'http://ordin.test/ordin/',hash:''}
    const context:any={$:(id:string)=>nodes[id],window:{},location,localStorage:{setItem:vi.fn()},renderChat:vi.fn(),renderPlatformPick:vi.fn(),stopPolling:vi.fn()}
    const navStart=html.indexOf("  for (const button of $('tabs').querySelectorAll('button[data-tab]')) button.addEventListener('click'")
    const navBinding=html.slice(navStart,html.indexOf('\n',navStart))
    runInNewContext(between('  const show = name => {','  /** A notification or deep link')+'\n'+navBinding,context)
    const click=chatButton.addEventListener.mock.calls[0]![1]
    click();click()
    expect(nodes['tab-chat'].classList.toggle).toHaveBeenCalledWith('hidden',false)
    expect(nodes['tab-overview'].classList.toggle).toHaveBeenCalledWith('hidden',true)
    expect(chatButton.setAttribute).toHaveBeenCalledWith('aria-selected','true')
    expect(nodes['chat-frame'].setAttribute).toHaveBeenCalledTimes(1)
    expect(src).toBe('/ordin/chat')
    expect(location.href).toBe('http://ordin.test/ordin/')
  })
})
