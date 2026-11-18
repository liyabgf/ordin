import type { SkillCandidates } from './skill-candidates.ts'
import { AssetCatalog, AssetCatalogError } from './asset-catalog.ts'
/**
 * Ordin 面板与 API：自己的 node:http 服务（server.ts），不再是 DSH webServer 插件。
 *
 * 路由表与 sameOrigin 语义原样迁自 ordin src/app/http.ts（runtime-analysis §5 P2-T2），只把宿主收窄：
 * 没有 cordis Context，没有 ctx.webServer；日志与端口来自 HttpHost.context 与 HttpHost.serverPort，
 * 执行器只剩槽位计数与工作区读取，desk 只剩状态读取。DSH 专属的形状（Recipe/WorkerProgress）在本地定义，
 * 等 runtime/desk 迁入时由各自文件成为唯一所有者。
 *
 * 路径决策（选一种并写清）：正典是 /ordin/ 面板与 /ordin/api/*；/ordin/ 与 /ordin/api/* 作为兼容别名保留，
 * 因为 panel/index.html（P1-T3 资产，本卡禁改）仍 fetch('/ordin/api/...') 且带 x-ordin-request 头。
 * 两条前缀共用同一个 sameOrigin 守卫：标记头接受 x-ordin-request 或 x-ordin-request（都是自定义头，
 * 跨源页面无法在不触发预检的情况下携带，而本服务不做 CORS 预检，因此等价于原守卫）。
 *
 * 管理请求必须同源：Host 头必须指向本机 loopback 的实际端口，且携带标记头；Origin（若带）必须是同源。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { lstat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ticketStage } from '../core/index.ts'
import type { Engine } from '../core/index.ts'
import { UserError } from '../core/errors.ts'
import { policyVersion, ScheduleSchema, sourcePolicy, type Settings } from '../core/policy.ts'
import { describeTiming, localZone, nextRun } from '../core/timing.ts'
import { changesView } from './about.ts'
import { PROMPT_ROLES, PromptConflict, packageFile } from './prompts.ts'
import { builtInSkillsView } from './skills.ts'
import { decisionView, scheduleView, ticketSummary, ticketView } from './views.ts'
import { isTextFile, MAX_FILE_BYTES, resolveInside, resolveRealInside, type FileListing } from './files.ts'
import type { HealthBoard } from './health.ts'
import type { Prompts } from './prompts.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { SourceStatus } from '../sources/kind.ts'
import type { Artifact } from '../core/model.ts'
import { LOST_TRIGGER_CHARS, LOST_TRIGGER_KEEP, type Store } from './store.ts'
import { Memories, MemoryError } from './memories.ts'
import { Conversations, ConversationError } from './conversations.ts'
import { UPLOAD_BODY_BYTES, UploadError, type Uploads } from './uploads.ts'
import { startServer } from './server.ts'

/** 面板与 API 的正典前缀。 */
export const BASE_PATH = '/ordin'
/** 面板自己的请求携带的标记头；跨源页面设置不了它。 */
export const REQUEST_HEADER = 'x-ordin-request'
/**
 * 兼容别名：panel/index.html 仍请求 /ordin/api/* 并带旧标记头（P1-T3 资产，本卡禁改）。
 * 两个前缀、两个标记头都过同一个 sameOrigin 守卫，安全边界不因兼容而放宽。
 */
export const LEGACY_BASE_PATH = '/ordin'
export const LEGACY_REQUEST_HEADER = 'x-ordin-request'

const PREFIXES = [BASE_PATH, LEGACY_BASE_PATH] as const
const PANEL_FILE = join('panel', 'index.html')

/** 宿主日志的最小形状；与 src/app/logger.ts 的 Logger 结构相同，但不 import（该文件属 P2-T1 在飞）。 */
export interface HttpLogger {
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}

/**
 * 面板可见的部署事实。ordin 的 Machine（deployment.ts）收窄成两个只读问句：
 * 「面板要展示的路径」与「提示词上限」。deployment.ts 迁入后由它实现，本文件不拥有部署配置。
 */
export interface HttpMachine {
  /** stateDir / workRoot / inboxDir 等键值，面板原样展示。 */
  view(): Record<string, string>
  /** 提示词长度上限（面板的计数器用）。 */
  promptMaxChars(): number
}

/**
 * 执行器在路由表里的全部用途：槽位计数与工作区读取。
 * ordin 的 DshExecutor 在 T6 由 WorkerDriver 取代；这里只冻结面板需要的两个动作。
 */
export interface HttpExecutor {
  used(): number
  readonly sandbox: {
    listWorkspace(directory: string): Promise<FileListing>
    readWorkspaceFile(absolute: string): Promise<{ base64: string; size: number; mtime: string }>
  }
}

/** 面板「从范例开始」用的配方；形状随 ordin runtime.ts:279-287，runtime 迁入后成为唯一所有者。 */
export interface Recipe {
  readonly name: string
  readonly kind: 'request' | 'settings'
  readonly title?: string
  readonly text?: string
  readonly scope?: string
  readonly schedule?: Record<string, unknown>
}

/** 面板轮询一张 Ticket 时读到的进度；形状随 ordin runtime.ts:161-202。 */
export interface WorkerProgress {
  readonly sessionId: string
  readonly sessionTitle: string
  readonly loaded: boolean
  readonly agentStatus?: string
  readonly turn?: number
  readonly lastSaid?: string
  readonly lastEventAt?: string
  readonly recentTools: readonly { readonly name: string; readonly at?: string }[]
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly totalTokens: number
    readonly messages: number
    readonly windowed: boolean
  }
  readonly assignment?: {
    readonly id: string; readonly state: string; readonly startedAt?: string
    readonly deliveredAt?: string; readonly deliveryError?: string
  }
}

/** 面板选模型用的 provider 条目；由 P2-T3 的 OpenAI 兼容 client 的接入方提供。 */
export interface DeskProvider {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name?: string }[]
}

/** 一次创建请求的结果：与 ordin createTicketWithUploads 相同的返回类型（Engine 自己的 ReceiveResult）。 */
export type CreatedTicket = ReturnType<Engine['createTicket']>

export interface HttpHost {
  /** 窄上下文：只有日志。cordis Context 与 ctx.webServer 不再出现在面板代码里。 */
  readonly context: { readonly logger: HttpLogger }
  /** 本服务的实际端口（listen 之后才有），日志与面板 URL 用。 */
  serverPort(): number
  readonly engine: Engine
  /** 操作者的决断队列与单条移除；kv 归宿主所有。 */
  decisions(): readonly { id: string; title: string; detail: string; source: string; raisedAt: string }[]
  dismissDecision(id: string): void
  raiseDecision(title: string, detail: string, source: string): string
  readonly store: Store
  readonly assets?: AssetCatalog
  readonly memories?: Memories
  readonly health: HealthBoard
  readonly prompts: Prompts
  readonly skillCandidates?: SkillCandidates
  /** Source 的只读入口；面板的聊天区只读 source('chat') 的自述。 */
  readonly sources: Pick<SourceRegistry, 'source'>
  sourceStatus(): Record<string, SourceStatus>
  /** 回程计数：值得回发的 Report 数，与无处可发的数。窄口，路由拿不到 Delivery 的其他能力。 */
  readonly delivery: { sends(): { readonly queued: number; readonly nowhere: number } }
  deleteTicket(id: string, options: { assets: 'keep' | 'delete'; record: 'tombstone' | 'nothing' }): Promise<{
    deleted: string; assets: 'keep' | 'delete'; record: 'tombstone' | 'nothing'
    directory?: string; files?: number; bytes?: number
  }>
  artifacts(ticketId: string): readonly Artifact[]
  mountedAt(): string
  readonly executor: HttpExecutor
  readonly uploads: Uploads
  createTicketWithUploads(request: {
    title: string; text: string; sender?: string; scope?: string
    attachments?: readonly string[]; uploadIds?: readonly string[]
  }): CreatedTicket
  /** 只要一个「现在跑一轮」的请求，不需要整台 Passes。 */
  readonly passes: { requestPass(): void }
  /** 立刻轮询所有 Source，再跑一轮到期的效果。 */
  nudge(): Promise<void>
  executionStatus?(): unknown
  checkExecution?(): Promise<unknown>
  modelConfig?(): Promise<{ configuredKey: boolean }>
  saveModelConfig?(value: unknown): Promise<{ configuredKey: boolean }>
  testModel?(value: unknown): Promise<{ ok: true; model: string }>
  listModels?(value: unknown): Promise<{ models: string[] }>
  /** One coordinator turn for the panel chat; absent means the API answers 501 rather than pretending. */
  conversationTurn?(conversationId: string, text: string, model?: string): Promise<{ reply: string; sent: readonly string[]; toolOutcomes: readonly unknown[]; rounds: number }>
  conversationMessages?(conversationId: string, limit?: number): readonly Record<string, unknown>[]
  conversations?: Conversations
  /** 一张 Ticket 的 worker 此刻在做什么。@throws UserError('ticket_missing') */
  progress(ticketId: string): WorkerProgress
  recipes(): readonly Recipe[]
  readonly machine: HttpMachine
  settings(): Settings
  /** 校验、保存并应用设置，告知在跑的 Ticket 变更。 */
  saveSettings(value: unknown): Settings
  /** 面板页正文；生产实现是 panelPage()。 */
  panelHtml(): string
  setupProblem(): string | undefined
  /** 主 Session 是否存在，不创建。 */
  mainSession(): { exists: boolean; running: boolean; busy: boolean }
  /** 现在创建主 Session（挂载时刻意不创建）。 */
  createMainSession(): Promise<{ sessionId?: string; error?: string }>
  /** DeskLoop 迁入前为 undefined：desk/status 答 disabled，desk/messages 仍读 store。 */
  readonly desk?: { status(): Record<string, unknown> }
  /** provider 枚举由 P2-T3 client 的接入方提供；未接入时 desk/providers 答 501（显式未接入，不假装）。 */
  deskProviders?(): Promise<readonly DeskProvider[]>
}

/** serve() 的返回值：实际端口、面板 URL、handler 级 drain 与 socket 级 close。 */
export interface Serving {
  readonly port: number
  readonly url: string
  /** 等所有已接受的请求处理完（ordin 的 active 集合语义）。 */
  drain(): Promise<void>
  /** 停止接受新请求并关闭空闲连接；进行中的请求由 drain 等，不掐断。 */
  close(): Promise<void>
}

/** A refusal this route table words itself, with the field-level detail a form can point at. */
class RouteError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 501 | 503, message: string, readonly issues?: readonly { path: string; message: string }[]) {
    super(message)
  }
}

/** deployment.ts 未迁入前的结构等价识别：name 与 problem 字段同时成立才按设置问题映射（不静默吞别的错误）。 */
interface SetupProblem extends Error { readonly problem: string }
const isSetupProblem = (error: unknown): error is SetupProblem =>
  error instanceof Error && error.name === 'SetupError' && typeof (error as { problem?: unknown }).problem === 'string'

interface RouteRequest {
  readonly params: Record<string, string>
  readonly query: URLSearchParams
  body(maxBytes?: number): Promise<unknown>
}

interface Route {
  readonly method: string
  readonly segments: readonly string[]
  run(request: RouteRequest): unknown | Promise<unknown>
}

const route = (method: string, path: string, run: Route['run']): Route =>
  ({ method, segments: path.split('/').filter(Boolean), run })

async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new RouteError(400, 'The request exceeds ' + maxBytes + ' bytes')
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/**
 * Whether a request comes from the panel on this machine's loopback interface. A host header naming anything else is a
 * page from somewhere else, which must not drive this system even if it reached the port.
 * @param port the server's bound port, or undefined when it is not known, which accepts any loopback port.
 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port?: number): boolean {
  const host = req.headers.host ?? ''
  const name = host.replace(/:\d+$/, '')
  if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]') return false
  if (port !== undefined && host !== '127.0.0.1:' + port && host !== 'localhost:' + port && host !== '[::1]:' + port) return false
  // 两个标记头都接受：x-ordin-request 是正典，x-ordin-request 是 panel/index.html 的兼容（见文件头）。
  const marker = req.headers[REQUEST_HEADER] ?? req.headers[LEGACY_REQUEST_HEADER]
  if (marker !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === 'http://' + host || origin === 'https://' + host
}

/** Map an error to the status and payload the panel shows. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => {
      // An unknown key arrives with an empty path, which would tell the operator that something is wrong without
      // saying what they typed; the key itself is the useful part.
      const keys = (issue as { keys?: string[] }).keys
      const path = issue.path.length === 0 && keys !== undefined ? keys.join(', ') : issue.path.join('.')
      return { path, message: issue.message }
    })
    return [400, { error: 'Invalid settings: ' + issues.map(issue => issue.path).join(', '), issues }]
  }
  if (error instanceof RouteError) {
    return [error.status, error.issues === undefined ? { error: error.message } : { error: error.message, issues: error.issues }]
  }
  if (error instanceof UploadError) return [400, { error: error.message }]
  if (error instanceof AssetCatalogError) return [error.status, { error: error.message }]
  if (error instanceof MemoryError) return [error.status, { error: error.message }]
  if (error instanceof ConversationError) return [error.status, { error: error.message }]
  if (isSetupProblem(error)) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof PromptConflict) return [409, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function match(table: readonly Route[], method: string, parts: readonly string[]): { route: Route; params: Record<string, string> } | undefined {
  for (const candidate of table) {
    if (candidate.method !== method || candidate.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (const [index, segment] of candidate.segments.entries()) {
      const part = parts[index]!
      if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(part)
      else if (segment !== part) { matched = false; break }
    }
    if (matched) return { route: candidate, params }
  }
  return undefined
}

const number = (query: URLSearchParams, name: string, fallback: number, max: number): number => {
  const raw = Number.parseInt(query.get(name) ?? '', 10)
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, max) : fallback
}

/**
 * The chat Source's own waiting line, read back into the parts a page can act on.
 *
 * The platform ids are in no record: a held message produces no Trigger and no Decision by design (contract §2.2), so
 * the only place they are ever written is the sentence the Source puts on the health board. That makes this the one
 * view that reads prose, and it reads it here rather than in the page for two reasons — it is TypeScript next to a
 * test that drives the real Source, so a rewording in chat.ts fails that test instead of silently emptying the
 * operator's waiting queue; and one parse in one place cannot disagree with itself across panels.
 *
 * Anchored on the sentence's own tail because an id may be '<channel>/<file> (no from)': a paren-matching pattern
 * would stop at the first paren INSIDE the list and hand back half a file name.
 */
const WAITING_LINE = /(\d+) message\(s\) from unmapped identities are waiting \((.*)\); add each id/
/** How the Source names the identities it did not list; the count of messages carries the rest. */
const MORE_IDS = /^\+(\d+) more$/

/**
 * What the chat section of the panel cannot work out for itself, and nothing else.
 *
 * Deliberately not a copy of settings.sources.chat: the page already has that document in state.settings, and a
 * second shape for the same facts is a second thing to keep in sync. What is here is the three facts that need the
 * server — the gate's own read of the Source's policy, the waiting gauge, and the ids parsed out of the health line.
 */
function chatView(host: HttpHost, health: Record<string, { ok: boolean; detail?: string }>): Record<string, unknown> {
  const settings = host.settings()
  // Answered by the function the gate itself uses, because paused, acceptMode and allowedSenders each fall back
  // to the global setting. A page that re-implemented that fallback would be a second opinion about who may originate
  // work, and three fallthroughs of exactly that shape are already in this project's record (S33).
  const own = sourcePolicy('chat', settings)
  // The Source's OWN report, not sourceStatus(): that one replaces counts wholesale with the record's disposition
  // counts, so waiting — a gauge the Source recomputes from the directories on every pass, and the number the whole
  // waiting queue hangs on — is absent from it as soon as one chat message has ever been accepted.
  const source = host.sources.source('chat')
  const waiting = source?.status().counts?.waiting
  // Prefer the Source's own structured read. The health sentence is prose, and a panel that parses prose to work out
  // which identities are waiting breaks the moment somebody rewords it — silently, with the messages still on disk,
  // which is the worst shape: it looks like the problem went away. (reply_unroutable was reworded once already, in
  // round 36, and this is the second reason that reword was not free.) The regular expression stays as the path for a
  // Source that does not expose waiting(); tests/http.spec.ts pins the wording, so a reword fails loudly there.
  const structured = (source as { waiting?: () => { count: number; ids: string[]; more: number } } | undefined)?.waiting?.()
  // 每频道的健康（N5）：面板要能说「这一个频道的桥没在跑」，而全局一个 waiting 数说不出是哪个频道。
  // 同样用可选调用，因为跑着旧 bundle 的宿主的 Source 没有这个方法——缺席就是缺席，不画成 0。
  const channelFacts = (source as { channels?: () => unknown[] } | undefined)?.channels?.() ?? []
  const found = structured === undefined ? WAITING_LINE.exec(health['source:chat']?.detail ?? '') : null
  const named = structured !== undefined ? structured.ids : (found === null ? [] : found[2]!.split(', '))
  const trailing = structured === undefined ? MORE_IDS.exec(named.at(-1) ?? '') : null
  return {
    policy: {
      enabled: settings.sources.chat.enabled, paused: own.paused, deny: own.deny,
      acceptMode: own.acceptMode, allowedSenders: [...own.allowedSenders],
    },
    channels: channelFacts,
    waiting: {
      // Omitted rather than 0 when no chat Source is running: "not running" and "nothing is waiting" are different
      // facts, and showing 0 for the first is the quiet kind of wrong this panel keeps getting caught by.
      ...(waiting === undefined ? {} : { count: waiting }),
      // Identities, deduplicated by the Source; count above is MESSAGES, so one id can stand for several of them.
      ids: trailing === null ? named : named.slice(0, -1),
      ...(() => {
        const extra = structured !== undefined ? structured.more : (trailing === null ? undefined : Number(trailing[1]!))
        return extra === undefined || extra === 0 ? {} : { more: extra }
      })(),
    },
  }
}

/**
 * How many requests were given up on, counted from the record, split by the two paths §4.42 separated.
 *
 * undefined when the read fails, which the caller omits instead of zeroing: a section that could not be read must
 * not render as "nothing was lost", which is the shape this panel has been caught by repeatedly.
 */
function lostCount(host: HttpHost): { rows: number; payloads: number } | undefined {
  try {
    const counted = host.store.triggers.countBySource()
    return {
      rows: Object.values(counted).reduce((total, states) => total + (states['lost'] ?? 0), 0),
      payloads: host.store.lostPayloads().length,
    }
  } catch { return undefined }
}

/** The counts and health of a system that is working, which is what the panel's header shows. */
function stateView(host: HttpHost): Record<string, unknown> {
  const settings = host.settings()
  const counts = host.store.tickets.count()
  const effects = host.store.effectCounts()
  const health = host.health.snapshot()
  const lost = lostCount(host)
  return {
    settings,
    settingsRevision: host.store.settingsRevision(),
    // Exposed because it is otherwise unobservable from outside: the only place it surfaced was on a Ticket's Mandate,
    // so checking that a settings change moved the authorization version meant creating a probe Ticket and stopping it.
    policyVersion: policyVersion(host.settings()),
    mountedAt: host.mountedAt(),
    machine: host.machine.view(),
    setupProblem: host.setupProblem(),
    counts: {
      ...counts,
      triggers: host.store.triggers.since('', 1000).length,
      decisions: host.store.decisions.list(1000).length,
      effects,
      workerSlots: { used: host.executor.used(), max: settings.executor.maxWorkers },
      /**
       * The way back, counted: how many Reports were queued for the platform that asked, and how many had no address
       * to go to (contract §3.3 — send does nothing and says nothing when a Trigger carries no replyTo).
       *
       * Folded into state rather than given a route of its own: state is the one route every bundle answers, so a
       * host older than the page degrades by this KEY being absent instead of by a 404 the page would toast about
       * every five seconds. Both numbers are per-process: they count since this Delivery was constructed.
       */
      sends: host.delivery.sends(),
      /** Omitted rather than zeros when the read failed, so "nothing was lost" is never "I could not look". */
      ...(lost === undefined ? {} : { lost }),
    },
    health,
    sources: host.sourceStatus(),
    chat: chatView(host, health),
    prompts: {
      revision: host.prompts.revision(), maxChars: host.machine.promptMaxChars(),
      roles: PROMPT_ROLES.map(role => ({
        role, overridden: host.prompts.config()[role] !== undefined, chars: host.prompts.current(role).length,
      })),
    },
    paused: settings.paused,
    mainSession: host.mainSession(),
  }
}

/** The route table, in the order the panel's own navigation reads (ordin http.ts:368-781). */
function table(host: HttpHost): readonly Route[] {
  return [
    route('GET', 'state', () => stateView(host)),
    route('GET', 'assets', ({ query }) => { if (!host.assets) throw new RouteError(501, 'Asset catalog is not wired'); return { assets: host.assets.list(query) } }),
    route('GET', 'assets/:id/content', ({ params }) => { if (!host.assets) throw new RouteError(501, 'Asset catalog is not wired'); return host.assets.content(params.id!) }),
    route('GET', 'assets/:id', ({ params }) => { if (!host.assets) throw new RouteError(501, 'Asset catalog is not wired'); return host.assets.get(params.id!) }),
    route('GET', 'assets/:id/revisions', ({ params }) => { if (!host.assets) throw new RouteError(501, 'Asset catalog is not wired'); return { revisions: host.assets.revisions(params.id!) } }),
    route('POST', 'assets/import', async ({ body }) => { if (!host.assets) throw new RouteError(501, 'Asset catalog is not wired'); return host.assets.import(await body(6 * 1_048_576 + 16384)) }),
    route('PATCH', 'assets/:id', async ({ params, body }) => { if (!host.assets) throw new RouteError(501, 'Asset catalog is not wired'); return host.assets.patch(params.id!, await body()) }),
    route('DELETE', 'assets/:id', async ({ params, body }) => { if (!host.assets) throw new RouteError(501, 'Asset catalog is not wired'); return host.assets.delete(params.id!, await body()) }),
    route('GET', 'memories', ({ query }) => {
      if (host.memories === undefined) throw new RouteError(501, 'Memory lifecycle is not wired')
      return { memories: host.memories.list(query) }
    }),
    route('POST', 'memories', async ({ body }) => {
      if (host.memories === undefined) throw new RouteError(501, 'Memory lifecycle is not wired')
      return host.memories.propose(await body(), 'operator')
    }),
    route('POST', 'memories/:id/confirm', async ({ params, body }) => {
      if (host.memories === undefined) throw new RouteError(501, 'Memory lifecycle is not wired')
      return host.memories.confirm(params.id!, await body())
    }),
    route('PATCH', 'memories/:id', async ({ params, body }) => {
      if (host.memories === undefined) throw new RouteError(501, 'Memory lifecycle is not wired')
      return host.memories.patch(params.id!, await body())
    }),
    route('DELETE', 'memories/:id', async ({ params, body }) => {
      if (host.memories === undefined) throw new RouteError(501, 'Memory lifecycle is not wired')
      return host.memories.delete(params.id!, await body())
    }),
    route('GET', 'memories/:id/revisions', ({ params }) => {
      if (host.memories === undefined) throw new RouteError(501, 'Memory lifecycle is not wired')
      return { revisions: host.memories.revisions(params.id!) }
    }),
    route('GET', 'tickets', ({ query }) => {
      const filter = (query.get('state') ?? 'open') as 'open' | 'ended' | 'attention' | 'all' | 'deleted'
      const offset = number(query, 'offset', 0, 100_000)
      const limit = number(query, 'limit', 50, 200)
      const tickets = host.store.tickets.page(
        filter === 'open' || filter === 'ended' || filter === 'attention' || filter === 'all' || filter === 'deleted'
          ? filter
          : 'open',
        offset, limit)
      return { offset, limit, count: tickets.length, tickets: tickets.map(ticketSummary) }
    }),
    route('GET', 'tickets/:id', ({ params }) => {
      const ticket = host.engine.require(params.id!)
      return {
        ...ticketView(ticket),
        // What the worker claimed it produced, one entry per normalized path, with the report that claimed it. The
        // files route answers "what is on disk right now"; this answers "what did this Ticket say it made".
        artifacts: host.artifacts(params.id!),
        ...host.engine.citationsOf(params.id!),
        // P-1：手艺传承与产物引用分开暴露。面板分开渲染，聊天里的「借力」一句由 Delivery 自己聚合。
        ...host.engine.skillLineageOf(params.id!),
        /**
         * Where this Ticket's answer goes back to, read from the Trigger that asked — the only place an address was
         * ever written down (contract §3.3). Resolved here rather than in ticketView because a view computes what one
         * record says about itself, and this is a second record: the Trigger behind origin.triggerId.
         *
         * Absent for every one-way Source, which is exactly what the Delivery counts as nowhere.
         */
        replyTo: host.store.triggers.get(ticket.origin.triggerId)?.trigger.replyTo,
        // 【W34】Thread the Trigger that created this Ticket belongs to — plus the other Tickets subscribed.
        threadKey: host.store.triggers.get(ticket.origin.triggerId)?.trigger.threadKey,
        thread: (() => {
          const key = host.store.triggers.get(ticket.origin.triggerId)?.trigger.threadKey
          if (key === undefined) return undefined
          const t = host.engine.getThread(key)
          if (t === undefined) return undefined
          const otherIds = t.subscriptions.filter(id => id !== ticket.id)
          const others = otherIds.map(id => host.store.tickets.get(id))
            .filter((t): t is NonNullable<typeof t> => t !== undefined)
            .map(t => ({ id: t.id, title: t.title, stage: ticketStage(t) }))
          return { key, subscriptions: t.subscriptions.length, others }
        })(),
      }
    }),
    route('POST', 'attachments/upload', async ({ body }) => {
      const request = z.object({ filename: z.string(), data: z.string() }).strict().parse(await body(UPLOAD_BODY_BYTES))
      host.uploads.cleanup(id => { const ticket = host.store.tickets.get(id); return ticket !== undefined && ticket.ended === undefined })
      return host.uploads.save(request.filename, request.data)
    }),
    route('POST', 'tickets', async ({ body }) => {
      const request = BodySchemas.create.parse(await body())
      const result = host.createTicketWithUploads({
        title: request.title, text: request.request, scope: request.scope, sender: request.sender,
        attachments: request.attachments, uploadIds: request.upload_ids,
      })
      host.passes.requestPass()
      const decision = result.disposition.state === 'accepted' || result.disposition.state === 'ignored' || result.disposition.state === 'observed'
        ? host.engine.decisionOf(result.disposition.decisionId) : undefined
      return {
        stored: result.stored, disposition: result.disposition.state, ticketId: result.ticketId,
        reason: decision?.reason, detail: decision?.detail, acceptMode: host.settings().acceptMode,
      }
    }),
    route('POST', 'tickets/:id/answer', async ({ params, body }) => {
      const request = BodySchemas.text.parse(await body())
      const ticket = host.engine.answer(params.id!, request.text)
      host.passes.requestPass()
      return ticketView(ticket)
    }),
    // Project, Work and the edges between Tickets. ?archived=1 includes the archived ones. Lists are for choosing,
    // so they hide archived by default (U21); a detail view is for reading, so it never hides anything.
    route('GET', 'projects', ({ query }) => ({ projects: host.engine.projects(query.get('archived') === '1') })),
    route('POST', 'projects', async ({ body }) => host.engine.createProject(BodySchemas.project.parse(await body()))),
    route('GET', 'projects/:id', ({ params }) => {
      const project = host.engine.project(params.id!)
      if (project === undefined) throw new RouteError(404, 'No Project has this id')
      // Archived Works are included here on purpose: opening a Project to read it must not look like losing data.
      return { project, works: host.engine.works(project.id, true) }
    }),
    route('GET', 'works', ({ query }) => ({
      works: host.engine.works(query.get('project') ?? undefined, query.get('archived') === '1'),
    })),
    // Archive / unarchive / delete, for Projects and Works (U21). POST rather than DELETE: a delete here is a command
    // with a result the caller has to read (how many Tickets lost their Work).
    route('POST', 'projects/:id/archive', ({ params }) => host.engine.archiveProject(params.id!)),
    route('POST', 'projects/:id/unarchive', ({ params }) => host.engine.unarchiveProject(params.id!)),
    route('POST', 'projects/:id/delete', ({ params }) => host.engine.deleteProject(params.id!)),
    route('POST', 'works/:id/archive', ({ params }) => host.engine.archiveWork(params.id!)),
    route('POST', 'works/:id/unarchive', ({ params }) => host.engine.unarchiveWork(params.id!)),
    route('POST', 'works/:id/delete', ({ params }) => host.engine.deleteWork(params.id!)),
    // Both options default to the reversible end: keeping the assets and keeping a tombstone. An operator who wants the
    // stronger version has to say so twice, and the panel makes them read what it costs first.
    route('POST', 'tickets/:id/delete', async ({ params, body }) =>
      host.deleteTicket(params.id!, BodySchemas.deleteTicket.parse(await body()))),
    route('POST', 'works', async ({ body }) => host.engine.createWork(BodySchemas.work.parse(await body()))),
    route('GET', 'works/:id', ({ params }) => {
      const work = host.engine.work(params.id!)
      if (work === undefined) throw new RouteError(404, 'No Work has this id')
      return { work, tickets: host.engine.ticketsOfWork(work.id).map(ticketSummary) }
    }),
    route('POST', 'tickets/:id/work', async ({ params, body }) => {
      const request = BodySchemas.workId.parse(await body())
      return ticketView(host.engine.attachWork(params.id!, request.workId))
    }),
    route('GET', 'tickets/:id/events', ({ params, query }) => {
      const events = host.engine.history(params.id!)
      // Newest first, because a panel shows what just happened; the log itself stays oldest-first, which is the order
      // the facts occurred in and the order seq counts them.
      const limit = Number(query.get('limit') ?? '200')
      const clipped = Number.isFinite(limit) && limit > 0 ? events.slice(-limit) : events
      return { count: events.length, returned: clipped.length, events: [...clipped].reverse() }
    }),
    route('GET', 'tickets/:id/dependencies', ({ params }) => ({
      // What it waits for, what waits for it, and which of the former are still unsatisfied.
      waitsFor: host.engine.blockedBy(params.id!),
      waitedOnBy: host.engine.dependantsOf(params.id!),
    })),
    route('POST', 'tickets/:id/dependencies', async ({ params, body }) => {
      const request = BodySchemas.dependency.parse(await body())
      const dependency = host.engine.dependOn(params.id!, request.upstream, request.on)
      // A new edge can release nothing, but it can hold a launch that is already queued, so let the pump look again.
      host.passes.requestPass()
      return dependency
    }),
    route('POST', 'tickets/:id/dependencies/drop', async ({ params, body }) => {
      const request = BodySchemas.dependency.parse(await body())
      host.engine.dropDependency(params.id!, request.upstream)
      host.passes.requestPass()
      return { dropped: request.upstream, waitsFor: host.engine.blockedBy(params.id!) }
    }),
    route('POST', 'tickets/:id/note', async ({ params, body }) => {
      const request = BodySchemas.text.parse(await body())
      const ticket = host.engine.note(params.id!, request.text)
      host.passes.requestPass()
      return ticketView(ticket)
    }),
    route('POST', 'tickets/:id/dismiss', ({ params }) => host.engine.dismissUncertainTicket(params.id!)),
    route('POST', 'tickets/:id/stop', async ({ params, body }) => {
      const request = BodySchemas.reason.parse(await body(16 * 1024))
      const ticket = host.engine.stopTicket(params.id!, request.reason ?? 'A person stopped this Ticket')
      host.passes.requestPass()
      return ticketView(ticket)
    }),
    route('POST', 'tickets/:id/retry', ({ params }) => {
      const ticket = host.engine.retryTicket(params.id!)
      host.passes.requestPass()
      return ticketView(ticket)
    }),
    // 【机制补口】新增一条决断的门：与 runtime 自己、worker 工具走同一个写入者。
    route('POST', 'decisions', async ({ body }) => {
      const payload = await body() as Record<string, unknown>
      const title = String(payload.title ?? '').trim()
      const detail = String(payload.detail ?? '').trim()
      if (title === '' || detail === '') throw new RouteError(400, 'A decision needs both a title and a detail (the detail is where the trade-off lives)')
      const id = host.raiseDecision(title, detail, String(payload.source ?? 'external'))
      return { raised: id, queue: host.decisions().length }
    }),
    // A Decision is what a person dismisses ("I saw this refusal, it is fine"), so it lives under decisions.
    route('POST', 'decisions/:id/dismiss', ({ params }) => {
      const id = params.id!
      host.engine.dismiss(id)
      return { dismissed: id, decision: decisionView(host.store.decisions.get(id)!) }
    }),
    // What a person can start from: the shipped recipes, so a request is edited rather than written from nothing.
    route('GET', 'recipes', () => host.recipes()),
    // What a worker is doing right now: the panel polls this while the operator watches a long task.
    route('GET', 'tickets/:id/progress', ({ params }) => host.progress(params.id!)),
    // What a run produced, so seeing whether anything came out does not need a terminal.
    route('GET', 'tickets/:id/files', async ({ params }) => {
      const ticket = host.engine.require(params.id!)
      const directory = ticket.execution?.directory
      if (directory === undefined) return { directory: undefined, files: [], count: 0, truncated: false }
      // 【G-3 站点 4】列举走沙箱：走查规则在 files.ts（形状共享），边界动作在这里归沙箱。
      return { directory, ...(await host.executor.sandbox.listWorkspace(directory)) }
    }),
    // One file: text is shown, anything else is handed over as base64 for the panel to turn into a download.
    route('GET', 'tickets/:id/file', async ({ params, query }) => {
      const ticket = host.engine.require(params.id!)
      const directory = ticket.execution?.directory
      if (directory === undefined) throw new RouteError(404, 'This Ticket has no directory')
      const requested = query.get('path') ?? ''
      if (requested === '') throw new RouteError(400, 'A path is required')
      // A ../ here would turn a file route into a way out of the Ticket's directory.
      const lexical = resolveInside(directory, requested)
      if (lexical === undefined) throw new RouteError(400, "That path is outside this Ticket's directory")
      let info
      try { info = await lstat(lexical) } catch { throw new RouteError(404, 'There is no file at ' + requested) }
      if (info.isSymbolicLink()) throw new RouteError(400, "That path is outside this Ticket's directory (symbolic links are refused)")
      if (info.isDirectory()) throw new RouteError(400, requested + ' is a directory')
      const absolute = await resolveRealInside(directory, requested)
      if (absolute === undefined) throw new RouteError(400, "That path is outside this Ticket's directory")
      if (info.size > MAX_FILE_BYTES) {
        throw new RouteError(400, requested + ' is ' + (info.size / 1_048_576).toFixed(1) + ' MB; the panel serves up to '
          + Math.floor(MAX_FILE_BYTES / 1_048_576) + ' MB. Open it where it is: ' + absolute)
      }
      // 【G-3 站点 4】读取同理：路径校验（上面的 resolveRealInside）是 policy 留在路由，字节搬运归沙箱。
      return { path: requested, absolute, text: isTextFile(requested, info.size), ...(await host.executor.sandbox.readWorkspaceFile(absolute)) }
    }),
    // The schedule list, with the next run of each computed in the host's own zone.
    route('GET', 'schedules', () => {
      const now = Date.now()
      const last = host.sourceStatus().cron?.lastTriggerAt
      return {
        zone: localZone(), now: new Date(now).toISOString(), lastTriggerAt: last,
        schedules: host.settings().sources.cron.schedules.map(schedule => scheduleView(schedule, now)),
      }
    }),
    // What a schedule a person is editing would actually do: validated, and with its next few runs named.
    route('POST', 'schedules/preview', async ({ body }) => {
      const parsed = ScheduleSchema.safeParse(await body())
      if (!parsed.success) {
        const issues = parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
        throw new RouteError(400, 'That schedule cannot be used: ' + issues.map(issue => issue.message).join('; '), issues)
      }
      const now = Date.now()
      const runs: string[] = []
      // Walk the next few runs rather than one, so a weekday-only or monthly schedule shows what it means.
      for (let at = now; runs.length < 3;) {
        const next = nextRun(parsed.data.timing, new Date(at))
        if (next === undefined) break
        runs.push(new Date(next).toISOString())
        at = next
      }
      return {
        schedule: scheduleView(parsed.data, now), next: runs, zone: localZone(),
        describe: describeTiming(parsed.data.timing),
        ...(runs.length === 0 ? { warning: 'This timing never matches: no run could be computed.' } : {}),
      }
    }),
    route('GET', 'decisions', ({ query }) => {
      const limit = number(query, 'limit', 50, 500)
      const decisions = host.store.decisions.list(limit)
      return {
        count: decisions.length,
        decisions: decisions.map(decision => decisionView(decision, host.store.triggers.get(decision.triggerId)?.trigger.title)),
      }
    }),
    /**
     * 【W33】What the desk decided without the operator: a triage Ticket the desk answered or dropped on its own.
     * A judge that acts unattended has to leave a readable trail, or "the system ignored that message" and "the system
     * decided that message needed nothing" are the same thing from the operator's chair.
     */
    route('GET', 'desk-decisions', ({ query }) => {
      const limit = number(query, 'limit', 30, 200)
      const rows = host.store.tickets.list()
        .filter(ticket => ticket.ended !== undefined && ticket.assignments.some(item => item.role === 'triage'))
        .sort((a, b) => (b.ended?.at ?? '').localeCompare(a.ended?.at ?? ''))
        .slice(0, limit)
        .map(ticket => ({
          id: ticket.id,
          title: ticket.title,
          outcome: ticket.ended?.outcome ?? 'unknown',
          at: ticket.ended?.at ?? ticket.createdAt,
          said: ticket.result?.summary ?? '',
          via: ticket.mandate.via,
          sender: ticket.mandate.sender.id,
          // Whether there was anywhere to answer. Absent means the decision was recorded and told to nobody,
          // which is the one case worth seeing rather than assuming.
          answerable: host.store.triggers.get(ticket.origin.triggerId)?.trigger.replyTo !== undefined,
        }))
      return { count: rows.length, decisions: rows }
    }),
    // 【D7】Desk LLM routes ──────────────────────────────────────────────────────────────
    route('GET', 'conversations', ({ query }) => ({ conversations: (host.conversations ?? new Conversations(host.store)).list({ limit: query.has('limit') ? Number(query.get('limit')) : undefined, includeArchived: query.get('includeArchived') === 'true', profileId: query.get('profileId') ?? undefined }) })),
    route('POST', 'conversations', async ({ body }) => {
      const input = z.object({ title: z.string().optional(), profileId: z.string().optional() }).strict().parse(await body())
      return { conversation: (host.conversations ?? new Conversations(host.store)).create(input) }
    }),
    route('POST', 'conversations/from-task', async ({ body }) => {
      const input = z.object({ ticketId: z.string().trim().min(1), title: z.string().optional() }).strict().parse(await body())
      return { conversation: (host.conversations ?? new Conversations(host.store)).fromTask(input) }
    }),
    route('GET', 'conversations/:id', ({ params }) => ({ conversation: (host.conversations ?? new Conversations(host.store)).get(params.id!) })),
    route('PATCH', 'conversations/:id', async ({ params, body }) => {
      const input = z.object({ title: z.string(), expectedRevision: z.number().int().positive() }).strict().parse(await body())
      return { conversation: (host.conversations ?? new Conversations(host.store)).rename(params.id!, input.title, input.expectedRevision) }
    }),
    ...(['archive', 'restore'] as const).map(action => route('POST', 'conversations/:id/' + action, async ({ params, body }) => {
      const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await body())
      return { conversation: (host.conversations ?? new Conversations(host.store))[action](params.id!, input.expectedRevision) }
    })),
    route('DELETE', 'conversations/:id', async ({ params, body }) => {
      const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await body())
      return { conversation: (host.conversations ?? new Conversations(host.store)).delete(params.id!, input.expectedRevision) }
    }),
    route('GET', 'conversations/:id/messages', ({ params, query }) => {
      if (host.conversations !== undefined || host.conversationMessages === undefined) {
        try { return (host.conversations ?? new Conversations(host.store)).messages(params.id!, { limit: query.has('limit') ? Number(query.get('limit')) : undefined, before: query.get('before') ?? undefined, since: query.get('since') ?? undefined }) }
        catch (error) { if (error instanceof RangeError) throw new RouteError(400, error.message); throw error }
      }
      if (host.conversationMessages === undefined) throw new RouteError(501, 'Conversation history is not wired')
      const limit = number(query, 'limit', 100, 500)
      return { messages: host.conversationMessages(params.id!, limit) }
    }),
    route('POST', 'conversations/:id/message', async ({ params, body }) => {
      if (host.conversationTurn === undefined) throw new RouteError(501, 'The conversation coordinator is not wired')
      const payload = await body()
      const text = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).text : undefined
      if (typeof text !== 'string' || text.trim() === '') throw new RouteError(400, 'A non-empty text is required')
      const model = (payload as Record<string, unknown>).model
      if (model !== undefined && (typeof model !== 'string' || model.trim() === '' || model.length > 200)) throw new RouteError(400, 'model must be a non-empty saved model name of at most 200 characters')
      try {
        if (host.conversations !== undefined || host.store !== undefined) (host.conversations ?? new Conversations(host.store)).assertWritable(params.id!, true)
        return await host.conversationTurn(params.id!, text, model as string | undefined)
      } catch (error) {
        if (error instanceof ConversationError) throw error
        throw new RouteError(error instanceof RangeError ? 400 : 503, error instanceof Error ? error.message : String(error))
      }
    }),
    route('GET', 'model/config', () => {
      if (!host.modelConfig) throw new RouteError(501, 'Model settings are not wired')
      return host.modelConfig()
    }),
    route('PUT', 'model/config', async ({ body }) => {
      if (!host.saveModelConfig) throw new RouteError(501, 'Model settings are not wired')
      try { return await host.saveModelConfig(await body()) }
      catch (error) { throw new RouteError(400, error instanceof Error ? error.message : 'Could not save model configuration') }
    }),
    route('POST', 'model/test', async ({ body }) => {
      if (!host.testModel) throw new RouteError(501, 'Model test is not wired')
      try { return await host.testModel(await body()) }
      catch (error) { throw new RouteError(400, error instanceof Error ? error.message : 'Model test failed') }
    }),
    route('POST', 'model/models', async ({ body }) => {
      if (!host.listModels) throw new RouteError(501, 'Model list is not wired')
      try { return await host.listModels(await body()) }
      catch (error) { throw new RouteError(400, error instanceof Error ? error.message : 'Model list failed') }
    }),
    route('GET', 'execution/status', () => {
      if (host.executionStatus === undefined) throw new RouteError(501, 'Execution status is not wired')
      return host.executionStatus()
    }),
    route('POST', 'execution/check', async () => {
      if (host.checkExecution === undefined) throw new RouteError(501, 'Execution check is not wired')
      return await host.checkExecution()
    }),
    route('GET', 'desk/status', () => {
      const loop = host.desk
      if (loop === undefined) return { state: 'disabled', configured: false, provider: '', model: '', recentErrors: [] }
      return loop.status()
    }),
    route('GET', 'desk/messages', ({ query }) => {
      const afterRaw = query.get('after'); const after = afterRaw !== null ? Math.max(0, parseInt(afterRaw, 10) || 0) : 0
      const limit = number(query, 'limit', 50, 200)
      const messages = host.store.deskHistory.since(after, limit)
      return { messages, latestSeq: host.store.deskHistory.latestSeq() }
    }),
    route('GET', 'desk/providers', async () => {
      // 未接入是显式的 501：provider 枚举随 DeskLoop / P2-T3 client 的接入方到来，绝不假装空列表。
      if (host.deskProviders === undefined) {
        throw new RouteError(501, 'desk/providers is not wired yet: provider enumeration arrives with the DeskLoop/LLM client card')
      }
      return { providers: await host.deskProviders() }
    }),
    // ─────────────────────────────────────────────────────────────────────────────────────
    route('GET', 'triggers', ({ query }) => {
      const limit = number(query, 'limit', 50, 500)
      const records = host.store.triggers.since('', limit)
      return {
        count: records.length,
        triggers: records.map(record => ({
          id: record.trigger.id, source: record.trigger.source, kind: record.trigger.kind, at: record.trigger.at,
          title: record.trigger.title, actor: record.trigger.actor, disposition: record.disposition,
        })),
      }
    }),
    /**
     * What was lost, on both of the paths §4.42 split it into, kept visibly apart.
     *
     * rows are the requests that were understood and then dropped; payloads are the ones that could not be understood
     * at all, which are deliberately in no table and in no count — a route that merged the two would hide which of
     * the two happened, and the second is the one where the only thing left to read is the text.
     */
    route('GET', 'lost', ({ query }) => {
      const limit = number(query, 'limit', 50, 500)
      // list() rather than since(): since is a NEWEST window, so a producer broken on every firing pushes an older
      // loss out of it while countBySource still counts it — a list that disagrees with the number beside it.
      const lost: { id: string; source: string; kind: string; at: string; title?: string; error: string; effectKey: string }[] = []
      for (const record of host.store.triggers.list()) {
        const disposition = record.disposition
        if (disposition.state !== 'lost') continue
        const trigger = record.trigger as { title?: unknown }
        lost.push({
          id: record.trigger.id, source: record.trigger.source, kind: record.trigger.kind, at: record.trigger.at,
          ...(typeof trigger.title === 'string' && trigger.title.trim() !== '' ? { title: trigger.title } : {}),
          error: disposition.error, effectKey: disposition.effectKey,
        })
      }
      // list() reads oldest first; an operator reads the newest loss first, and the page has no other order to go by.
      lost.reverse()
      return {
        // Both numbers, so a list shorter than the total says so instead of looking complete.
        total: lost.length,
        shown: Math.min(lost.length, limit),
        rows: lost.slice(0, limit),
        // Newest first, all of them: the Store already bounds this list, so there is nothing left to page through.
        payloads: host.store.lostPayloads().slice().reverse(),
        // The bounds the Store keeps these under, so the page states them from the build that enforces them.
        bounds: { keep: LOST_TRIGGER_KEEP, chars: LOST_TRIGGER_CHARS },
      }
    }),
    route('PUT', 'settings', async ({ body }) => {
      const settings = host.saveSettings(await body())
      host.passes.requestPass()
      return { settings, settingsRevision: host.store.settingsRevision() }
    }),
    route('GET', 'prompts', () => ({
      revision: host.prompts.revision(), maxChars: host.machine.promptMaxChars(),
      roles: PROMPT_ROLES.map(role => ({
        role, current: host.prompts.current(role), base: host.prompts.base(role), override: host.prompts.config()[role],
        // An override that only repeats the shipped text pins the role to it, which the panel marks.
        pinsBase: host.prompts.overrideIsBase(role),
      })),
      skills: host.prompts.skills(),
      // The three built-ins come from the server as well, so the page is not the second owner of a fact this bundle
      // holds: same list, one owner.
      builtInSkills: builtInSkillsView(),
    })),
    // 更新内容页：单一所有者在 about.ts，面板照抄。路由本身是纯函数。
    route('GET', 'changes', () => ({ changes: changesView().changes })),
    route('GET', 'operator-queue', async () => ({ items: host.decisions() })),
    route('POST', 'operator-queue/:id/dismiss', async ({ params }) => {
      host.dismissDecision(params.id!)
      return {}
    }),
    route('POST', 'prompts/skills/:name/validate', async ({ params, body }) => {
      if (!host.skillCandidates) throw new RouteError(501, 'Skill candidate validation is not wired')
      const input = z.object({ expectedRevision: z.number().int().positive(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body())
      return { skill: await host.skillCandidates.validate(params.name!, input) }
    }),
    route('POST', 'prompts/skills/:name/approve', async ({ params, body }) => {
      if (!host.skillCandidates) throw new RouteError(501, 'Skill candidate approval is not wired')
      const input = z.object({ expectedRevision: z.number().int().positive(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body())
      return { skill: host.skillCandidates.approve(params.name!, input) }
    }),
    route('POST', 'prompts/skills/:name/toggle', async ({ params, body }) => {
      const parsed = z.object({ enabled: z.boolean() }).strict().parse(await body())
      const skill = host.prompts.setSkillEnabled(params.name!, parsed.enabled)
      return { revision: host.prompts.revision(), skill }
    }),
    route('POST', 'prompts/skills/:name/delete', ({ params }) => {
      host.prompts.removeSkill(params.name!)
      return { revision: host.prompts.revision(), deleted: params.name! }
    }),
    route('PUT', 'prompts', async ({ body }) => {
      const request = BodySchemas.prompts.parse(await body(512 * 1024))
      const revision = host.prompts.save(request)
      host.passes.requestPass()
      return { revision }
    }),
    route('POST', 'pass', async () => {
      await host.nudge()
      return { requested: true, effects: host.store.effectCounts() }
    }),
    // The main Session is created on demand, never at mount: an agent born during activation is torn down with it.
    route('POST', 'main-session', async () => {
      const result = await host.createMainSession()
      if (result.error !== undefined) throw new RouteError(400, result.error)
      return result
    }),
    route('GET', 'effects', () => ({ counts: host.store.effectCounts() })),
  ]
}

/** The request bodies the panel may send. */
const BodySchemas = {
  /**
   * What a deletion removes (S4). Two independent axes, because they are two different losses:
   * assets is the produced files (recoverable only from a backup), record is the Ticket itself.
   * .strict() so a misspelled option is refused rather than silently treated as the default.
   */
  deleteTicket: z.object({
    assets: z.enum(['keep', 'delete']).default('keep'),
    record: z.enum(['tombstone', 'nothing']).default('tombstone'),
  }).strict(),
  create: z.object({
    // Trimmed rather than merely non-empty: whitespace would wake a worker with nothing to read.
    title: z.string().trim().min(1).max(200), request: z.string().trim().min(1).max(20_000),
    scope: z.string().trim().max(2_000).optional(), sender: z.string().trim().max(120).optional(),
    attachments: z.array(z.string().trim().min(1).max(4_000)).max(20).optional(),
    upload_ids: z.array(z.string().min(1).max(100)).max(10).optional(),
  }).strict().refine(value => (value.upload_ids?.length ?? 0) === 0 || (value.upload_ids?.length ?? 0) + (value.attachments?.length ?? 0) <= 10, 'At most 10 files can be attached with browser uploads'),
  text: z.object({ text: z.string().trim().min(1).max(20_000) }).strict(),
  reason: z.object({ reason: z.string().trim().max(500).optional() }).strict(),
  prompts: z.object({ worker: z.string().max(1_000_000).optional(), orchestrator: z.string().max(1_000_000).optional(), triage: z.string().max(1_000_000).optional() }).strict(),
  project: z.object({ name: z.string().trim().min(1).max(120), note: z.string().trim().max(2_000).optional() }).strict(),
  work: z.object({
    name: z.string().trim().min(1).max(120),
    projectId: z.string().trim().min(1).max(64).optional(),
    scope: z.string().trim().max(2_000).optional(),
    note: z.string().trim().max(2_000).optional(),
  }).strict(),
  workId: z.object({ workId: z.string().trim().min(1).max(64) }).strict(),
  dependency: z.object({
    upstream: z.string().trim().min(1).max(64),
    // done waits for success; ended accepts any ending, which is how work that must happen either way is expressed.
    on: z.enum(['done', 'ended']).optional(),
  }).strict(),
}

/**
 * The panel page, read from this installation. The one copy is panel/index.html (P1-T3); a build without it must say
 * so (A7) rather than serve an empty page.
 */
export function panelPage(): string {
  return readFileSync(packageFile(PANEL_FILE), 'utf8')
}

/**
 * Serve the panel and its API on Ordin's own HTTP server.
 * @returns the actual port/url plus drain (handler-level) and close (socket-level).
 */
export async function serve(host: HttpHost, options: { port?: number; host?: string } = {}): Promise<Serving> {
  const routes = table(host)
  let closing = false
  const active = new Set<Promise<void>>()
  const drain = async (): Promise<void> => { while (active.size > 0) await Promise.all([...active]) }
  const runHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const prefix = PREFIXES.find(p => url.pathname === p || url.pathname.startsWith(p + '/')) ?? BASE_PATH
    const api = prefix + '/api/'
    if (!url.pathname.startsWith(api)) {
      // The standalone chat page lives beside the old panel while the panel is rebuilt (M2-D).
      if (method === 'GET' && ['/chat', '/chat/', '/workspace', '/workspace/', '/assets', '/assets/'].some(path => url.pathname === prefix + path)) {
        try {
          const html = readFileSync(packageFile(url.pathname.startsWith(prefix + '/workspace') ? 'panel/workspace.html' : url.pathname.startsWith(prefix + '/assets') ? 'panel/assets.html' : 'panel/chat.html'), 'utf8')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(html)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('ordin could not read its chat page: ' + (error instanceof Error ? error.message : String(error)))
        }
        return
      }
      if (method !== 'GET' || (url.pathname !== prefix + '/' && url.pathname !== prefix && url.pathname !== prefix + '/index.html')) {
        res.writeHead(404).end()
        return
      }
      try {
        const html = host.panelHtml()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        res.end(html)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('ordin could not read its panel page: ' + (error instanceof Error ? error.message : String(error)))
      }
      return
    }
    // 实际本地端口就是本服务绑定的端口（port 0 时 listen 之后才知道），比配置值更可信（A2）。
    if (!sameOrigin(req, req.socket.localPort)) { json(res, 403, { error: 'A same-origin management request is required' }); return }
    try {
      // match 也在 try 里：参数里的坏 % 转义会让 decodeURIComponent 抛 URIError，那必须是一个 JSON 错误响应，
      // 不是挂起的 socket（A7）。未知路由的 404 同样从这里出去。
      const found = match(routes, method, url.pathname.slice(api.length).split('/').filter(Boolean))
      if (found === undefined) { json(res, 404, { error: 'No route for ' + method + ' ' + url.pathname }); return }
      json(res, 200, await found.route.run({ params: found.params, query: url.searchParams, body: maxBytes => readBody(req, maxBytes) }))
    } catch (error) {
      const [status, payload] = failure(error)
      json(res, status, payload)
    }
  }
  const server = await startServer((req, res) => {
    if (closing) { json(res, 503, { error: 'ordin is stopping' }); return }
    let finish!: () => void
    const current = new Promise<void>(resolve => { finish = resolve })
    active.add(current)
    void runHandler(req, res).catch(error => {
      // runHandler 自己把路由错误映射成响应；到这里说明响应写出本身失败了——错误必须可见（A7）。
      host.context.logger.error('ordin — HTTP response failed', error)
    }).finally(() => { active.delete(current); finish() })
  }, {
    port: options.port,
    host: options.host,
    onError: error => host.context.logger.error('ordin — HTTP handler failed', error),
  })
  const close = async (): Promise<void> => {
    closing = true
    const stopped = server.close()
    await drain()
    // Node 只在 close() 当时关一次空闲连接；已 drain，剩下的都是后来才空闲的 keep-alive socket，
    // 关掉它们 'close' 事件才立刻到来——几秒的面板 keep-alive 不该拖住进程收尾。
    server.forceClose()
    await stopped
  }
  return { port: server.port, url: server.url, drain, close }
}
