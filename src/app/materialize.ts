/** Per-Ticket immutable custom skill snapshots; absence of selection means none. */
import { createHash } from 'node:crypto'
import { mkdir, lstat, realpath, open, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { validateSkillRefs, type SkillRef } from '../core/model.ts'
import type { SavedSkill } from './prompts.ts'

export interface MaterializedSkill extends SkillRef { readonly path: string }

/** Resolve only explicitly pinned versions; metadata disables all revisions at launch. */
export function resolveSkills(skills: readonly SavedSkill[], refs: readonly SkillRef[]): { ref: SkillRef; content: string }[] {
  return validateSkillRefs(refs).map(ref => {
    const skill = skills.find(item => item.name === ref.name)
    if (skill === undefined || !skill.enabled) throw new Error('Skill unknown or disabled: ' + ref.name)
    const snapshot = skill.history?.find(item => item.revision === ref.revision)
      ?? (skill.revision === ref.revision ? skill : undefined)
    if (snapshot === undefined) throw new Error('Skill revision unavailable: ' + ref.name)
    if (snapshot.contentHash !== ref.contentHash || createHash('sha256').update(snapshot.content).digest('hex') !== ref.contentHash) throw new Error('Skill hash mismatch: ' + ref.name)
    return { ref, content: snapshot.content }
  })
}

async function checkedDirectory(path: string): Promise<void> {
  try { await mkdir(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refused skill directory symbolic link or non-directory: ' + path)
}

export async function materializeSkills(skills: readonly SavedSkill[], workspaceDir: string, refs: readonly SkillRef[] = []): Promise<MaterializedSkill[]> {
  const selected = resolveSkills(skills, refs)
  if (selected.length === 0) return []
  const suppliedRoot = resolve(workspaceDir)
  const rootInfo = await lstat(suppliedRoot)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Refused skill workspace symbolic link or non-directory')
  // Canonicalize host aliases such as macOS /var before checking every segment below the workspace.
  const root = await realpath(suppliedRoot)
  const realRoot = root
  const result: MaterializedSkill[] = []
  for (const { ref, content } of selected) {
    let dir = root
    for (const segment of ['skills', ref.name, 'r' + ref.revision + '-' + ref.contentHash]) {
      dir = join(dir, segment)
      await checkedDirectory(dir)
      const rel = relative(realRoot, await realpath(dir))
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Refused skill path escape')
    }
    const path = join(dir, 'SKILL.md')
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(content, 'utf8') } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await lstat(path)
      if (!existing.isFile() || existing.isSymbolicLink() || await readFile(path, 'utf8') !== content) throw new Error('Refused to overwrite changed skill content: ' + path)
    }
    result.push({ ...ref, path: join(suppliedRoot, relative(root, path)) })
  }
  return result
}

export function skillsPrompt(materialized: readonly MaterializedSkill[]): string {
  if (materialized.length === 0) return ''
  return ['<skills>', ...materialized.map(skill => '- ' + skill.name + ' revision ' + skill.revision + ': ' + skill.path), '</skills>', ''].join('\n')
}
