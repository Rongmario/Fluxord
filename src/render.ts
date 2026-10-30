export type Look = { channel(id: string): string; role(id: string): string | undefined; emoji(id: string, name: string): string | undefined; named(name: string): string | undefined }

export const displayName = (user: any, member?: any): string => member?.nick || user?.global_name || user?.username || 'Unknown'

// Platform-specific tokens don't resolve on the other side, so turn them into plain text unless the emoji was copied across.
export function convert(content: string, mentions: any[] = [], look: Look): string {
  return content
    .replace(/<(a?):([\w-]+):(\d+)>/g, (_, a, name, id) => {
      const to = look.emoji(id, name)
      return to ? `<${a}:${name}:${to}>` : `:${name}:`
    })
    .replace(/<@!?(\d+)>/g, (_, id) => {
      const u = mentions.find(u => u.id === id)
      return `**@${u ? displayName(u, u.member) : 'unknown-user'}**`
    })
    .replace(/<@&(\d+)>/g, (_, id) => `**@${look.role(id) ?? 'unknown-role'}**`)
    .replace(/<#(\d+)>/g, (_, id) => look.channel(id))
    .replace(/(?<![<\w]):(\w{2,32}):(?!\d)/g, (raw, name) => look.named(name) ?? raw)
}

export function snippet(text: string) {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > 100 ? s.slice(0, 99) + '…' : s
}

export const reactsLine = (emojis: { name: string; id?: string; count: number }[]) =>
  emojis.length ? '-# ' + emojis.map(e => `${e.id ? `:${e.name}:` : e.name} ${e.count}`).join(' · ') : ''

export const join = (...parts: string[]) => parts.filter(Boolean).join('\n')
