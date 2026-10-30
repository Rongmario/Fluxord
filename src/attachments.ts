import { api, link, type Side } from './bridge'

let discord: Side | undefined
let base = ''
const fresh = new Map<string, { url: string; until: number }>()

// Discord attachment links expire after about a day. Fluxer gets a stable link to this server instead,
// which asks Discord for a fresh one and redirects there.
export function serveAttachments(side: Side, port: number, publicUrl: string) {
  discord = side
  base = publicUrl.replace(/\/$/, '')
  Bun.serve({
    port,
    async fetch(req) {
      const m = new URL(req.url).pathname.match(/^\/a\/(\d+)\/(\d+)\/([^/]+)$/)

      // Only attachments from bridged channels, so the bot can't be used to refresh arbitrary Discord links.
      if (!m || !link(side, m[1])) return new Response('Not found', { status: 404 })
      const key = `${m[1]}/${m[2]}/${m[3]}`
      let hit = fresh.get(key)
      if (!hit || hit.until < Date.now()) {
        const res = await api(side, 'POST', '/attachments/refresh-urls', { attachment_urls: [`https://cdn.discordapp.com/attachments/${key}`] }).catch(
          () => null,
        )
        const url = res?.refreshed_urls?.[0]?.refreshed
        if (!url) return new Response('Not found', { status: 404 })

        // ponytail: unbounded until it hits 10k entries, then starts over. An LRU if that ever matters.
        if (fresh.size > 10_000) fresh.clear()
        fresh.set(key, (hit = { url, until: Date.now() + 12 * 3_600_000 }))
      }
      return Response.redirect(hit.url, 302)
    },
  })
}

export function permalink(url: string) {
  const m = discord && url.match(/^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/attachments\/(\d+)\/(\d+)\/([^?/]+)/)
  return m && link(discord!, m[1]) ? `${base}/a/${m[1]}/${m[2]}/${m[3]}` : url
}
