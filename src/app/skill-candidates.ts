import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Prompts, PromptConflict, type SavedSkill, type SkillValidation } from './prompts.ts'
import type { ProcessRegistry } from './process.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export interface CandidateExpectation { expectedRevision: number; expectedHash: string }

/** Syntax-only verification. Never evaluates a proposed program or imports its dependencies. */
export class SkillCandidates {
  constructor(private readonly prompts: Prompts, private readonly processes: ProcessRegistry, private readonly workRoot: string, private readonly workspace: (ticketId: string) => string | undefined, private readonly signal?: AbortSignal) {}
  async validate(name: string, input: CandidateExpectation & { argv?: readonly string[] }): Promise<SavedSkill> {
    const skill = this.require(name, input)
    if (skill.state !== 'candidate') throw new PromptConflict('Only candidate skills can be validated')
    if (input.argv !== undefined && (input.argv.length !== 3 || input.argv[0] !== process.execPath || input.argv[1] !== '--check' || input.argv[2] !== 'program.mjs')) throw new PromptConflict('Only the fixed safe syntax validation command is allowed')
    const command = [process.execPath, '--check', 'program.mjs'] as const
    const directory = this.workspace(skill.fromTicketId ?? '')
    if (!directory) throw new PromptConflict('Source Ticket workspace is unavailable')
    const root = await realpath(this.workRoot)
    const actual = await realpath(directory).catch(() => { throw new PromptConflict('Source Ticket workspace is unavailable') })
    if (!actual.startsWith(root + sep)) throw new PromptConflict('Source Ticket workspace escaped its real root')
    if (!/\.(?:mjs|js|cjs)$/.test(skill.scriptPath ?? '') || !skill.program || !skill.content.includes(skill.program.trim())) throw new PromptConflict('Only stored JavaScript candidates support syntax validation')
    const task = await mkdtemp(join(tmpdir(), 'ordin-skill-validation-'))
    try {
      await writeFile(join(task, 'program.mjs'), skill.program, { flag: 'wx', mode: 0o600 })
      // ProcessRegistry merges env: explicitly delete every inherited entry (including NODE_OPTIONS).
      const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
      env.HOME = task; env.TMPDIR = task
      const record = this.processes.spawn({ owner: skill.fromTicketId!, argv: [process.execPath, '--check', 'program.mjs'], cwd: task, env, signal: this.signal, timeoutMs: 5000, graceMs: 100, stdoutLimit: 16384, stderrLimit: 16384 })
      await this.processes.wait(record.id)
      this.require(name, input)
      const validation: SkillValidation = { kind: 'syntax', result: record.status === 'exited' && record.exitCode === 0 ? 'verified' : record.status === 'exited' ? 'failed' : 'unknown', exitCode: record.exitCode, stdoutDigest: digest(record.stdout), stderrDigest: digest(record.stderr), revision: skill.revision!, contentHash: skill.contentHash!, command, at: new Date().toISOString() }
      return this.prompts.updateSkillValidation(name, validation)
    } finally { await rm(task, { recursive: true, force: true }) }
  }
  approve(name: string, input: CandidateExpectation): SavedSkill {
    this.require(name, input)
    return this.prompts.approveSkill(name, { actor: 'operator', revision: input.expectedRevision, contentHash: input.expectedHash, at: new Date().toISOString() })
  }
  private require(name: string, input: CandidateExpectation): SavedSkill {
    const skill = this.prompts.skill(name)
    if (!skill || skill.source !== 'worker') throw new PromptConflict('Unknown candidate skill')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || skill.revision !== input.expectedRevision || skill.contentHash !== input.expectedHash || digest(skill.content) !== input.expectedHash) throw new PromptConflict('Skill content changed; expected revision and hash are required')
    return skill
  }
}
