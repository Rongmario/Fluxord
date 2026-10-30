import { Database } from 'bun:sqlite'
import { HttpError, rest, sleep, type FileUp } from './net'
import { permalink } from './attachments'
import { COMMAND, command } from './commands'
import { convert, displayName, join, reactsLine, snippet, type Look } from './render'

export interface Side {
  name: 'discord' | 'fluxer'
  api: string
  token: string
  maxContent: number
  maxUpload: number
  self: string
  server: string
  color: number
  other: Side
  avatar(user: any, member: any, guildId?: string): string | undefined
  sticker(sticker: any): string | undefined
  emoji?(id: string, animated: boolean): string
  jump(guildId: string, channelId: string, messageId: string): string
}

// root is the bridged channel on this side, hook is the bridged channel on the other side (owner of the webhook).
// A thread link has channel != root.
export type Link = { side: string; channel: string; other: string; root: string; hook: string; since: string }
type Row = { id: string; channel: string; hook: string; other: string; ours: boolean; author: string; reacts: string | null }
type Job = { id: number; side: string; type: string; data: string }

const THREADS = new Set([10, 11, 12])
const FORUMS = new Set([15, 16])
const RELAYED = new Set([0, 19, 20, 23])
const TEXT = /\.(md|txt|log|json|ya?ml|toml|ini|cfg|conf|properties|[cm]?[jt]sx?|py|java|kts?|gradle|xml|html?|css|sh|rs|go|c|cpp|h|hpp|cs|lua|sql|csv|diff|patch)$/i

let db: Database
const sides: Record<string, Side> = {}
export const channels = new Map<string, any>()
const roles = new Map<string, string>()
const perms = new Map<string, bigint>()
const owners = new Map<string, string>()

// Discord emoji/sticker id to its guild, so only the bridged guild's own expressions get copied to Fluxer.
const expressions = new Map<string, string>()
const serverEmojis = new Map<string, any>()
const serverStickers = new Map<string, any>()
const failed = new Set<string>()

export const snowflake = (ms = Date.now()) => ((BigInt(ms) - 1420070400000n) << 22n).toString()

export function start(path: string, pairs: { discord: string; fluxer: string }[], list: Side[], retention: { messages: number; dead: number }) {
  for (const s of list) sides[s.name] = s
  db = new Database(path)

  // One msg row per relayed message, keyed by the original's id. Copy channel and webhook come from link.
  db.exec(`
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dead (id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT, type TEXT, data TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS link (side TEXT, channel TEXT, other TEXT NOT NULL, root TEXT NOT NULL, hook TEXT NOT NULL, since TEXT NOT NULL, PRIMARY KEY (side, channel));
    CREATE TABLE IF NOT EXISTS hook (side TEXT, channel TEXT, id TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY (side, channel));
    CREATE TABLE IF NOT EXISTS cursor (side TEXT, channel TEXT, last TEXT NOT NULL, PRIMARY KEY (side, channel));
    CREATE TABLE IF NOT EXISTS msg (id INTEGER PRIMARY KEY, copy INTEGER NOT NULL, fluxer INTEGER NOT NULL, channel INTEGER NOT NULL, author INTEGER NOT NULL, reacts TEXT);
    CREATE INDEX IF NOT EXISTS msg_copy ON msg (copy);
    CREATE TABLE IF NOT EXISTS expr (id INTEGER PRIMARY KEY, fluxer INTEGER NOT NULL UNIQUE);
  `)

  // v1: replies remember what they quote, so their copies can update when it gets deleted.
  // v2: dead events get a timestamp so they can expire.
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version < 1)
    db.exec('ALTER TABLE msg ADD COLUMN reply INTEGER; CREATE INDEX msg_reply ON msg (reply) WHERE reply IS NOT NULL; PRAGMA user_version = 1')
  if (version < 2) db.exec('ALTER TABLE dead ADD COLUMN at INTEGER; UPDATE dead SET at = unixepoch() * 1000; PRAGMA user_version = 2')

  // Older mappings only serve edits, deletes, reactions and reply pings. Backfill relies on cursors, so pruning can't cause duplicates.
  const prune = () => {
    db.query('DELETE FROM msg WHERE id < ?').run(snowflake(Date.now() - retention.messages * 86_400_000))
    db.query('DELETE FROM dead WHERE at < ?').run(Date.now() - retention.dead * 86_400_000)
    db.exec('PRAGMA incremental_vacuum')
  }
  prune()
  setInterval(prune, 86_400_000)

  for (const p of pairs) bridge(sides.discord, p.discord, p.fluxer)
  kick()
}

// New bridges start relaying from now, existing ones keep their cursors.
export function bridge(s: Side, channel: string, other: string) {
  const since = snowflake()
  const add = db.query('INSERT OR IGNORE INTO link VALUES (?, ?, ?, ?, ?, ?)')
  add.run(s.name, channel, other, channel, other, since)
  add.run(s.other.name, other, channel, other, channel, since)
}

export function unbridge(s: Side, channel: string) {
  const l = link(s, channel)
  if (!l) return
  db.query('DELETE FROM link WHERE (side = ? AND root = ?) OR (side = ? AND root = ?)').run(s.name, l.root, s.other.name, l.hook)
}

// Owner, Administrator (1 << 3) or Manage Server (1 << 5).
export const admin = (s: Side, m: any) =>
  owners.get(s.name + m.guild_id) === m.author.id ||
  [m.guild_id, ...(m.member?.roles ?? [])].some(r => (perms.get(s.name + r) ?? 0n) & ((1n << 3n) | (1n << 5n)))

export function ingest(s: Side, t: string, d: any) {
  switch (t) {
    case 'READY':
      return push(s, 'BACKFILL', {})
    case 'GUILD_CREATE': {
      const guild = d.id ?? d.properties?.id
      for (const c of [...(d.channels ?? []), ...(d.threads ?? [])]) channels.set(s.name + c.id, { ...c, guild_id: guild })
      owners.set(s.name + guild, (d.properties ?? d).owner_id)
      for (const r of d.roles ?? []) {
        roles.set(s.name + r.id, r.name)
        perms.set(s.name + r.id, BigInt(r.permissions ?? 0))
      }
      if (s.name === 'discord') for (const e of [...(d.emojis ?? []), ...(d.stickers ?? [])]) expressions.set(e.id, d.id)
      if (s.name === 'discord' && guild === s.server) {
        byName(serverEmojis, d.emojis ?? [])
        byName(serverStickers, d.stickers ?? [])
      }
      return
    }
    case 'GUILD_EMOJIS_UPDATE':
    case 'GUILD_STICKERS_UPDATE':
      if (s.name === 'discord') for (const e of d.emojis ?? d.stickers) expressions.set(e.id, d.guild_id)
      if (s.name === 'discord' && d.guild_id === s.server) byName(d.emojis ? serverEmojis : serverStickers, d.emojis ?? d.stickers)
      return
    case 'CHANNEL_PINS_UPDATE':
      return push(s, 'PINS', d)
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      channels.set(s.name + d.id, d)
      return
    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE':
      roles.set(s.name + d.role.id, d.role.name)
      perms.set(s.name + d.role.id, BigInt(d.role.permissions ?? 0))
      return
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE':
      if (d.user_id !== s.self) push(s, t, d)
      return
    case 'MESSAGE_CREATE':
    case 'MESSAGE_UPDATE':
    case 'MESSAGE_DELETE':
    case 'MESSAGE_DELETE_BULK':
    case 'MESSAGE_REACTION_REMOVE_ALL':
    case 'MESSAGE_REACTION_REMOVE_EMOJI':
      push(s, t, d)
  }
}

function byName(map: Map<string, any>, list: any[]) {
  map.clear()
  for (const e of list) if (e.available !== false) map.set(e.name, e)
}

function push(s: Side, type: string, data: unknown) {
  db.query('INSERT INTO queue (side, type, data) VALUES (?, ?, ?)').run(s.name, type, JSON.stringify(data))
  kick()
}

export const transient = (e: any) =>
  e instanceof HttpError ? e.status >= 500 || e.status === 401 : typeof e?.code === 'string' || e?.name === 'TimeoutError'

// Permanent failures go to the dead table so they can be inspected and replayed. Transient ones propagate for retry.
const tolerate = (s: Side, type: string, data: unknown) => (e: unknown) => {
  if (transient(e)) throw e
  console.error(`Dropped ${type} from ${s.name}:`, e)
  db.query('INSERT INTO dead (side, type, data, error, at) VALUES (?, ?, ?, ?, ?)').run(s.name, type, JSON.stringify(data), String(e), Date.now())
}

// ponytail: one global serial worker keeps ordering trivially correct, per-bridge lanes if throughput matters.
let running = false
async function kick() {
  if (running) return
  running = true
  let delay = 1000
  for (let job; (job = db.query('SELECT * FROM queue ORDER BY id LIMIT 1').get() as Job | null); ) {
    const s = sides[job.side]
    const data = JSON.parse(job.data)
    try {
      await handle(s, job.type, data).catch(tolerate(s, job.type, data))
    } catch (e) {
      console.warn(`Retrying ${job.type} from ${s.name} in ${delay}ms:`, e)
      await sleep(delay)
      delay = Math.min(delay * 2, 60_000)
      continue
    }
    delay = 1000
    db.query('DELETE FROM queue WHERE id = ?').run(job.id)
  }
  running = false
}

async function handle(s: Side, type: string, d: any) {
  switch (type) {
    case 'BACKFILL':
      return backfill(s)
    case 'MESSAGE_CREATE':
      return COMMAND.test(d.content ?? '') ? command(s, d) : create(s, d)
    case 'MESSAGE_UPDATE':
      return update(s, d)
    case 'MESSAGE_DELETE':
      return remove(s, d.id)
    case 'MESSAGE_DELETE_BULK':
      for (const id of d.ids) await remove(s, id)
      return
    case 'PINS':
      return pins(s, d.channel_id, false)
    default:
      return react(s, d.channel_id, d.message_id)
  }
}

export const api = (s: Side, method: string, path: string, body?: unknown) => rest(s.api + path, `Bot ${s.token}`, method, body)
export const link = (s: Side, channel: string) => db.query('SELECT * FROM link WHERE side = ? AND channel = ?').get(s.name, channel) as Link | null
const advance = (s: Side, channel: string, id: string) =>
  db
    .query('INSERT INTO cursor VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET last = excluded.last WHERE CAST(excluded.last AS INTEGER) > CAST(last AS INTEGER)')
    .run(s.name, channel, id)
const last = (s: Side, channel: string) => (db.query('SELECT last FROM cursor WHERE side = ? AND channel = ?').get(s.name, channel) as { last: string } | null)?.last

function row(s: Side, id: string): Row | null {
  const flag = s.name === 'fluxer' ? 1 : 0
  const r = db
    .query(
      `SELECT CAST(id AS TEXT) id, CAST(copy AS TEXT) copy, fluxer, CAST(channel AS TEXT) channel, CAST(author AS TEXT) author, reacts
       FROM msg WHERE (id = ?1 AND fluxer = ?2) OR (copy = ?1 AND fluxer != ?2)`,
    )
    .get(id, flag) as { id: string; copy: string; fluxer: number; channel: string; author: string; reacts: string | null } | null
  if (!r) return null
  const l = link(r.fluxer ? sides.fluxer : sides.discord, r.channel)
  if (!l) return null
  return r.fluxer === flag
    ? { id, channel: r.channel, hook: l.root, other: r.copy, ours: false, author: r.author, reacts: r.reacts }
    : { id, channel: l.other, hook: l.hook, other: r.id, ours: true, author: r.author, reacts: r.reacts }
}

async function channel(s: Side, id: string) {
  let c = channels.get(s.name + id)
  if (!c) channels.set(s.name + id, (c = await api(s, 'GET', `/channels/${id}`)))
  return c
}

const lookup = (s: Side): Look => ({
  channel: id => {
    const l = link(s, id)
    return l ? `<#${l.other}>` : `#${channels.get(s.name + id)?.name ?? 'unknown-channel'}`
  },
  role: id => roles.get(s.name + id),
  emoji: id => mapped(s, id),

  // Fluxer text like :name: becomes the Discord server's emoji of that name.
  named: name => {
    const e = s.name === 'fluxer' && serverEmojis.get(name)
    return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : undefined
  },
})

// Copied expressions work both ways: Discord id to Fluxer id, and back when Fluxer members use the copies.
const mapped = (s: Side, id: string) =>
  (
    db.query(s.name === 'discord' ? 'SELECT CAST(fluxer AS TEXT) v FROM expr WHERE id = ?' : 'SELECT CAST(id AS TEXT) v FROM expr WHERE fluxer = ?').get(id) as {
      v: string
    } | null
  )?.v

// Uploads a Discord emoji or sticker to the Fluxer guild once. Failures (guild full, bad image) fall back to text for this run.
async function copy(kind: 'emojis' | 'stickers', id: string, name: string, url: string, fluxerRoot: string) {
  const saved = mapped(sides.discord, id)
  if (saved || failed.has(id)) return saved
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new HttpError(res.status, url)
    const image = `data:${res.headers.get('content-type')};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`
    const path = `/guilds/${(await channel(sides.fluxer, fluxerRoot)).guild_id}/${kind}`

    // Number duplicates like Discord does. Fluxer emoji names reject '~', so emojis use '_'.
    const taken = new Set(((await api(sides.fluxer, 'GET', path)) as any[]).map(e => e.name))
    const [sep, max] = kind === 'emojis' ? ['_', 32] : ['~', 30]
    let unique = name
    for (let n = 1; taken.has(unique); n++) unique = name.slice(0, max - `${sep}${n}`.length) + `${sep}${n}`
    const out = await api(sides.fluxer, 'POST', path, { name: unique, image })
    db.query('INSERT INTO expr VALUES (?, ?)').run(id, out.id)
    return out.id as string
  } catch (e) {
    if (transient(e)) throw e
    failed.add(id)
    console.error(`Couldn't copy ${kind} ${name} to Fluxer:`, e)
  }
}

async function emojiTo(src: Side, id: string, name: string, animated: boolean, srcGuild: string, dstRoot: string) {
  if (src.name === 'fluxer' || expressions.get(id) !== srcGuild) return mapped(src, id)
  return copy('emojis', id, name, src.emoji!(id, animated), dstRoot)
}

async function webhook(s: Side, channelId: string): Promise<{ id: string; token: string }> {
  const saved = db.query('SELECT id, token FROM hook WHERE side = ? AND channel = ?').get(s.name, channelId) as { id: string; token: string } | null
  if (saved) return saved
  const list = (await api(s, 'GET', `/channels/${channelId}/webhooks`)) as any[]
  const w = list.find(w => w.token && w.name === 'Fluxord' && w.user?.id === s.self) ?? (await api(s, 'POST', `/channels/${channelId}/webhooks`, { name: 'Fluxord' }))
  db.query('INSERT OR REPLACE INTO hook VALUES (?, ?, ?, ?)').run(s.name, channelId, w.id, w.token)
  return w
}

async function execute(dst: Side, l: Link, body: unknown, files: FileUp[], retry = true): Promise<any> {
  const h = await webhook(dst, l.hook)
  const thread = l.other === l.hook ? '' : `&thread_id=${l.other}`
  try {
    return await rest(`${dst.api}/webhooks/${h.id}/${h.token}?wait=true${thread}`, undefined, 'POST', body, files)
  } catch (e) {
    // A 404 means the webhook was deleted, unless it's about a missing reply target.
    const gone = e instanceof HttpError && e.status === 404 && ![10008, 'UNKNOWN_MESSAGE'].includes((e.body as any)?.code)
    if (!(retry && gone)) throw e

    // Webhook was deleted by someone, make a new one.
    db.query('DELETE FROM hook WHERE side = ? AND channel = ?').run(dst.name, l.hook)
    return execute(dst, l, body, files, false)
  }
}

async function hookCall(s: Side, copy: Row, method: string, body?: unknown) {
  const h = await webhook(s, copy.hook)
  const thread = copy.channel === copy.hook ? '' : `?thread_id=${copy.channel}`
  return rest(`${s.api}/webhooks/${h.id}/${h.token}/messages/${copy.id}${thread}`, undefined, method, body)
}

function pair(src: Side, a: string, b: string, p: Link) {
  const q = db.query('INSERT OR REPLACE INTO link VALUES (?, ?, ?, ?, ?, ?)')
  q.run(src.name, a, b, p.root, p.hook, p.since)
  q.run(src.other.name, b, a, p.hook, p.root, p.since)
  return link(src, a)!
}

async function mirror(src: Side, thread: any, p: Link) {
  const dst = src.other
  const starter = row(src, thread.id)
  const t = starter
    ? await api(dst, 'POST', `/channels/${p.other}/messages/${starter.other}/threads`, { name: thread.name })
    : await api(dst, 'POST', `/channels/${p.other}/threads`, { name: thread.name, type: (await channel(dst, p.other)).type === 5 ? 10 : 11 })
  return pair(src, thread.id, t.id, p)
}

const rich = (e: any) => !e.type || e.type === 'rich'
const clean = ({ title, description, url, timestamp, color, fields, footer, image, thumbnail, author }: any) => ({
  title,
  description,
  url,
  timestamp,
  color,
  fields,
  footer: footer && { text: footer.text, icon_url: footer.icon_url },
  image: image && { url: image.url },
  thumbnail: thumbnail && { url: thumbnail.url },
  author: author && { name: author.name, url: author.url, icon_url: author.icon_url },
})

async function build(src: Side, m: any, withFiles: boolean, dstRoot: string) {
  const dst = src.other
  const look = lookup(src)
  const lines: string[] = []
  const embeds: any[] = []
  const files: FileUp[] = []
  const users: string[] = []

  const guild = (await channel(src, m.channel_id)).guild_id
  let mention = ''
  let context: any
  let reference: any
  const ref = m.message_reference?.type !== 1 && m.referenced_message
  if (ref) {
    // Replying to our copy means the original author lives on the destination, so a real ping works there.
    const r = row(src, ref.id)
    const target = r && row(dst, r.other)
    const pingable = r?.ours && r.author
    if (pingable) users.push(r.author)
    const url = target ? dst.jump((await channel(dst, target.channel)).guild_id, target.channel, target.id) : undefined
    const text = convert(ref.content ?? '', ref.mentions, look) || (ref.attachments?.length ? 'attachment' : '')
    context = {
      color: src.color,
      author: { name: `↩️ ${displayName(ref.author, ref.member)}`, icon_url: src.avatar(ref.author, ref.member, guild), url },
      description: snippet(text) || undefined,
    }

    // Fluxer webhooks take real replies, which show the avatar and name natively. Discord ones can't.
    if (dst.name === 'fluxer' && target) reference = { message_id: target.id, channel_id: target.channel }
    else if (pingable) mention = `<@${r.author}>`

    // Fluxer shows a deleted reply target natively.
  } else if (dst.name === 'discord' && m.type === 19 && m.referenced_message === null) context = { color: src.color, author: { name: '↩️ Original message was deleted' } }

  for (const [, a, name, id] of (m.content ?? '').matchAll(/<(a?):([\w-]+):(\d+)>/g)) await emojiTo(src, id, name, !!a, guild, dstRoot)
  if (m.content) lines.push(convert(m.content, m.mentions, look))

  const attachments = [...(m.attachments ?? [])]
  const sourceEmbeds = [...(m.embeds ?? [])]
  const from = channels.get(src.name + m.message_reference?.channel_id)?.name
  for (const { message: f } of m.message_snapshots ?? []) {
    // Snapshots carry no author, only where they came from.
    embeds.push({
      color: src.color,
      author: { name: '↱ Forwarded' },
      description: convert(f.content ?? '', f.mentions, look) || undefined,
      footer: from && { text: `#${from}` },
      timestamp: f.timestamp,
    })
    attachments.push(...(f.attachments ?? []))
    sourceEmbeds.push(...(f.embeds ?? []))
  }

  // Files within dst.maxUpload are re-uploaded so they outlive the source CDN. The rest are linked.
  // Edits can't touch uploaded files, so they only rebuild the linked ones.
  let total = 0
  let uploaded = 0
  for (const a of attachments) {
    const spoiler = a.filename.startsWith('SPOILER_') || (a.flags & 8) !== 0
    if (a.url && uploaded < 10 && total + a.size <= dst.maxUpload) {
      total += a.size
      uploaded++
      if (!withFiles) continue
      const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) })
      if (res.ok) {
        // Discord only knows spoilers by filename, Fluxer marks them with a flag.
        files.push({ name: spoiler && !a.filename.startsWith('SPOILER_') ? `SPOILER_${a.filename}` : a.filename, data: await res.blob() })
        continue
      }
    }
    if (!a.url) {
      lines.push(`📎 ${a.filename} (expired)`)
      continue
    }

    const url = src.name === 'discord' ? permalink(a.url) : a.url
    if (!spoiler && TEXT.test(a.filename) && a.size <= 512 * 1024) {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) })
      if (res.ok) {
        const text = await res.text()
        embeds.push({
          color: src.color,
          title: a.filename,
          url,
          description: preview(text, a.filename.split('.').pop().toLowerCase()),
          footer: { text: `${a.size < 1024 ? `${a.size} B` : `${(a.size / 1024).toFixed(1)} KB`} · ${text.split('\n').length} lines` },
        })
        continue
      }
    }

    // Images go in as bare links so the destination unfurls them like any pasted image.
    const shown = a.content_type?.startsWith('image/') ? url : `📎 [${a.filename.replace(/[[\]]/g, '')}](${url})`
    lines.push(spoiler ? `||${shown}||` : shown)
  }

  embeds.push(...sourceEmbeds.filter(rich).map(clean))
  const stickers: string[] = []
  for (const s of m.sticker_items ?? m.stickers ?? []) {

    // Fluxer stickers show the Discord server's own sticker when it's a copy or shares the name.
    const copyOf = src.name === 'fluxer' && mapped(src, s.id)
    const own = src.name === 'fluxer' && ([...serverStickers.values()].find(x => x.id === copyOf) ?? serverStickers.get(s.name))
    const url = (own && dst.sticker(own)) || src.sticker(s)
    const copied = url && src.name === 'discord' && expressions.get(s.id) === guild && (await copy('stickers', s.id, s.name, url, dstRoot))
    if (copied) stickers.push(copied)
    else embeds.push(url ? { image: { url } } : { description: `Sticker: ${s.name}` })
  }

  let content = [mention, lines.join('\n')].filter(Boolean).join(' ')
  if (content.length > dst.maxContent) {
    embeds.unshift({ color: src.color, description: content.slice(0, 4096), footer: { text: `Too long for ${label(dst)}, shown in full here` } })
    content = ''
  }

  // On Discord the reply context can only sit below the text, as the first embed.
  if (context && !reference) embeds.unshift(context)
  if (!content && !embeds.length && !files.length && !stickers.length) content = '-# (unsupported message)'
  return { content, embeds: embeds.slice(0, 10), files, users, stickers, reference, context }
}

function preview(text: string, lang: string) {
  if (text.length > 1000) text = text.slice(0, text.lastIndexOf('\n', 1000) + 1 || 1000) + '…'
  return '```' + lang + '\n' + text.replaceAll('```', '`\u200b``') + '\n```'
}

const label = (s: Side) => (s.name === 'fluxer' ? 'Fluxer' : 'Discord')

// The platform tag stops people passing as someone on the other side.
function username(dst: Side, m: any) {
  const tag = ` (${label(dst.other)})`
  const name = displayName(m.author, m.member).slice(0, 80 - tag.length)

  // Discord rejects webhook names containing these words.
  return (dst.name === 'discord' ? name.replace(/discord|clyde/gi, w => w[0] + '\u200b' + w.slice(1)) : name) + tag
}

const ours = (s: Side, m: any) =>
  m.author?.id === s.self || (m.webhook_id && db.query('SELECT 1 FROM hook WHERE side = ? AND id = ?').get(s.name, m.webhook_id))

async function create(src: Side, m: any) {
  if (row(src, m.id) || ours(src, m) || !RELAYED.has(m.type) || COMMAND.test(m.content ?? '')) return
  const dst = src.other
  const c = await channel(src, m.channel_id)
  let l = link(src, m.channel_id)
  let p: Link | null = null
  let threadName: string | undefined
  if (!l) {
    // Threads under a bridged channel get mirrored on first message. Private threads stay private.
    if (!THREADS.has(c.type) || c.type === 12) return
    p = link(src, c.parent_id)
    if (!p || p.channel !== p.root) return
    if (FORUMS.has((await channel(dst, p.other)).type)) {
      l = { ...p, channel: c.id }
      threadName = c.name
    } else l = await mirror(src, c, p)
  }

  const { content, embeds, files, users, stickers, reference, context } = await build(src, m, true, l.hook)
  const body = {
    content,
    embeds,
    username: username(dst, m),
    avatar_url: src.avatar(m.author, m.member, c.guild_id),
    allowed_mentions: { parse: [], users, replied_user: users.length > 0 },
    thread_name: threadName,
    sticker_ids: stickers.length ? stickers : undefined,
    message_reference: reference,
  }

  // A reply target that vanished since we looked it up would fail the whole message, so retry with the embed.
  const to = l
  const out = await execute(dst, to, body, files).catch(e => {
    if (!reference || !(e instanceof HttpError) || e.status >= 500) throw e
    return execute(dst, to, { ...body, message_reference: undefined, embeds: [context, ...embeds].slice(0, 10) }, files)
  })
  if (threadName) l = pair(src, c.id, out.channel_id, p!)

  const reply = m.message_reference?.type !== 1 ? (m.message_reference?.message_id ?? null) : null
  db.transaction(() => {
    db.query('INSERT OR REPLACE INTO msg (id, copy, fluxer, channel, author, reply) VALUES (?, ?, ?, ?, ?, ?)').run(
      m.id,
      out.id,
      src.name === 'fluxer' ? 1 : 0,
      m.channel_id,
      m.author.id,
      reply,
    )
    advance(src, m.channel_id, m.id)
  })()
}

async function update(src: Side, m: any, force = false) {
  const r = row(src, m.id)
  if (!r || r.ours) return
  const dst = src.other
  const copy = row(dst, r.other)!
  if (m.flags & 1 && (await channel(dst, copy.channel)).type === 5)
    await api(dst, 'POST', `/channels/${copy.channel}/messages/${copy.id}/crosspost`).catch(() => {})
  if (!copy.ours || (!force && (!m.edited_timestamp || m.content === undefined))) return
  const { content, embeds } = await build(src, m, false, copy.hook)
  await hookCall(dst, copy, 'PATCH', { content: join(content, copy.reacts ?? ''), embeds, allowed_mentions: { parse: [] } })
}

async function remove(src: Side, id: string) {
  const replies = db
    .query('SELECT CAST(id AS TEXT) id, CAST(channel AS TEXT) channel FROM msg WHERE reply = ? AND fluxer = ?')
    .all(id, src.name === 'fluxer' ? 1 : 0) as { id: string; channel: string }[]
  for (const reply of replies) {
    const m = await api(src, 'GET', `/channels/${reply.channel}/messages/${reply.id}`).catch(e => {
      if (e instanceof HttpError && e.status === 404) return null
      throw e
    })
    if (m) await update(src, m, true)
  }

  const r = row(src, id)
  if (!r || r.ours) return
  const copy = row(src.other, r.other)
  if (copy?.ours) await hookCall(src.other, copy, 'DELETE')
}

// Rebuilds reaction state from the source message, so replays and missed events self-heal.
async function react(src: Side, channelId: string, messageId: string) {
  const r = row(src, messageId)
  if (!r) return
  const dst = src.other
  const copy = row(dst, r.other)!
  const [m, target] = await Promise.all([
    api(src, 'GET', `/channels/${channelId}/messages/${messageId}`),
    api(dst, 'GET', `/channels/${copy.channel}/messages/${copy.id}`),
  ])

  // Our own reactions mirror the other side, so leave them out of the count.
  const want: any[] = (m.reactions ?? []).map((x: any) => ({ ...x.emoji, count: x.count - (x.me ? 1 : 0) })).filter((x: any) => x.count > 0)
  const key = (e: any) => (e.id ? `${e.name}:${e.id}` : e.name)
  const mine: string[] = (target.reactions ?? []).filter((x: any) => x.me).map((x: any) => key(x.emoji))
  const path = (k: string) => `/channels/${copy.channel}/messages/${copy.id}/reactions/${encodeURIComponent(k)}/@me`

  // Custom emoji react only when copied across. The rest, and unicode the destination rejects, get appended as text.
  const guild = (await channel(src, channelId)).guild_id
  const keys = new Map<string, any>()
  const appended: any[] = []
  for (const e of want) {
    const to = e.id ? await emojiTo(src, e.id, e.name, !!e.animated, guild, copy.hook) : e.name
    if (to) keys.set(e.id ? `${e.name}:${to}` : to, e)
    else appended.push(e)
  }
  for (const [k, e] of keys) {
    if (mine.includes(k)) continue
    await api(dst, 'PUT', path(k)).catch(err => {
      if (!(err instanceof HttpError) || err.status >= 500) throw err
      appended.push(e)
    })
  }
  for (const k of mine) if (!keys.has(k)) await api(dst, 'DELETE', path(k))

  if (!copy.ours) return
  const line = reactsLine(appended)
  const old = copy.reacts ?? ''
  if (line === old) return
  const body = old && target.content.endsWith(old) ? target.content.slice(0, -old.length).replace(/\n$/, '') : target.content
  await hookCall(dst, copy, 'PATCH', { content: join(body, line), allowed_mentions: { parse: [] } })
  db.query('UPDATE msg SET reacts = ? WHERE id = ?').run(line || null, copy.other)
}

// Brings an existing channel's context across when it gets mirrored: topic, pins, and threads with their first post.
export async function adopt(s: Side, channelId: string) {
  const l = link(s, channelId)!
  const dst = s.other
  advance(s, channelId, l.since)
  const c = await channel(s, channelId)
  const theirs = await channel(dst, l.other)
  if (c.topic && !theirs.topic) await api(dst, 'PATCH', `/channels/${l.other}`, { topic: c.topic })
  const pinned = FORUMS.has(c.type) ? 0 : await pins(s, channelId, true)

  const active = await api(s, 'GET', `/guilds/${c.guild_id}/threads/active`)
  const archived = await api(s, 'GET', `/channels/${channelId}/threads/archived/public?limit=100`)
  const threads = [...(active.threads ?? active), ...(archived.threads ?? archived)]
    .filter(t => t.parent_id === channelId && t.type !== 12)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  let adopted = 0
  for (const t of threads) if (await adoptThread(s, t).catch(tolerate(s, 'ADOPT', t))) adopted++
  return { threads: adopted, pins: pinned }
}

async function adoptThread(s: Side, t: any) {
  if (link(s, t.id)) return false
  channels.set(s.name + t.id, t)

  // Only the first post comes across for context, the rest of the history stays behind.
  advance(s, t.id, snowflake())
  const [first] = (await api(s, 'GET', `/channels/${t.id}/messages?limit=1&after=${BigInt(t.id) - 1n}`)) as any[]
  const starter = first?.type === 21 ? first.referenced_message : first
  if (starter && !row(s, starter.id)) await create(s, { ...starter, channel_id: t.id, type: 0 })
  if (!link(s, t.id)) await mirror(s, t, link(s, t.parent_id)!)
  return true
}

// Mirrors pin state onto the other side. Cloning old pinned messages only happens when a channel gets mirrored.
async function pins(src: Side, channelId: string, clone: boolean) {
  const l = link(src, channelId)
  if (!l) return 0
  const dst = src.other
  const list = async (s: Side, id: string) => ((await api(s, 'GET', `/channels/${id}/messages/pins?limit=50`)).items as any[]).map(i => i.message)
  const [mine, theirs] = await Promise.all([list(src, channelId), list(dst, l.other)])
  let pinned = 0
  for (const m of mine.reverse()) {
    if (clone && !row(src, m.id)) await create(src, m)
    const r = row(src, m.id)
    if (r && !theirs.some(x => x.id === r.other)) {
      await api(dst, 'PUT', `/channels/${l.other}/pins/${r.other}`)
      pinned++
    }
  }
  for (const x of theirs) {
    const r = row(dst, x.id)
    if (r?.ours && !mine.some(m => m.id === r.other)) await api(dst, 'DELETE', `/channels/${l.other}/pins/${x.id}`)
  }
  return pinned
}

// Runs on every fresh gateway session. Relays anything sent while we were away, oldest first.
async function backfill(s: Side) {
  const roots = db.query('SELECT * FROM link WHERE side = ? AND channel = root').all(s.name) as Link[]
  const guilds = new Set<string>()
  for (const l of roots) {
    await (async () => {
      const c = await channel(s, l.channel)
      guilds.add(c.guild_id)
      if (!FORUMS.has(c.type)) await history(s, l.channel, last(s, l.channel) ?? l.since)
    })().catch(tolerate(s, 'BACKFILL', l))
  }

  for (const g of guilds) {
    const res = await api(s, 'GET', `/guilds/${g}/threads/active`)
    for (const t of res.threads ?? res) {
      const p = roots.find(l => l.channel === t.parent_id)
      if (!p || t.type === 12) continue
      channels.set(s.name + t.id, t)

      // A thread's messages are never older than the thread itself.
      const from = BigInt(t.id) - 1n > BigInt(p.since) ? (BigInt(t.id) - 1n).toString() : p.since
      await history(s, t.id, last(s, t.id) ?? from).catch(tolerate(s, 'BACKFILL', t))
    }
  }
}

async function history(s: Side, channelId: string, after: string) {
  for (;;) {
    const batch = (await api(s, 'GET', `/channels/${channelId}/messages?limit=100&after=${after}`)) as any[]
    batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    for (const m of batch) await create(s, m).catch(tolerate(s, 'MESSAGE_CREATE', m))
    if (batch.length < 100) return
    after = batch.at(-1).id
  }
}
