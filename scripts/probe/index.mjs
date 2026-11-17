#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backends = ['dsh', 'codex', 'claude']
const only = process.argv.slice(2)
const selected = only.length ? only : backends
const results = []
for (const backend of selected) {
  if (!backends.includes(backend)) {
    console.error(`unknown backend: ${backend}`)
    process.exitCode = 1
    continue
  }
  const path = fileURLToPath(new URL(`./${backend}.mjs`, import.meta.url))
  if (!existsSync(path)) {
    results.push({ backend, status: '未测', note: 'probe 脚本尚未实现' })
    continue
  }
  const run = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 15 * 60_000 })
  results.push({ backend, status: run.status === 0 ? '已执行' : '探针脚本失败', exitCode: run.status, stdout: run.stdout, stderr: run.stderr })
}
console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
