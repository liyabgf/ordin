import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prompts } from '../src/app/prompts.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { SkillCandidates } from '../src/app/skill-candidates.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function prompts() {
  const values = new Map<string, unknown>()
  return new Prompts({ get: <T>(key: string) => values.get(key) as T | undefined, set: (key: string, value: unknown) => { values.set(key, value) }, atomic: <T>(run: () => T) => run(), afterCommit: (run: () => void) => run() })
}
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(code = 'console.log("never execute");') {
  const root = await mkdtemp(join(tmpdir(), 'ordin-candidate-test-')); roots.push(root)
  const workspace = join(root, 'task'); await mkdir(workspace)
  const p = prompts(); const proc = new ProcessRegistry()
  const service = new SkillCandidates(p, proc, root, () => workspace)
  const skill = p.saveSkillCandidate({ name: 'candidate', title: 'Candidate', description: 'test', content: '# Candidate\n' + code, fromTicketId: 'ticket-1', scriptPath: 'tool.mjs', program: code })
  const expected = { expectedRevision: skill.revision!, expectedHash: skill.contentHash! }
  return { p, proc, service, skill, expected, root, workspace }
}
describe('candidate validation and explicit approval', () => {
  it('starts disabled, cannot toggle around approval, checks without executing and approves exact evidence', async () => {
    const f = await fixture('throw new Error("would fail if executed");')
    expect(f.skill.enabled).toBe(false); expect(f.skill.state).toBe('candidate')
    expect(f.skill.fromTicketId).toBe('ticket-1'); expect(f.skill.contentHash).toBe(hash(f.skill.content))
    expect(() => f.p.setSkillEnabled(f.skill.name, true)).toThrow(/approval/i)
    expect(() => f.service.approve(f.skill.name, f.expected)).toThrow(/verified/i)
    const checked = await f.service.validate(f.skill.name, f.expected)
    expect(checked.validation).toMatchObject({ result: 'verified', exitCode: 0, stdoutDigest: hash(''), revision: 1, contentHash: f.skill.contentHash })
    expect(checked.enabled).toBe(false)
    const approved = f.service.approve(f.skill.name, f.expected)
    expect(approved.enabled).toBe(true); expect(approved.state).toBe('active')
    expect(approved.approval).toMatchObject({ actor: 'operator', revision: 1, contentHash: f.skill.contentHash })
    const record = f.proc.list()[0]!; expect(record.owner).toBe('ticket-1'); expect(record.status).toBe('exited')
  })
  it('records failure, rejects shell/network/arbitrary command forms and stale/unknown evidence', async () => {
    const f = await fixture('const = ;')
    for (const argv of [['sh', '-c', 'true'], ['curl', 'https://example.com'], [process.execPath, '-e', 'fetch("https://example.com")']]) {
      await expect(f.service.validate(f.skill.name, { ...f.expected, argv })).rejects.toThrow(/fixed/i)
    }
    expect(f.proc.list()).toHaveLength(0)
    const checked = await f.service.validate(f.skill.name, f.expected)
    expect(checked.validation?.result).toBe('failed'); expect(checked.validation?.exitCode).toBe(1)
    expect(() => f.service.approve(f.skill.name, f.expected)).toThrow(/verified/i)
    expect(() => f.service.approve('unknown', f.expected)).toThrow()
    expect(() => f.service.approve(f.skill.name, { ...f.expected, expectedHash: '0'.repeat(64) })).toThrow(/changed/i)
  })
  it('invalidates validation on content edits and rejects escaped workspaces', async () => {
    const f = await fixture()
    await f.service.validate(f.skill.name, f.expected)
    const changed = f.p.saveSkill({ name: f.skill.name, title: 'Changed', description: 'edit', content: '# changed', enabled: true })
    expect(changed.enabled).toBe(false); expect(changed.validation).toBeUndefined()
    expect(() => f.service.approve(f.skill.name, f.expected)).toThrow(/changed/i)
    const outside = await mkdtemp(join(tmpdir(), 'ordin-candidate-outside-')); roots.push(outside)
    await rm(f.workspace, { recursive: true }); await symlink(outside, f.workspace)
    await expect(f.service.validate(f.skill.name, { expectedRevision: changed.revision!, expectedHash: changed.contentHash!, argv: [process.execPath, '--check', 'program.mjs'] })).rejects.toThrow(/workspace/i)
  })
  it('records unknown cancellation and passes timeout, output caps, and sanitized environment', async () => {
    const f = await fixture()
    const controller = new AbortController(); controller.abort()
    const service = new SkillCandidates(f.p, f.proc, f.root, () => f.workspace, controller.signal)
    const spy = vi.spyOn(f.proc, 'spawn')
    const checked = await service.validate(f.skill.name, f.expected)
    expect(checked.validation).toMatchObject({ kind: 'syntax', result: 'unknown', exitCode: null })
    expect(() => service.approve(f.skill.name, f.expected)).toThrow(/verified/i)
    const spec = spy.mock.calls[0]![0]
    expect(spec).toMatchObject({ timeoutMs: 5000, stdoutLimit: 16384, stderrLimit: 16384 })
    for (const key of Object.keys(process.env)) if (key !== 'HOME' && key !== 'TMPDIR') expect(spec.env?.[key]).toBeUndefined()
    expect(spec.env?.HOME).toBe(spec.cwd)
    f.p.save({ skills: { [f.skill.name]: { ...f.skill, enabled: true, state: 'active' } } })
    expect(f.p.skill(f.skill.name)?.enabled).toBe(false)
    expect(() => f.p.setSkillEnabled(f.skill.name, true)).toThrow(/approval/i)
  })
  it('keeps legacy manual saves and toggles compatible', () => {
    const p = prompts(); const saved = p.saveSkill({ name: 'legacy', title: 'Legacy', description: 'manual', content: 'body' })
    expect(saved.enabled).toBe(true); expect(p.setSkillEnabled(saved.name, false).enabled).toBe(false)
    expect(p.setSkillEnabled(saved.name, true).enabled).toBe(true)
  })
})
