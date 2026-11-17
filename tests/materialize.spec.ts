import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeSkills, skillsPrompt } from '../src/app/materialize.ts'
import type { SavedSkill } from '../src/app/prompts.ts'
import { tempDir } from './helpers/temp.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const skill = (name: string, content = 'OLD', enabled = true): SavedSkill => ({ name, title: name, description: 'craft', content, revision: 1, contentHash: hash(content), enabled, createdAt: '', updatedAt: '', useCount: 0 })
const ref = (s: SavedSkill) => ({ name: s.name, revision: s.revision!, contentHash: s.contentHash! })

describe('skill materialization', () => {
  it('migrates absent selection to no custom skills', async () => {
    const dir = tempDir('ordin-materialize-none-')
    expect(await materializeSkills([skill('unselected')], dir)).toEqual([])
    expect(existsSync(join(dir, 'skills'))).toBe(false)
  })
  it('intentionally replaces all-enabled projection with exact selected content', async () => {
    const dir = tempDir('ordin-materialize-')
    const selected = skill('selected')
    const written = await materializeSkills([selected, skill('other')], dir, [ref(selected)])
    expect(written).toEqual([{ ...ref(selected), path: join(dir, 'skills', 'selected', 'r1-' + selected.contentHash, 'SKILL.md') }])
    expect(readFileSync(written[0]!.path, 'utf8')).toBe('OLD')
    expect(existsSync(join(dir, 'skills', 'other'))).toBe(false)
    expect(skillsPrompt(written)).toContain('selected revision 1')
  })
  it('reads immutable historical bytes after a library edit, idempotently', async () => {
    const dir = tempDir('ordin-materialize-old-')
    const old = skill('selected')
    const latest = { ...old, revision: 2, content: 'NEW', contentHash: hash('NEW'), history: [{ revision: 1, contentHash: old.contentHash!, content: old.content, title: old.title, description: old.description, createdAt: '' }] }
    const [written] = await materializeSkills([latest], dir, [ref(old)])
    expect(readFileSync(written!.path, 'utf8')).toBe('OLD')
    expect(await materializeSkills([latest], dir, [ref(old)])).toEqual([written])
    writeFileSync(written!.path, 'BAD')
    await expect(materializeSkills([latest], dir, [ref(old)])).rejects.toThrow(/overwrite/)
    expect(readFileSync(written!.path, 'utf8')).toBe('BAD')
  })
  it('rejects unknown, disabled, bad hash, revision and duplicate selection before writes', async () => {
    const s = skill('selected')
    const dir = tempDir('ordin-materialize-reject-')
    for (const [catalog, refs] of [ [[], [ref(s)]], [[{ ...s, enabled: false }], [ref(s)]], [[s], [{ ...ref(s), contentHash: hash('wrong') }]], [[s], [{ ...ref(s), revision: 9 }]], [[s], [ref(s), ref(s)]], [[s], [{ ...ref(s), name: '../escape' }]] ] as const) {
      await expect(materializeSkills(catalog, dir, refs)).rejects.toThrow()
    }
    expect(existsSync(join(dir, 'skills'))).toBe(false)
  })
  it('refuses symlink directory and file escapes without touching user files', async () => {
    const s = skill('selected')
    const outside = tempDir('ordin-materialize-outside-')
    const dir = tempDir('ordin-materialize-link-')
    symlinkSync(outside, join(dir, 'skills'))
    await expect(materializeSkills([s], dir, [ref(s)])).rejects.toThrow(/symbolic link/)
    expect(existsSync(join(outside, s.name))).toBe(false)
    const other = tempDir('ordin-materialize-filelink-')
    const target = join(other, 'skills', s.name, 'r1-' + s.contentHash)
    mkdirSync(target, { recursive: true })
    const user = join(outside, 'user.txt')
    writeFileSync(user, 'USER')
    symlinkSync(user, join(target, 'SKILL.md'))
    await expect(materializeSkills([s], other, [ref(s)])).rejects.toThrow(/overwrite/)
    expect(readFileSync(user, 'utf8')).toBe('USER')
  })
})
