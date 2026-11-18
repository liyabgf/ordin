import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const MAX_FILE_SIZE = 32 * 1024 * 1024
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const hasCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code

/** Immutable content-addressed bytes, independent of the execution directory. */
export class AssetObjects {
  private stateDir: string
  constructor(stateDir: string) { this.stateDir = resolve(stateDir) }
  private get root(): string { return join(this.stateDir, 'asset-objects') }

  async put(bytes: Buffer): Promise<{ objectKey: string; size: number }> {
    if (bytes.length > MAX_FILE_SIZE) throw new Error('Managed asset exceeds 32 MiB')
    await this.ensureDirectory()
    const objectKey = digest(bytes)
    const target = join(this.root, objectKey)
    try {
      await lstat(target)
      await this.verify(objectKey, bytes.length)
      return { objectKey, size: bytes.length }
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    const temp = join(this.root, '.tmp-' + randomBytes(16).toString('hex'))
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      try { await link(temp, target) } catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
      await this.verify(objectKey, bytes.length)
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      await handle.close()
      await unlink(temp)
    }
    return { objectKey, size: bytes.length }
  }

  async read(key: string): Promise<Buffer> {
    if (key.length !== 64 || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid managed object key')
    await this.ensureDirectory()
    const handle = await open(join(this.root, key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_FILE_SIZE) throw new Error('Managed object is not a bounded regular file')
      // Fixed allocation and bounded reads also reject a file that grows during reading.
      const bytes = Buffer.alloc(info.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (bytesRead === 0) throw new Error('Managed object changed while reading')
        offset += bytesRead
      }
      const after = await handle.stat()
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || digest(bytes) !== key) throw new Error('Managed object hash mismatch')
      return bytes
    } finally { await handle.close() }
  }

  private async verify(key: string, size: number): Promise<void> {
    const bytes = await this.read(key)
    if (bytes.length !== size) throw new Error('Managed object hash mismatch')
  }

  private async ensureDirectory(): Promise<void> {
    // Accept OS aliases such as /tmp at the caller-owned state directory boundary.
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    this.stateDir = await realpath(this.stateDir)
    try { await mkdir(this.root, { mode: 0o700 }) } catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed object directory uses a symbolic link or non-directory')
    if (await realpath(this.root) !== this.root) throw new Error('Managed object directory is not canonical')
  }
}
