import { readFileSync } from 'node:fs'
import { Script, runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
const page=(name:string)=>readFileSync(new URL('../panel/'+name+'.html',import.meta.url),'utf8')
describe('panel source and startup integrity',()=>{
  it('keeps complete page styles and JavaScript instead of tool output fragments',()=>{
    for(const name of ['index','chat','workspace','assets']) {
      const h=page(name)
      expect(h).not.toContain('line truncated')
      const css=h.split('<style>')[1]!.split('</style>')[0]!
      expect(css.split('{').length).toBe(css.split('}').length)
      for(const match of h.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(()=>new Script(match[1]!)).not.toThrow()
    }
  })
  it('states the actual scope of skill projection evidence',()=>{
    const h=page('index')
    expect(h).toContain('任务只会收到已选技能的固定版本文件')
    expect(h).toContain('DSH 服务：任务内固定版本文件读取已实测')
    expect(h).toContain('Codex、Claude Code：仅离线投射通过，真实读取未验证')
    expect(h).toContain('各端技能调用及原生注册未验证')
    expect(h).toContain('任务级 Tool 注册：DSH、Codex、Claude Code 均不支持。')
    expect(h).not.toContain('自动装配启用中的手艺')
  })
  it('allows early chat navigation before asynchronous state exists',()=>{
    const h=page('index')
    for(const name of ['renderChat','renderPlatformGuide']) {
      const start=h.indexOf('  const '+name+' = () => {')
      const body=h.slice(start,h.indexOf('\n  }',start)+4)
      const fn=runInNewContext(body+';'+name,{state:null})
      expect(()=>fn()).not.toThrow()
    }
  })
})
