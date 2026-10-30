import { serveAttachments } from './attachments'
import { ingest, start, type Side } from './bridge'
import { Gateway, rest } from './net'

const cfg = await Bun.file(process.env.FLUXORD_CONFIG ?? 'config.json').json()
const { endpoints: fx } = await rest(new URL('/.well-known/fluxer', cfg.fluxer.instance).href, undefined, 'GET')
if (!cfg.servers) throw new Error('config.json needs "servers": { "discord": "<server id>", "fluxer": "<community id>" }')
const cdn = 'https://cdn.discordapp.com'

const discord: Side = {
  name: 'discord',
  api: 'https://discord.com/api/v10',
  token: process.env.DISCORD_TOKEN ?? cfg.discord.token,
  maxContent: 2000,
  maxUpload: 10 * 1024 * 1024,
  self: '',
  server: cfg.servers.discord,
  color: cfg.colors?.discord ?? 0x5865f2,
  other: null!,
  avatar: (u, m, g) =>
    m?.avatar
      ? `${cdn}/guilds/${g}/users/${u.id}/avatars/${m.avatar}.png`
      : u.avatar
        ? `${cdn}/avatars/${u.id}/${u.avatar}.png`
        : `${cdn}/embed/avatars/${(BigInt(u.id) >> 22n) % 6n}.png`,
  emoji: (id, animated) => `${cdn}/emojis/${id}.${animated ? 'gif' : 'png'}`,
  sticker: s => (s.format_type === 3 ? undefined : `https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? 'gif' : 'png'}`),
  jump: (g, c, m) => `https://discord.com/channels/${g}/${c}/${m}`,
}

const fluxer: Side = {
  name: 'fluxer',
  api: `${fx.api_public}/v1`,
  token: process.env.FLUXER_TOKEN ?? cfg.fluxer.token,
  maxContent: 4000,

  // Nothing gets uploaded to the Fluxer instance. Discord files arrive as links and image embeds.
  maxUpload: 0,
  self: '',
  server: cfg.servers.fluxer,
  color: cfg.colors?.fluxer ?? 0x1d9e75,
  other: discord,
  avatar: (u, m, g) =>
    m?.avatar ? `${fx.media}/guilds/${g}/users/${u.id}/avatars/${m.avatar}.png` : u.avatar ? `${fx.media}/avatars/${u.id}/${u.avatar}.png` : undefined,
  emoji: (id, animated) => `${fx.media}/emojis/${id}.${animated ? 'gif' : 'webp'}`,
  sticker: s => `${fx.media}/stickers/${s.id}.${s.animated ? 'gif' : 'webp'}`,
  jump: (g, c, m) => `${fx.webapp}/channels/${g}/${c}/${m}`,
}
discord.other = fluxer

for (const s of [discord, fluxer]) s.self = (await rest(`${s.api}/users/@me`, `Bot ${s.token}`, 'GET')).id
const days = cfg.retentionDays ?? 7
start(cfg.db ?? 'fluxord.sqlite', cfg.bridges ?? [], [discord, fluxer], {
  messages: cfg.retentionDaysForMessages ?? days,
  dead: cfg.retentionDaysForDeadEvents ?? days,
})

if (cfg.attachments) serveAttachments(discord, cfg.attachments.port, cfg.attachments.publicUrl)

// GUILDS | GUILD_EXPRESSIONS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS | MESSAGE_CONTENT. Fluxer has no intents.
new Gateway('wss://gateway.discord.gg', '?v=10&encoding=json', discord.token, { intents: 1 | (1 << 3) | (1 << 9) | (1 << 10) | (1 << 15) }, (t, d) =>
  ingest(discord, t, d),
).connect()
new Gateway(fx.gateway, '?v=1&encoding=json', fluxer.token, {}, (t, d) => ingest(fluxer, t, d)).connect()
