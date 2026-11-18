import {it,expect} from 'vitest'
import {createServer} from 'node:http'
import {join} from 'node:path'
import {boot} from '../src/app/boot.ts'
import {resolveConfig} from '../src/app/config.ts'
import {silentLogger} from '../src/app/logger.ts'
import {ProcessRegistry} from '../src/app/process.ts'
import {createRuntime} from '../src/app/runtime.ts'
import {AssetObjects} from '../src/app/asset-objects.ts'
import {tempDir} from './helpers/temp.ts'
import type {WorkerDriver} from '../src/drivers/types.ts'
it('passes operator pins through real HTTP and model rounds into persistent task references',async()=>{
  const upstream=createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(Buffer.from(part));const body=JSON.parse(Buffer.concat(chunks).toString());
    const toolRound=body.messages.some((m:any)=>m.role==='tool');
    res.setHeader('content-type','text/event-stream');
    const delta=toolRound?{content:'已创建'}:{tool_calls:[{index:0,id:'create-one',type:'function',function:{name:'create_task',arguments:JSON.stringify({title:'Pinned consumer',text:'read selected data',assetRefs:[]})}}]};
    res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:toolRound?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  const stateDir=tempDir('ordin-selected-http-');
  const driver={backend:'dsh',probe:async()=>({backend:'dsh',ok:false,checkedAt:new Date().toISOString(),auth:'unknown',problems:['isolated']})} as unknown as WorkerDriver;
  const runtime=createRuntime(boot({config:resolveConfig({stateDir,workRoot:join(stateDir,'work'),inboxDir:join(stateDir,'inbox'),port:0}),logger:silentLogger()}),{logger:silentLogger(),driver,proc:new ProcessRegistry(),notifier:null});
  try{
    runtime.saveSettings({acceptMode:'auto'});await runtime.start();await runtime.saveModelConfig({baseUrl:'http://127.0.0.1:'+(upstream.address() as any).port+'/v1',model:'fixture',provider:'OpenAI compatible',apiKey:'fake-test-key',models:['fixture'],temperature:0.2,maxTokens:512,apiKeyEnv:''});
    const bytes=Buffer.from([0,255,1,2]),blob=await new AssetObjects(stateDir).put(bytes),at=new Date().toISOString();
    runtime.store.assets.save({id:'http-pinned',kind:'dataset',name:'Input.bin',createdAt:at,updatedAt:at,archived:false,status:'active',ownerProfileId:'default',storageVersion:1,storage:{kind:'managed-object',...blob},revision:1,contentHash:blob.objectKey,source:{ticketId:'removed-task',path:'input.bin'}} as any);
    const ref={id:'http-pinned',revision:1,contentHash:blob.objectKey};
    const send=(assetRefs:unknown)=>fetch(runtime.status().panel+'api/conversations/pinned-conv/message',{method:'POST',headers:{'x-ordin-request':'1','content-type':'application/json'},body:JSON.stringify({text:'创建任务',assetRefs})});
    expect((await send([{...ref,revision:0}])).status).toBe(400);
    const response=await send([ref]);expect(response.status).toBe(200);const result=await response.json() as any;expect(result.toolOutcomes[0],JSON.stringify(result)).toMatchObject({ok:true});
    const ticket=runtime.store.tickets.get(result.toolOutcomes[0].data.ticketId)!;expect(ticket.assetRefs).toEqual([ref]);expect(ticket.attachments).toEqual([]);
    const count=runtime.store.tickets.list().length;expect((await send([{...ref,contentHash:'0'.repeat(64)}])).status).not.toBe(200);expect(runtime.store.tickets.list()).toHaveLength(count);
  }finally{await runtime.stop();await new Promise<void>((r,j)=>upstream.close(e=>e?j(e):r()))}
})
