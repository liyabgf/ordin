import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, utimesSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { boot } from '../src/app/boot.ts'
import { resolveConfig } from '../src/app/config.ts'
import { silentLogger } from '../src/app/logger.ts'
import { createRuntime } from '../src/app/runtime.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { ChatSource } from '../src/sources/chat.ts'
import type { SourceHost } from '../src/sources/kind.ts'
import type { WorkerDriver } from '../src/drivers/types.ts'
import { parseSettings } from '../src/core/policy.ts'
import { tempDir } from './helpers/temp.ts'
function fixture(patch: object = {}) {
 const dir = tempDir('ordin-chat-intake-'); const room = join(dir, 'room'); mkdirSync(room)
 const runtime = createRuntime(boot({ config: resolveConfig({ stateDir: join(dir, 'state'), workRoot: join(dir, 'work'), inboxDir: join(dir, 'inbox'), port: 0 }), logger: silentLogger() }), { logger: silentLogger(), proc: new ProcessRegistry(), notifier: null, driver: {} as WorkerDriver })
 runtime.store.saveSettings(parseSettings({ acceptMode: 'auto', sources: { chat: { enabled: true, channels: [{ id: 'room', directory: room, enabled: true }], pollMs: 1000, identities: { U1: { actor: 'operator' } } } }, ...patch }))
 const run = vi.spyOn(runtime, 'conversationTurn').mockResolvedValue({ reply: 'answer', sent: ['answer'], toolOutcomes: [], rounds: 1 })
 const host = (runtime as unknown as { sourceHost(): SourceHost }).sourceHost(); const source = new ChatSource(host)
 const drop = (metadata = 'mode: conversation\nthread: topic', from = 'U1') => { const path = join(room, 'message.md'); writeFileSync(path, '---\nfrom: ' + from + '\nid: m1\n' + metadata + '\n---\nhello'); const old = new Date(Date.now() - 5000); utimesSync(path, old, old) }
 const files = (folder: string) => existsSync(join(room, folder)) ? readdirSync(join(room, folder)) : []
 return { runtime, source, host, run, room, drop, files }
}
describe('F4-A2 chat Coordinator', () => {
 it('accepted conversation invokes Coordinator once, preserves envelope, creates no gate Ticket/Trigger', async () => {
 const f = fixture(); try { const receive = vi.spyOn(f.host.conversationIntake!, 'receive'); f.drop(); await f.source.poll()
 expect(f.run).toHaveBeenCalledExactlyOnceWith('chat:room:topic', 'hello')
 expect(receive).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'default', conversationId: 'chat:room:topic', text: 'hello', source: { kind: 'chat', channelId: 'room', externalMessageId: 'm1', threadId: 'topic', replyTo: { kind: 'chat', channel: 'room', thread: 'topic' } } }), { kind: 'person', id: 'operator' })
 expect(f.runtime.store.tickets.list()).toEqual([]); expect(f.runtime.store.triggers.list()).toEqual([]); expect(f.files('accepted')).toHaveLength(1); expect(f.files('out')).toHaveLength(1)
 } finally { await f.source.stop(); await f.runtime.stop() }
 })
 it('absent mode is ordinary task with ignored unknown fields', async () => { const f = fixture(); try { f.drop('other: ignored'); await f.source.poll(); expect(f.run).not.toHaveBeenCalled(); expect(f.runtime.store.tickets.list()).toHaveLength(1) } finally { await f.source.stop(); await f.runtime.stop() } })
 it.each([['observe', { acceptMode: 'observe' }, 'observed'], ['reject', { allowedSenders: ['other'] }, 'rejected']])('%s never calls Coordinator', async (_name, patch, folder) => { const f = fixture(patch as object); try { f.drop(); await f.source.poll(); expect(f.run).not.toHaveBeenCalled(); expect(f.files(folder as string)).toHaveLength(1); expect(f.runtime.store.triggers.list()).toEqual([]); expect(f.files('out')).toEqual([]) } finally { await f.source.stop(); await f.runtime.stop() } })
 it('intake held identity remains for later mapping', async () => { const f = fixture(); try { vi.spyOn(f.host.conversationIntake!, 'receive').mockResolvedValue({ receiptId: 'r', state: 'rejected', result: { held: true } }); f.drop(); await f.source.poll(); expect(existsSync(join(f.room, 'message.md'))).toBe(true); expect(f.source.waiting().count).toBe(1); expect(f.files('rejected')).toEqual([]) } finally { await f.source.stop(); await f.runtime.stop() } })
 it('unmapped identity holds unchanged', async () => { const f = fixture(); try { f.drop('mode: conversation', 'unknown'); await f.source.poll(); expect(f.run).not.toHaveBeenCalled(); expect(f.source.waiting().count).toBe(1); expect(existsSync(join(f.room, 'message.md'))).toBe(true) } finally { await f.source.stop(); await f.runtime.stop() } })
 it('duplicate after collection never calls Coordinator or recreates reply', async () => { const f = fixture(); try { f.drop('mode: conversation'); await f.source.poll(); expect(f.run).toHaveBeenCalledExactlyOnceWith('chat:room:dm:U1', 'hello'); for (const file of f.files('out')) unlinkSync(join(f.room, 'out', file)); f.drop('mode: conversation'); await f.source.poll(); expect(f.run).toHaveBeenCalledTimes(1); expect(f.files('out')).toEqual([]); expect(f.files('accepted')).toHaveLength(1) } finally { await f.source.stop(); await f.runtime.stop() } })
 it('callback failure remains uncertain without repeated side effects', async () => { const f = fixture(); try { f.run.mockRejectedValue(new Error('secret')); f.drop(); await f.source.poll(); await f.source.poll(); expect(f.run).toHaveBeenCalledTimes(1); expect(f.files('accepted')).toEqual([]); expect(f.files('rejected')).toEqual([]); expect(f.files('out')).toEqual([]); expect(f.source.status().detail).toContain('uncertain'); expect(f.source.status().detail).not.toContain('secret') } finally { await f.source.stop(); await f.runtime.stop() } })
 it.each(['mode: invalid', 'mode: conversation\nattachments: /tmp/file'])('unsupported metadata explicitly holds: %s', async metadata => { const f = fixture(); try { f.drop(metadata); await f.source.poll(); expect(f.run).not.toHaveBeenCalled(); expect(f.source.status().ok).toBe(false); expect(existsSync(join(f.room, 'message.md'))).toBe(true) } finally { await f.source.stop(); await f.runtime.stop() } })
 it('paused input remains held', async () => { const f = fixture({ paused: true }); try { f.drop(); await f.source.poll(); expect(f.run).not.toHaveBeenCalled(); expect(existsSync(join(f.room, 'message.md'))).toBe(true) } finally { await f.source.stop(); await f.runtime.stop() } })
})
