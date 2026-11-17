import { createHash } from 'node:crypto'
import { z } from 'zod'
import { gate, type Settings } from '../core/policy.ts'
import type { Store } from './store.ts'
import type { Actor, Trigger } from '../core/model.ts'

const id = z.string().trim().min(1).max(512)
const kind = z.enum(['cron', 'inbox', 'session', 'rule', 'chat'])
const actorSchema = z.object({ id, kind: z.enum(['person', 'system']) }).strict()
export const ConversationEnvelopeSchema = z.object({
  profileId: z.literal('default').default('default'),
  conversationId: id,
  source: z.object({
    kind, channelId: id, externalMessageId: id, threadId: id.optional(),
    replyTo: z.object({ kind, channel: id, thread: id.optional() }).strict().optional(),
  }).strict(),
  text: z.string().trim().max(20000),
  receivedAt: z.iso.datetime().optional(),
  attachments: z.object({ uploadRefs: z.array(z.uuid()).max(10) }).strict().optional(),
}).strict()
export type ConversationEnvelope = z.output<typeof ConversationEnvelopeSchema>
export type IntakeState = 'pending' | 'completed' | 'observed' | 'rejected' | 'uncertain'
export interface IntakeResponse {
  readonly receiptId: string
  readonly state: IntakeState
  readonly conversationId: string
  readonly result?: unknown
}
interface Receipt {
  fingerprint: string
  response: IntakeResponse
}
export interface ConversationIntakeHost {
  readonly store: Store
  readonly settings: () => Settings
  /** Identity binding belongs to the host; this envelope contains only the validated bound actor. */
  readonly runConversation: (envelope: ConversationEnvelope & { readonly actor: Actor }) => Promise<unknown>
}
export class ConversationIntakeError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message) }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const conversationIntakeReceiptKey = (receiptId: string) => 'conversation-intake:v1:' + receiptId

/** Service only: gate never writes a Trigger or Ticket. Coordinator owns conversation serialization. */
export class ConversationIntake {
  private readonly running = new Map<string, { fingerprint: string; promise: Promise<IntakeResponse> }>()
  constructor(private readonly host: ConversationIntakeHost) {}

  receive(input: unknown, trustedActor?: Actor): Promise<IntakeResponse> {
    const parsed = ConversationEnvelopeSchema.safeParse(input)
    const actor = actorSchema.safeParse(trustedActor)
    if (!parsed.success || (trustedActor !== undefined && !actor.success)) return Promise.reject(new ConversationIntakeError(400, 'Invalid envelope or host identity binding'))
    const envelope = parsed.data
    if (!actor.success) {
      const receiptId = digest(['conversation-intake', 1, envelope.source.kind, envelope.source.channelId, envelope.source.externalMessageId])
      return Promise.resolve({ receiptId, state: 'rejected', conversationId: envelope.conversationId, result: { reason: 'identity_unbound', held: true } })
    }
    const conversation = this.host.store.conversations.get(envelope.conversationId)
    if (conversation !== undefined && conversation.profileId !== 'default') return Promise.reject(new ConversationIntakeError(400, 'Conversation profile mismatch'))
    const { receivedAt: _receivedAt, ...stable } = envelope
    const fingerprint = digest({ ...stable, actor: actor.data })
    const receiptId = digest(['conversation-intake', 1, envelope.source.kind, envelope.source.channelId, envelope.source.externalMessageId])
    const durable = this.host.store.get<Receipt>(conversationIntakeReceiptKey(receiptId))
    if (durable !== undefined && durable.fingerprint !== fingerprint) return Promise.reject(new ConversationIntakeError(409, 'External message identity conflict'))
    if (durable !== undefined && durable.response.state !== 'pending') return Promise.resolve(durable.response)
    const current = this.running.get(receiptId)
    if (current !== undefined) {
      if (current.fingerprint !== fingerprint) return Promise.reject(new ConversationIntakeError(409, 'External message identity conflict'))
      return current.promise
    }
    // Defer callback invocation until the local join entry has been installed (including reentrant hosts).
    const promise = Promise.resolve().then(() => this.process(envelope, actor.data, receiptId, fingerprint))
    this.running.set(receiptId, { fingerprint, promise })
    void promise.then(() => this.running.delete(receiptId), () => this.running.delete(receiptId))
    return promise
  }

  private async process(envelope: ConversationEnvelope, actor: Actor, receiptId: string, fingerprint: string): Promise<IntakeResponse> {
    const store = this.host.store
    const storageKey = conversationIntakeReceiptKey(receiptId)
    const initial = store.atomic(() => {
      const existing = store.get<Receipt>(storageKey)
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new ConversationIntakeError(409, 'External message identity conflict')
        if (existing.response.state === 'pending') {
          existing.response = { ...existing.response, state: 'uncertain' }
          store.set(storageKey, existing)
        }
        return { response: existing.response, invoke: false }
      }
      const source = envelope.source
      const trigger: Trigger = {
        id: receiptId, source: source.kind, kind: source.kind, actor,
        at: envelope.receivedAt ?? new Date().toISOString(), text: envelope.text, title: envelope.text.slice(0, 120),
        ...(source.replyTo === undefined ? {} : { replyTo: source.replyTo }),
      }
      const verdict = gate(trigger, this.host.settings())
      const state = !verdict.allow ? 'rejected' : verdict.observe ? 'observed' : 'pending'
      const response: IntakeResponse = { receiptId, state, conversationId: envelope.conversationId,
        ...(state === 'pending' ? {} : { result: { reason: verdict.reason, detail: verdict.detail } }) }
      // Holds remain retryable after identity binding or operator unpause; do not consume the external id.
      const held = !verdict.allow && (verdict.reason === 'paused' || verdict.reason === 'sender_not_allowed' || verdict.reason === 'unknown_source')
      if (!held) store.set(storageKey, { fingerprint, response } satisfies Receipt)
      return { response, invoke: state === 'pending' }
    })
    if (!initial.invoke) return initial.response
    let response: IntakeResponse
    try {
      const result = await this.host.runConversation({ ...envelope, actor })
      // JSON persistence must succeed before reporting completed. A callback may already have acted.
      response = { ...initial.response, state: 'completed', ...(result === undefined ? {} : { result }) }
      store.atomic(() => {
        const current = store.get<Receipt>(storageKey)
        if (current?.response.state !== 'pending') throw new Error('Receipt became uncertain during callback')
        store.set(storageKey, { fingerprint, response } satisfies Receipt)
      })
    } catch {
      // An arbitrary callback can throw after acting: do not claim that it had no effects or retry it.
      response = { ...initial.response, state: 'uncertain', result: { reason: 'conversation_callback_or_completion_failed' } }
      store.atomic(() => store.set(storageKey, { fingerprint, response } satisfies Receipt))
    }
    return response
  }
}
