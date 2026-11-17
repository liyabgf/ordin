/**
 * Reading a Ticket's directory from the panel.
 *
 * Two things have to hold: an operator can see and take what a run produced without opening a terminal, and a route
 * that serves files cannot be talked into serving one outside the Ticket's directory.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTextFile, listFiles, MAX_FILE_BYTES, readForPanel, resolveInside, resolveRealInside } from '../src/app/files.ts'
import { tempDir } from './helpers/temp.ts'

function sample(): string {
  const root = tempDir('ordin-files-')
  writeFileSync(join(root, 'RESULT.md'), '# 结果\n\n做完了。\n', 'utf8')
  writeFileSync(join(root, 'data.csv'), 'a,b\n1,2\n', 'utf8')
  mkdirSync(join(root, 'charts'), { recursive: true })
  writeFileSync(join(root, 'charts', 'trend.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'binary')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'run.py'), 'print("hi")\n', 'utf8')
  // A dependency tree a worker may well have made: it is not the operator's output and must not crowd it out.
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {}', 'utf8')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8')
  return root
}

describe('listing a directory', () => {
  it('walks what a run produced and leaves out the noise', async () => {
    const listing = await listFiles(sample())
    const paths = listing.files.map(file => file.path)
    // Locale order, not ASCII: a person scanning the list reads charts, data, RESULT, scripts.
    expect(paths).toEqual(['charts', 'charts/trend.png', 'data.csv', 'RESULT.md', 'scripts', 'scripts/run.py'])
    expect(listing.count).toBe(4)
    expect(listing.truncated).toBe(false)
  })

  it('says which entries are worth showing as text', async () => {
    const listing = await listFiles(sample())
    const byPath = Object.fromEntries(listing.files.map(file => [file.path, file]))
    expect(byPath['RESULT.md']).toMatchObject({ text: true, directory: false })
    expect(byPath['charts/trend.png']).toMatchObject({ text: false, directory: false })
    expect(byPath['charts']).toMatchObject({ text: false, directory: true })
    expect(byPath['data.csv']!.size).toBe('a,b\n1,2\n'.length)
  })

  it('reports sizes and modification times, which is how a person tells a real output from a stub', async () => {
    const root = sample()
    const listing = await listFiles(root)
    const result = listing.files.find(file => file.path === 'RESULT.md')!
    expect(result.size).toBe(readFileSync(join(root, 'RESULT.md')).length)
    expect(Date.parse(result.mtime!)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('stops at a bound and says it stopped, rather than serving an unbounded tree', async () => {
    const root = tempDir('ordin-many-')
    for (let index = 0; index < 600; index++) writeFileSync(join(root, `file-${index}.txt`), 'x', 'utf8')
    const listing = await listFiles(root)
    expect(listing.files.length).toBeLessThanOrEqual(500)
    expect(listing.truncated).toBe(true)
  })

  it('lists an empty directory as empty', async () => {
    const listing = await listFiles(tempDir('ordin-empty-'))
    expect(listing).toMatchObject({ files: [], count: 0, truncated: false })
  })

  it('skips symbolic links to files and directories so a worker symlink never counts sibling assets as its own', async () => {
    const root = sample()
    const outside = tempDir('ordin-outside-sym-')
    writeFileSync(join(outside, 'stolen.txt'), 'secret', 'utf8')
    symlinkSync(outside, join(root, 'raw-link'))
    symlinkSync(join(outside, 'stolen.txt'), join(root, 'file-link.txt'))
    const listing = await listFiles(root)
    const paths = listing.files.map(file => file.path)
    expect(paths).not.toContain('raw-link')
    expect(paths).not.toContain('raw-link/stolen.txt')
    expect(paths).not.toContain('file-link.txt')
    expect(listing.count).toBe(4)
  })

  it('lists a directory that is gone as empty, rather than throwing at the panel', async () => {
    const listing = await listFiles(join(tempDir('ordin-gone-'), 'nope'))
    expect(listing).toMatchObject({ files: [], count: 0 })
  })
})

describe('which paths may be served', () => {
  it('accepts a path inside the directory and refuses every way out of it', () => {
    const root = sample()
    expect(resolveInside(root, 'RESULT.md')).toBe(join(root, 'RESULT.md'))
    expect(resolveInside(root, 'charts/trend.png')).toBe(join(root, 'charts', 'trend.png'))
    expect(resolveInside(root, './RESULT.md')).toBe(join(root, 'RESULT.md'))
    for (const escape of ['../secret.txt', 'charts/../../secret.txt', '/etc/passwd', '..']) {
      expect(resolveInside(root, escape), escape).toBeUndefined()
    }
  })

  it('refuses symbolic links and paths that physically resolve outside root via resolveRealInside and readForPanel', async () => {
    const root = sample()
    const outside = tempDir('ordin-outside-real-')
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret', 'utf8')
    symlinkSync(outside, join(root, 'linked-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'linked-file.txt'))
    expect(await resolveRealInside(root, 'RESULT.md')).toBe(join(root, 'RESULT.md'))
    expect(await resolveRealInside(root, 'linked-file.txt')).toBeUndefined()
    expect(await resolveRealInside(root, 'linked-dir/secret.txt')).toBeUndefined()
    await expect(readForPanel(join(root, 'linked-file.txt'))).rejects.toThrow(/symbolic link/)
  })

  it('tells a text file from a binary one by name and size', () => {
    expect(isTextFile('report.md', 100)).toBe(true)
    expect(isTextFile('data.CSV', 100)).toBe(true)
    expect(isTextFile('image.png', 100)).toBe(false)
    expect(isTextFile('huge.log', MAX_FILE_BYTES + 1)).toBe(false)
    expect(isTextFile('no-extension', 100)).toBe(false)
  })

  it('hands over bytes as base64, which is what a download link is built from', async () => {
    const root = sample()
    const read = await readForPanel(join(root, 'RESULT.md'))
    expect(Buffer.from(read.base64, 'base64').toString('utf8')).toBe('# 结果\n\n做完了。\n')
    expect(read.size).toBe(readFileSync(join(root, 'RESULT.md')).length)
  })
})
