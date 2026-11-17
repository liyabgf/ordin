/**
 * 骨架自检：让"工程与纪律落盘"成为可执行断言，而不是自觉（纪律 0.2、1.1）。
 * 后续每迁入一批代码，就在这里或新 spec 里加上对应的验收断言。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { status } from '../src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('工程骨架', () => {
  it('包名与运行时入口是 ordin', () => {
    expect(JSON.parse(read('package.json')).name).toBe('ordin')
    expect(JSON.parse(read('package.json')).scripts.start).toContain('--experimental-transform-types')
    expect(status()).toContain('组合根已接入')
  })

  it('五份核心文档齐全', () => {
    for (const doc of ['00-vision.md', '01-current-goal.md', '02-execution-discipline.md', '03-architecture.md', '10-migration-plan.md']) {
      expect(existsSync(join(root, 'docs', doc)), doc).toBe(true)
    }
  })

  it('README 里的相对链接都能解析到真实文件（文档与代码不得漂移）', () => {
    const links = [...read('README.md').matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)].map(m => m[1]!)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      if (/^https?:/.test(link)) continue
      expect(existsSync(join(root, link)), link).toBe(true)
    }
  })

  it('纪律文件齐备：AGENTS.md 正典 + 事故登记 + 操作账本', () => {
    expect(read('AGENTS.md')).toContain('执行纪律')
    expect(read('docs/incidents.md')).toContain('O-1')
    expect(read('docs/ledger.md')).toContain('先写后做')
  })

  it('桥协议库不被根 lib 忽略规则误伤', () => {
    const rules = read('.gitignore').split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
    expect(rules).not.toContain('lib/')
    expect(rules).toContain('/lib/')
    expect(existsSync(join(root, 'bridges/lib/outbound.mjs'))).toBe(true)
  })

  it('执行驱动目录齐备（dsh / codex / claude）', () => {
    for (const d of ['dsh', 'codex', 'claude']) {
      expect(existsSync(join(root, 'src', 'drivers', d)), d).toBe(true)
    }
  })
})
