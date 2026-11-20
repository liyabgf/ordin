/**
 * Consuming `<channel directory>/out/` — the replies ordin owes back to the platform.
 *
 * The Source writes `out/reply-<hash>.md`, where the hash is a pure function of (channel, thread, text), so a
 * retried delivery writes the SAME BYTES under the SAME NAME. That is what makes at-least-once delivery safe here:
 *
 * - the file is moved to `out/sent/` only AFTER the platform accepted it, so a crash between reading and sending
 *   re-sends rather than silently dropping (an answer that never arrived must not be indistinguishable from an
 *   answer that was never owed);
 * - a name already in `sent/` is skipped AND its duplicate removed from `out/`, so ordin retrying the same
 *   reply neither posts it to the room twice nor leaves a permanent "answer nobody collected" in `out/` —
 *   the count ordin reports as `pendingReplies`, whose whole job is to mean "the bridge is not running".
 *
 * Files are never deleted on success, only moved: what the operator's colleagues received is worth keeping, and
 * `keepDays` prunes it on an age the operator chooses.
 */
import { lstat, mkdir, readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parse } from './frontmatter.mjs'
import { describeError } from './log.mjs'

const OUT = 'out'
const SENT = 'sent'

/**
 * Reserved for the `【i/N】 ` marker, so a marked piece still fits the platform's limit.
 *
 * Three digits on both sides is 10 characters; 12 leaves room for the space and for a platform that counts slightly
 * differently than JS does.
 */
const MARKER_RESERVE = 12

/**
 * Split a reply into pieces a platform will actually accept.
 *
 * Why this exists: a long report is not a long message. Telegram refuses anything over 4096 UTF-16 code units with
 * `message is too long`, and because the file is only archived AFTER the platform accepts it, a reply that can never
 * be accepted is retried forever — ordin's own `send` effect already succeeded (it wrote the file), so the panel
 * says "delivered" while the room says nothing. That is the third shape of the silence this whole system exists to
 * prevent: not a missing address, not a missing report, but an answer too big for the door it was sent through.
 *
 * Split on line boundaries and pack greedily, so paragraph structure survives (a blank line is just an empty line in
 * the split, and joining with `\n` puts it back). A single line longer than one whole message is hard-cut — and never
 * through a surrogate pair, because half an emoji is a different character than the one that was written.
 *
 * The payload is lossless: strip the `【i/N】 ` markers, join with `\n`, and you get the original text back.
 *
 * @param {string} text
 * @param {number} limit 0 or less means "no limit", which is what a platform with an unverified limit should pass.
 * @returns {string[]} one piece when nothing needs splitting, so short replies are byte-identical to before
 */
export function chunkText(text, limit) {
  if (!(limit > 0) || text.length <= limit) return [text]
  const budget = Math.max(1, limit - MARKER_RESERVE)
  const pieces = []
  let current = ''
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`
    if (candidate.length <= budget) { current = candidate; continue }
    if (current !== '') { pieces.push(current); current = '' }
    if (line.length <= budget) { current = line; continue }
    for (const slice of hardCut(line, budget)) pieces.push(slice)
  }
  if (current !== '') pieces.push(current)
  const total = pieces.length
  return pieces.map((piece, index) => `【${index + 1}/${total}】 ${piece}`)
}

/** Cut one over-long line into budget-sized slices, backing off a surrogate pair rather than splitting it. */
function hardCut(line, budget) {
  const pieces = []
  let rest = line
  while (rest.length > budget) {
    let at = budget
    const code = rest.charCodeAt(at)
    if (code >= 0xdc00 && code <= 0xdfff) at -= 1   // `at` sits on the second half of a pair: take one less
    pieces.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}

async function readText(path) {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}

/**
 * @param {object} options
 * @param {string} options.directory  the channel directory (the one that holds inbound `*.md` and an `out/`)
 * @param {(reply: { thread: string | undefined, text: string, name: string }) => Promise<void>} options.send
 * @param {{ info?: Function, warn?: Function, error?: Function }} [options.log]
 * @param {number} [options.keepDays] how long delivered replies are kept in `out/sent/` (0 keeps them forever)
 * @param {number} [options.limit] the platform's per-message character limit; 0 or omitted sends the reply as one
 *   piece, which is right for a platform whose limit has not been verified rather than a guess that splits replies
 *   for no reason.
 * @returns {Promise<{ sent: number, failed: number, skipped: number, partial: number, unknown: number }>}
 */
/** Maximum size of a single outbound file attachment (20 MB). */
export const MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024

export async function drainOut({ directory, send, sendFile, onSent, log = {}, keepDays = 7, limit = 0 }) {
  const out = join(directory, OUT)
  const sent = join(out, SENT)
  const tally = { sent: 0, failed: 0, skipped: 0, partial: 0, unknown: 0 }
  let entries
  try {
    entries = await readdir(out, { withFileTypes: true })
  } catch {
    return tally   // no `out/` yet: nothing has been owed back so far, which is not an error
  }
  let delivered
  try {
    delivered = new Set(await readdir(sent))
  } catch {
    delivered = new Set()
  }
  for (const entry of entries) {
    // Top-level `*.md` only, and never a dotfile: `sent/` is a directory, and a temporary is dot-prefixed.
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.toLowerCase().endsWith('.md')) continue
    if (delivered.has(entry.name)) {
      // 【误报修正】A name already in `sent/` is the SAME ANSWER, already delivered: the file name is a pure
      // hash of (channel, thread, text), so ordin retrying a send writes byte-identical content under the
      // same name. Skipping without removing left that duplicate in `out/` FOREVER — and `out/`'s top-level
      // count is exactly what ordin reports as `pendingReplies`, a column whose documented meaning is
      // "non-zero for a while means the bridge is not running". A production channel sat at 3 for a day with a
      // live heartbeat and three delivered answers, so the one number that says "your room heard nothing"
      // said it about answers the room had already received. The record is kept: the delivered copy in
      // `sent/` is the one worth keeping (and `keepDays` prunes it); the duplicate records nothing new.
      await rm(join(out, entry.name), { force: true }).catch(error => {
        log.warn?.('reply-duplicate-kept', { name: entry.name, error: String(error?.message ?? error) })
      })
      log.debug?.('reply-duplicate-removed', { name: entry.name, note: 'already in sent/' })
      tally.skipped += 1
      continue
    }
    const path = join(out, entry.name)
    let text
    try {
      text = await readText(path)
    } catch (error) {
      log.warn?.('reply-unreadable', { name: entry.name, error: String(error) })
      tally.failed += 1
      continue
    }
    const { fields, body } = parse(text)
    const thread = fields.thread === '' || fields.thread === undefined ? undefined : fields.thread
    const ticket = fields.ticket === '' || fields.ticket === undefined ? undefined : fields.ticket
    const files = (fields.files ?? '').split(',').map(f => f.trim()).filter(Boolean)
    const pieces = chunkText(body, limit)
    const statePath = join(out, `.${entry.name}.delivery.json`)
    const legacyPath = join(out, `.${entry.name}.progress`)
    const key = createHash('sha256').update(JSON.stringify([text, pieces])).digest('hex')
    try {
      const saved = await readFile(statePath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error })
      if (saved === undefined) {
        // Older bridges did not record whether the last attempted part arrived.
        const legacy = await lstat(legacyPath).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (legacy) throw new Error('Legacy delivery progress needs manual confirmation')
      }
      const state = saved === undefined ? {
        key, text: pieces.map(() => ({ status: 'pending' })),
        files: files.map(filePath => ({ filePath, status: 'pending' })),
      } : JSON.parse(saved)
      const valid = item => ['pending', 'delivered', 'failed', 'unsupported', 'unknown'].includes(item?.status)
      if (state.key !== key || state.text?.length !== pieces.length || !state.text.every(valid) ||
          state.files?.length !== files.length || !state.files.every((item, i) => valid(item) && item.filePath === files[i])) {
        throw new Error('Delivery receipt does not match the queued reply')
      }
      const persist = async () => {
        const temp = statePath + '.' + randomUUID()
        try {
          await writeFile(temp, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
          await rename(temp, statePath)
        } finally { await rm(temp, { force: true }) }
      }
      const deliver = async (item, sendItem, label) => {
        // Record uncertainty before the external side effect. A crash here must never authorize a retry.
        item.status = 'unknown'
        delete item.reason
        await persist()
        let result
        try {
          result = await sendItem()
          item.status = result?.status === 'unknown' ? 'unknown' : 'delivered'
        } catch (error) {
          item.status = error?.deliveryStatus === 'failed' ? 'failed' : 'unknown'
          log.warn?.('reply-item-failed', { name: entry.name, item: label, status: item.status, ...describeError(error) })
        }
        await persist()
        return result
      }
      for (const [index, item] of state.text.entries()) {
        if (item.status === 'delivered') continue
        if (item.status === 'unknown') break
        const receipt = await deliver(item, () => send({
          thread, text: pieces[index], name: entry.name,
          ...(ticket === undefined ? {} : { ticket }),
          ...(pieces.length > 1 ? { part: index + 1, parts: pieces.length } : {}),
        }), index + 1)
        if (item.status !== 'delivered') break
        if (ticket !== undefined && receipt?.messageId !== undefined) {
          try { await onSent?.({ messageId: String(receipt.messageId), ticketId: ticket, thread }) }
          catch (error) { log.warn?.('reply-correlation-failed', { name: entry.name, ...describeError(error) }) }
        }
      }
      if (state.text.every(item => item.status === 'delivered')) {
        for (const item of state.files) {
          if (item.status !== 'pending' && item.status !== 'failed') continue
          const filePath = item.filePath
          if (!sendFile) {
            Object.assign(item, { status: 'unsupported', reason: 'channel-does-not-support-attachments' })
            await persist()
            continue
          }
          const info = await lstat(filePath).catch(error => {
            log.warn?.('reply-file-unreadable', { name: entry.name, filePath, ...describeError(error) })
          })
          if (!info || info.isSymbolicLink() || !info.isFile() || info.size > MAX_OUTBOUND_FILE_BYTES) {
            Object.assign(item, { status: info ? 'unsupported' : 'failed', reason: info ? 'file-policy' : 'file-unreadable' })
            await persist()
            continue
          }
          await deliver(item, () => sendFile({ thread, filePath, ticket, name: entry.name }), filePath)
        }
      }
      const items = [...state.text, ...state.files]
      if (!items.every(item => item.status === 'delivered')) {
        if (items.some(item => item.status === 'unknown')) tally.unknown += 1
        else if (items.some(item => item.status === 'delivered')) tally.partial += 1
        else tally.failed += 1
        continue
      }
      await mkdir(sent, { recursive: true })
      await rename(path, join(sent, entry.name))
      await rm(statePath, { force: true }).catch(error => {
        log.warn?.('reply-receipt-cleanup-failed', { name: entry.name, ...describeError(error) })
      })
    } catch (error) {
      tally.unknown += 1
      log.error?.('reply-receipt-unavailable', { name: entry.name, ...describeError(error) })
      continue
    }
    tally.sent += 1
    log.info?.('reply-sent', {
      name: entry.name, thread: fields.thread ?? null, chars: body.length,
      ...(pieces.length > 1 ? { parts: pieces.length } : {}),
      ...(files.length > 0 ? { files: files.length } : {}),
    })
  }
  if (keepDays > 0) await prune(sent, keepDays, log)
  return tally
}

/** Delete delivered replies older than `keepDays`, so `out/sent/` does not grow without bound. */
async function prune(sent, keepDays, log) {
  const cutoff = Date.now() - keepDays * 86_400_000
  let entries
  try {
    entries = await readdir(sent)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(sent, name)
    try {
      const info = await stat(path)
      if (info.mtimeMs < cutoff) { await rm(path); log.info?.('reply-pruned', { name }) }
    } catch { /* a file that vanished under us is already pruned */ }
  }
}
