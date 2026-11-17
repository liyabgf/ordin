import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { parseSettings, type Settings } from '../src/core/policy.ts'
import type { Actor } from '../src/core/model.ts'
import { discard } from './helpers/temp.ts'
// Dynamic import makes the feature-absent baseline an explicit runtime import failure, not a compilation claim.
const { ConversationIntake, conversationIntakeReceiptKey } = await import('../src/app/conversation-intake.ts')
const actor: Actor = { kind: 'person', id: 'operator' }
const envelope = () => ({ conversationId: 'conversation-a', source: { kind: 'chat', channelId: 'room', externalMessageId: 'message-1' }, text: ' help me ' })
const defer = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done }); return { promise, resolve } }
let store: Store
let settings: Settings
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ordin-intake-test-'))
  store = new Store(join(directory, 'state.sqlite3'))
  settings = parseSettings({ acceptMode: 'auto', sources: { chat: { enabled: true } } })
})
afterEach(() => { store.close(); discard(directory) })
const service = (runConversation = vi.fn(async (_input: unknown): Promise<unknown> => ({ answer: 'ok' }))) => ({
  runConversation, intake: new ConversationIntake({ store, settings: () => settings, runConversation }),
})

describe('conversation intake gate', () => {
  it('accepts without creating a Trigger or Ticket, passing normalized context to host', async () => {
    const { intake, runConversation } = service()
    const result = await intake.receive(envelope(), actor)
    expect(result).toMatchObject({ state: 'completed', conversationId: 'conversation-a', result: { answer: 'ok' } })
    expect(runConversation).toHaveBeenCalledWith({ ...envelope(), profileId: 'default', text: 'help me', actor })
    expect(store.triggers.list()).toEqual([])
    expect(store.tickets.list()).toEqual([])
  })
  it.each([
    ['observe', { acceptMode: 'observe' }, 'observed', 'observed'],
    ['unknown sender', { allowedSenders: ['somebody'] }, 'rejected', 'sender_not_allowed'],
    ['global paused', { paused: true }, 'rejected', 'paused'],
    ['source paused', { sources: { chat: { enabled: true, paused: true } } }, 'rejected', 'paused'],
    ['source denied', { sources: { chat: { enabled: true, deny: true } } }, 'rejected', 'source_disabled'],
    ['source disabled', { sources: { chat: { enabled: false } } }, 'rejected', 'source_disabled'],
    ['source observe overrides auto', { sources: { chat: { enabled: true, acceptMode: 'observe' } } }, 'observed', 'observed'],
    ['source allowlist overrides global', { sources: { chat: { enabled: true, allowedSenders: [] } } }, 'rejected', 'sender_not_allowed'],
  ])('%s never invokes callback', async (_label, patch, state, reason) => {
    settings = parseSettings({ ...settings, ...patch })
    const { intake, runConversation } = service()
    expect(await intake.receive(envelope(), actor)).toMatchObject({ state, result: { reason } })
    expect(runConversation).not.toHaveBeenCalled()
    expect(store.triggers.list()).toEqual([])
    expect(store.tickets.list()).toEqual([])
  })
  it('uses policy source overrides for pause and acceptMode', async () => {
    settings = parseSettings({ paused: true, acceptMode: 'observe', sources: { chat: { enabled: true, paused: false, acceptMode: 'auto' } } })
    const { intake, runConversation } = service()
    expect((await intake.receive(envelope(), actor)).state).toBe('completed')
    expect(runConversation).toHaveBeenCalledTimes(1)
  })
  it('refuses system actors and empty text according to policy', async () => {
    const { intake, runConversation } = service()
    expect(await intake.receive(envelope(), { kind: 'system', id: 'operator' })).toMatchObject({ state: 'rejected', result: { reason: 'system_actor' } })
    const empty = envelope(); empty.source.externalMessageId = 'empty'; empty.text = '  '
    expect(await intake.receive(empty, actor)).toMatchObject({ state: 'rejected', result: { reason: 'empty_request' } })
    expect(runConversation).not.toHaveBeenCalled()
  })
  it.each([
    { ...envelope(), profileId: 'foreign' },
    { ...envelope(), actor },
    { ...envelope(), token: 'credential' },
    { ...envelope(), attachments: ['/tmp/file'] },
    { ...envelope(), attachments: { uploadRefs: ['/tmp/file'] } },
    { ...envelope(), source: { ...envelope().source, kind: 'unknown' } },
    { ...envelope(), source: { ...envelope().source, externalMessageId: '' } },
    { ...envelope(), source: { ...envelope().source, replyTo: { kind: 'chat', channel: 'room', path: '/tmp/file' } } },
  ])('rejects invalid/untrusted envelope with 400: %j', async input => {
    const { intake, runConversation } = service()
    await expect(intake.receive(input, actor)).rejects.toMatchObject({ status: 400 })
    expect(runConversation).not.toHaveBeenCalled()
  })
  it('refuses foreign conversation ownership and missing bound actor', async () => {
    store.conversations.save({ id: 'conversation-a', profileId: 'foreign', createdAt: '2026-01-01', lastMessageAt: '2026-01-01' })
    const { intake, runConversation } = service()
    await expect(intake.receive(envelope(), actor)).rejects.toMatchObject({ status: 400 })
    expect(await intake.receive(envelope())).toMatchObject({ state: 'rejected', result: { reason: 'identity_unbound', held: true } })
    expect(runConversation).not.toHaveBeenCalled()
  })
})

describe('durable receipts', () => {
  it('re-evaluates unbound and paused holds after binding and unpause', async () => {
    const { intake, runConversation } = service()
    const hold = await intake.receive(envelope())
    expect(hold).toMatchObject({ state: 'rejected', result: { held: true } })
    expect(store.get(conversationIntakeReceiptKey(hold.receiptId))).toBeUndefined()
    settings = parseSettings({ ...settings, paused: true })
    expect((await intake.receive(envelope(), actor)).state).toBe('rejected')
    expect(store.get(conversationIntakeReceiptKey(hold.receiptId))).toBeUndefined()
    settings = parseSettings({ ...settings, paused: false })
    expect((await intake.receive(envelope(), actor)).state).toBe('completed')
    expect(runConversation).toHaveBeenCalledTimes(1)
  })
  it('preserves crash pending across a real database close/reopen', async () => {
    const old = service(vi.fn(() => new Promise(() => {})))
    void old.intake.receive(envelope(), actor)
    await Promise.resolve()
    store.close(); store = new Store(join(directory, 'state.sqlite3'))
    const fresh = service()
    expect((await fresh.intake.receive(envelope(), actor)).state).toBe('uncertain')
    expect(fresh.runConversation).not.toHaveBeenCalled()
  })
  it('reserves in a committed transaction before callback and joins simultaneous duplicates', async () => {
    const blocked = defer()
    const receiptId = createHash('sha256').update(JSON.stringify(['conversation-intake', 1, 'chat', 'room', 'message-1'])).digest('hex')
    const run = vi.fn(async () => {
      const response = receiptId
      expect(store.get<{ response: { state: string } }>(conversationIntakeReceiptKey(response))).toMatchObject({ response: { state: 'pending' } })
      return blocked.promise
    })
    const intake = new ConversationIntake({ store, settings: () => settings, runConversation: run })
    const first = intake.receive(envelope(), actor)
    const duplicate = intake.receive({ ...envelope(), receivedAt: '2026-11-17T00:00:00Z' }, actor)
    expect(duplicate).toBe(first)
    // Receipt id is deterministic and independent of service instance or receivedAt.
    await Promise.resolve(); await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    blocked.resolve({ answer: 'once' })
    expect(await first).toEqual(await duplicate)
    expect((await first).state).toBe('completed')
  })
  it('replays completed across a real database reopen without a callback', async () => {
    const first = await service().intake.receive(envelope(), actor)
    store.close(); store = new Store(join(directory, 'state.sqlite3'))
    settings = parseSettings({ paused: true })
    const { intake, runConversation } = service()
    for (const changed of [
      { ...envelope(), text: 'different persisted body' },
      { ...envelope(), source: { ...envelope().source, threadId: 'different-thread' } },
    ]) await expect(intake.receive(changed, actor)).rejects.toMatchObject({ status: 409 })
    await expect(intake.receive(envelope(), { kind: 'person', id: 'other-actor' })).rejects.toMatchObject({ status: 409 })
    expect(await intake.receive({ ...envelope(), profileId: 'default', text: 'help me', receivedAt: '2026-11-17T00:00:00Z' }, actor)).toEqual(first)
    expect(runConversation).not.toHaveBeenCalled()
  })
  it('verifies fingerprint both during flight and on replay', async () => {
    const blocked = defer()
    const { intake, runConversation } = service(vi.fn(() => blocked.promise))
    const first = intake.receive(envelope(), actor)
    await expect(intake.receive({ ...envelope(), text: 'changed' }, actor)).rejects.toMatchObject({ status: 409 })
    blocked.resolve('done'); await first
    for (const input of [
      { ...envelope(), conversationId: 'other' },
      { ...envelope(), text: 'changed' },
      { ...envelope(), source: { ...envelope().source, threadId: 'other-thread' } },
      { ...envelope(), attachments: { uploadRefs: ['44444444-4444-4444-8444-444444444444'] } },
    ]) await expect(intake.receive(input, actor)).rejects.toMatchObject({ status: 409 })
    await expect(intake.receive(envelope(), { kind: 'person', id: 'another' })).rejects.toMatchObject({ status: 409 })
    expect(runConversation).toHaveBeenCalledTimes(1)
  })
  it('new service sees prior pending as uncertain and never repeats effects', async () => {
    const blocked = defer()
    const old = service(vi.fn(() => blocked.promise))
    const first = old.intake.receive(envelope(), actor)
    await Promise.resolve()
    const fresh = service()
    const uncertain = await fresh.intake.receive(envelope(), actor)
    expect(uncertain.state).toBe('uncertain')
    expect(fresh.runConversation).not.toHaveBeenCalled()
    blocked.resolve('late completion')
    expect((await first).state).toBe('uncertain')
    expect((await service().intake.receive(envelope(), actor)).state).toBe('uncertain')
  })
  it('retains callback rejection as uncertain without leaking error or repeating action', async () => {
    const run = vi.fn(async () => { throw new Error('secret credential in upstream error') })
    const { intake } = service(run)
    const failed = await intake.receive(envelope(), actor)
    expect(failed).toMatchObject({ state: 'uncertain', result: { reason: 'conversation_callback_or_completion_failed' } })
    expect(JSON.stringify(failed)).not.toContain('secret')
    expect(await intake.receive(envelope(), actor)).toEqual(failed)
    const next = service(run)
    expect(await next.intake.receive(envelope(), actor)).toEqual(failed)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('preserves replyTo, thread, and opaque uploads, and allows different conversations in parallel', async () => {
    const blocked = defer()
    const { intake, runConversation } = service(vi.fn(() => blocked.promise))
    const input = { ...envelope(), attachments: { uploadRefs: ['44444444-4444-4444-8444-444444444444'] }, source: { ...envelope().source, threadId: 'topic-7', replyTo: { kind: 'chat', channel: 'reply-room', thread: 'reply-topic' } } }
    const first = intake.receive(input, actor)
    const second = intake.receive({ ...input, conversationId: 'conversation-b', source: { ...input.source, externalMessageId: 'message-2' } }, actor)
    await Promise.resolve()
    expect(runConversation).toHaveBeenCalledTimes(2)
    expect(runConversation.mock.calls[0]?.[0]).toMatchObject({ ...input, text: 'help me', actor, profileId: 'default' })
    blocked.resolve('ok'); await Promise.all([first, second])
  })
})
