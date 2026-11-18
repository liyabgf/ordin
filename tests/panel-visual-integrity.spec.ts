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
