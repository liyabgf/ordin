import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export interface ModelDraft {
  baseUrl: string
  model: string
  provider: string
  temperature: number
  maxTokens: number
  apiKeyEnv: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface StoredModelCredential { apiKey?: string }

export async function modelCredentialStatus(stateDir: string, envName: string): Promise<{ local: boolean; env: boolean }> {
  const local = await new ModelCredentials(stateDir).configured()
  return { local, env: envName !== '' && Boolean(process.env[envName]) }
}

export function validateModelInput(value: unknown, requireModel = true): ModelDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('A model configuration object is required')
  const input = value as Record<string, unknown>
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  let url: URL | undefined
  try { url = new URL(baseUrl) } catch { /* reported below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseUrl must be an http(s) URL without credentials, query, or fragment')
  if (typeof input.model !== 'string' || (requireModel && input.model.trim() === '') || input.model.length > 200) throw new Error('model must be a non-empty string of at most 200 characters')
  if (typeof input.provider !== 'string' || input.provider.length > 100) throw new Error('provider must be a string of at most 100 characters')
  if (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) throw new Error('temperature must be between 0 and 2')
  if (!Number.isInteger(input.maxTokens) || (input.maxTokens as number) < 1 || (input.maxTokens as number) > 32000) throw new Error('maxTokens must be an integer between 1 and 32000')
  if (typeof input.apiKeyEnv !== 'string' || !/^$|^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv)) throw new Error('apiKeyEnv must be an environment variable name or empty')
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || /[^\x20-\x7e]/.test(input.apiKey))) throw new Error('apiKey must be a string without newlines or NUL')
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new Error('clearApiKey must be boolean')
  return { baseUrl: url.toString().replace(/\/$/, ''), model: (input.model as string).trim(), provider: input.provider.trim(), temperature: input.temperature, maxTokens: input.maxTokens as number, apiKeyEnv: input.apiKeyEnv, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }), ...(input.clearApiKey === true ? { clearApiKey: true } : {}) }
}

export class ModelCredentials {
  private readonly path: string
  constructor(stateDir: string) { this.path = join(stateDir, 'model-credentials.json') }
  async read(): Promise<StoredModelCredential> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).apiKey !== 'string') return {}
      return { apiKey: (parsed as { apiKey: string }).apiKey }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('Could not read model credentials file')
    }
  }
  async configured(): Promise<boolean> { return Boolean((await this.read()).apiKey) }
  async save(apiKey: string | undefined): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    if (apiKey === undefined || apiKey === '') { await rm(this.path, { force: true }); return }
    const temp = join(dirname(this.path), '.model-credentials-' + randomUUID())
    try {
      await writeFile(temp, JSON.stringify({ apiKey }) + '\n', { mode: 0o600, flag: 'wx' })
      await chmod(temp, 0o600)
      await rename(temp, this.path)
      await chmod(this.path, 0o600)
    } catch {
      await rm(temp, { force: true }).catch(() => {})
      throw new Error('Could not save model credentials')
    }
  }
}

export function resolveModelKey(local: string | undefined, envName: string): string | undefined {
  // A saved local key wins; explicitly clearing it restores the named environment fallback.
  const key = local || (envName ? process.env[envName] || undefined : undefined)
  if (key && /[^\x20-\x7e]/.test(key)) throw new Error('Model API key contains invalid header characters')
  if (!key && envName) throw new Error('The named model API key environment variable is not set')
  return key
}
