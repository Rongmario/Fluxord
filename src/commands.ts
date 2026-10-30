import { adopt, admin, api, bridge, channels, link, transient, unbridge, type Side } from './bridge'
import { HttpError } from './net'
import { join } from './render'

export const COMMAND = /^!fluxord\s+(help|channels|mirror|unmirror)\b/i

const MIRRORABLE = new Set([0, 5, 15, 16])
const VIEW = 1n << 10n

// VIEW_CHANNEL, SEND_MESSAGES, ADD_REACTIONS, READ_MESSAGE_HISTORY, MANAGE_WEBHOOKS, so the bot keeps access to private channels it creates.
const BOT_ALLOW = VIEW | (1n << 11n) | (1n << 6n) | (1n << 16n) | (1n << 29n)

const HELP = [
  "`!fluxord channels` lists this server's channels with numbers",
  '`!fluxord mirror 1 3 5-8` mirrors those channels to the other side. `all` mirrors every channel except 🔒 private ones',
  '`!fluxord unmirror 3` stops mirroring. Both channels are kept',
]

const norm = (name: string) => name.toLowerCase().replace(/\s+/g, '-')
const hidden = (c: any, guild: string) => !!c.permission_overwrites?.some((o: any) => o.id === guild && BigInt(o.deny ?? 0) & VIEW)

export async function command(s: Side, m: any) {
  if (m.guild_id !== s.server || m.author?.bot) return
  const say = (title: string, lines: string[], footer?: string) => reply(s, m.channel_id, title, lines, footer)
  if (!admin(s, m)) return say('Not allowed', ['Only members with Manage Server can use Fluxord commands.'])

  const [, sub, ...args] = m.content.trim().toLowerCase().split(/\s+/)
  if (sub === 'help') return say('Fluxord', HELP, 'Needs Manage Server')
  const { list, cats } = await scrape(s)
  if (sub === 'channels') return say('Channels', list.length ? overview(s, list, cats) : ['No channels found.'], 'Mirror with !fluxord mirror <numbers>')

  const all = args[0] === 'all'
  const picks = all ? list.filter(c => (sub === 'mirror' ? !hidden(c, s.server) : link(s, c.id))) : select(args, list)
  if (!picks.length) return say('Nothing selected', HELP)
  if (sub === 'mirror') return say('Mirrored', await mirror(s, picks, cats))
  for (const c of picks) unbridge(s, c.id)
  return say('Stopped mirroring', picks.map(c => `<#${c.id}>`), 'Both channels are kept')
}

// Sidebar order, so numbers stay the same between listing and mirroring.
async function scrape(s: Side) {
  const all = (await api(s, 'GET', `/guilds/${s.server}/channels`)) as any[]
  for (const c of all) channels.set(s.name + c.id, { ...c, guild_id: s.server })
  const cats = new Map<string, any>(all.filter(c => c.type === 4).map(c => [c.id, c]))
  const catPos = (c: any) => cats.get(c.parent_id)?.position ?? -1
  const list = all
    .filter(c => MIRRORABLE.has(c.type))
    .sort(
      (a, b) =>
        catPos(a) - catPos(b) ||
        (a.parent_id ?? '').localeCompare(b.parent_id ?? '') ||
        (a.position ?? 0) - (b.position ?? 0) ||
        (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
    )
  return { list, cats }
}

function overview(s: Side, list: any[], cats: Map<string, any>) {
  const lines: string[] = []
  let cat: string | null | undefined
  list.forEach((c, i) => {
    const parent = c.parent_id ?? null
    if (parent !== cat) {
      cat = parent
      if (parent) lines.push(`**${cats.get(parent)?.name}**`)
    }
    const l = link(s, c.id)
    const other = l && `#${channels.get(s.other.name + l.other)?.name ?? l.other}`
    lines.push(`\`${i + 1}\` ${hidden(c, s.server) ? '🔒 ' : ''}<#${c.id}>${other ? ` ⇄ ${other}` : ''}`)
  })
  return lines
}

function select(args: string[], list: any[]) {
  const picked = new Set<any>()
  for (const a of args) {
    const [from, to = from] = a.split('-').map(Number)
    for (let i = from; i <= Math.min(to, list.length); i++) if (list[i - 1]) picked.add(list[i - 1])
  }
  return [...picked]
}

// Reuses a same-named channel in the same-named category when one exists, otherwise creates it. Privacy carries over.
async function mirror(s: Side, picks: any[], cats: Map<string, any>) {
  const dst = s.other
  const theirs = (await api(dst, 'GET', `/guilds/${dst.server}/channels`)) as any[]
  const out: string[] = []
  for (const c of picks) {
    if (link(s, c.id)) {
      out.push(`<#${c.id}> is already mirrored`)
      continue
    }
    try {
      const priv = hidden(c, s.server)
      const catName = cats.get(c.parent_id)?.name
      let parent = catName && theirs.find(x => x.type === 4 && norm(x.name) === norm(catName))
      if (catName && !parent) theirs.push((parent = await api(dst, 'POST', `/guilds/${dst.server}/channels`, { name: catName, type: 4 })))

      let t = theirs.find(
        x =>
          MIRRORABLE.has(x.type) &&
          norm(x.name) === norm(c.name) &&
          (x.parent_id ?? null) === (parent?.id ?? null) &&
          hidden(x, dst.server) === priv &&
          !link(dst, x.id),
      )
      const reused = !!t
      if (!t) theirs.push((t = await create(dst, c, parent?.id, priv)))
      channels.set(dst.name + t.id, { ...t, guild_id: dst.server })
      bridge(s, c.id, t.id)
      const got = await adopt(s, c.id)
      out.push(`<#${c.id}> ⇄ #${t.name} (${reused ? 'existing channel' : 'created'}, ${got.threads} threads, ${got.pins} pins)`)
    } catch (e) {
      if (transient(e)) throw e
      out.push(`<#${c.id}> failed: ${e instanceof HttpError ? JSON.stringify(e.body) : e}`)
    }
  }
  return out
}

function create(dst: Side, c: any, parent: string | undefined, priv: boolean) {
  const body = {
    name: c.name,
    type: c.type,
    topic: c.topic || undefined,
    nsfw: c.nsfw,
    parent_id: parent,
    permission_overwrites: priv
      ? [
          { id: dst.server, type: 0, deny: String(VIEW) },
          { id: dst.self, type: 1, allow: String(BOT_ALLOW) },
        ]
      : undefined,
  }

  // Announcement and forum channels need community features on Discord, so fall back to a text channel.
  return api(dst, 'POST', `/guilds/${dst.server}/channels`, body).catch(e => {
    if (c.type === 0 || !(e instanceof HttpError) || e.status >= 500) throw e
    return api(dst, 'POST', `/guilds/${dst.server}/channels`, { ...body, type: 0 })
  })
}

// One embed per message, since Discord caps a message's embeds at 6000 characters in total.
async function reply(s: Side, channel: string, title: string, lines: string[], footer?: string) {
  const parts = ['']
  for (const line of lines) {
    if (parts.at(-1)!.length + line.length + 1 > 4000) parts.push('')
    parts[parts.length - 1] = join(parts.at(-1)!, line)
  }
  for (const [i, description] of parts.entries()) {
    const embed = {
      color: s.color,
      title: i ? undefined : title,
      description,
      footer: footer && i === parts.length - 1 ? { text: footer } : undefined,
    }
    await api(s, 'POST', `/channels/${channel}/messages`, { embeds: [embed], allowed_mentions: { parse: [] } })
  }
}
