export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status} ${JSON.stringify(body)}`)
  }
}

export type FileUp = { name: string; data: Blob }

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function rest(url: string, auth: string | undefined, method: string, body?: unknown, files: FileUp[] = []): Promise<any> {
  const headers: Record<string, string> = { 'User-Agent': 'DiscordBot (https://github.com/Rongmario/Fluxord, 1.0)' }
  if (auth) headers.Authorization = auth
  let payload: FormData | string | undefined
  if (files.length) {
    const form = (payload = new FormData())
    form.append('payload_json', JSON.stringify(body ?? {}))
    files.forEach((f, i) => form.append(`files[${i}]`, f.data, f.name))
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  for (;;) {
    const res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) })
    const text = await res.text()
    let data: any = text
    try {
      data = text && JSON.parse(text)
    } catch {}
    if (res.status === 429) {
      // Cloudflare-level 429s come back as HTML, so fall back to the header.
      await sleep((data?.retry_after ?? Number(res.headers.get('retry-after') ?? 1)) * 1000)
      continue
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') await sleep(Number(res.headers.get('x-ratelimit-reset-after')) * 1000)
    if (!res.ok) throw new HttpError(res.status, data)
    return data || null
  }
}

const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014])

// Shared by Discord (v10) and Fluxer (v1), whose gateways use the same opcodes.
export class Gateway {
  private seq: number | null = null
  private session?: string
  private resumeUrl?: string

  constructor(
    private url: string,
    private query: string,
    private token: string,
    private extra: object,
    private dispatch: (t: string, d: any) => void,
  ) {}

  connect() {
    const ws = new WebSocket(((this.session && this.resumeUrl) || this.url) + this.query)
    const send = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }))
    let beat: ReturnType<typeof setInterval> | undefined
    let acked = true

    ws.onmessage = e => {
      const p = JSON.parse(e.data as string)
      switch (p.op) {
        case 0:
          if (p.t === 'READY') {
            this.session = p.d.session_id
            this.resumeUrl = p.d.resume_gateway_url
          }

          // Advance seq only after the event is persisted, so heartbeats never ack a lost event.
          this.dispatch(p.t, p.d)
          this.seq = p.s
          break
        case 1:
          send(1, this.seq)
          break
        case 7:
          ws.close(4000)
          break
        case 9:
          if (!p.d) {
            this.session = undefined
            this.seq = null
          }
          setTimeout(() => ws.close(4000), 1000 + Math.random() * 4000)
          break
        case 10:
          beat = setInterval(() => {
            if (!acked) return ws.close(4000)
            acked = false
            send(1, this.seq)
          }, p.d.heartbeat_interval)
          if (this.session && this.seq !== null) send(6, { token: this.token, session_id: this.session, seq: this.seq })
          else send(2, { token: this.token, properties: { os: process.platform, browser: 'fluxord', device: 'fluxord' }, ...this.extra })
          break
        case 11:
          acked = true
      }
    }

    ws.onclose = e => {
      clearInterval(beat)
      if (FATAL.has(e.code)) {
        console.error(`Gateway ${this.url} closed with fatal code ${e.code}: ${e.reason}`)
        process.exit(1)
      }
      console.warn(`Gateway ${this.url} closed (${e.code}), reconnecting`)
      setTimeout(() => this.connect(), 2000)
    }
  }
}
