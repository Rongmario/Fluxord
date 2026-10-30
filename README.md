# Fluxord

Bridges channels between a Fluxer instance and Discord.

## Setup

1. Create a Discord bot and enable the **Message Content** intent. Invite it with `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=310043077712`.
2. Create a Fluxer bot and invite it with `API_PUBLIC/v1/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=9106136099920` (`api_public` comes from `https://your-instance/.well-known/fluxer`).
3. `cp config.example.json config.json` and fill in tokens, the Fluxer instance URL and the two server ids. `DISCORD_TOKEN` and `FLUXER_TOKEN` env vars override the file.
4. `bun start`, then pick channels with the commands below. To run it as a service, see [fluxord.service](fluxord.service).

Permissions: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions, Manage Messages, Manage Webhooks, Manage Channels, Manage Roles, Create Public Threads, Send Messages in Threads, plus Create Expressions on Fluxer.

## Commands

Work in either server, for members with Manage Server.

- `!fluxord channels` lists every text, announcement and forum channel with a number and its mirror status
- `!fluxord mirror 1 3 5-8` mirrors those channels. `all` mirrors everything except 🔒 private channels
- `!fluxord unmirror 3` stops mirroring. Both channels are kept
- `!fluxord help`

Mirroring reuses a channel with the same name, category and privacy on the other side, otherwise it creates one (and its category). It also copies the topic, the pinned messages, and every active or recently archived public thread with its first post. Older thread history stays behind. Private channels are created private, visible only to the bot until you grant roles. Announcement and forum channels fall back to text channels if the other server can't have them.

Bridges live in the database. `bridges` in `config.json` is optional and only adds pairs, so remove them with `unmirror`.

## Embed colors

Embeds take the color of the platform the content came from. Override them in `config.json`:

```json
"colors": { "discord": 5793266, "fluxer": 1940085 }
```

## Discord attachment links

Discord attachment links expire after about a day, so images bridged to Fluxer would go blank. To keep them alive, let the bridge serve stable links that fetch a fresh Discord link on each visit:

```json
"attachments": { "port": 8787, "publicUrl": "https://fluxord.example.com" }
```

`publicUrl` must reach `port` from the internet (Fluxer's media proxy refuses private addresses), usually through a reverse proxy with HTTPS. Only attachments from bridged channels are served. Without this block, raw Discord links are used.

## Lifting Fluxer rate limits for the bot

On your own instance you can let the bot skip Fluxer's rate limits. A bot's user id is its application id.

1. Signed in as an instance admin, create an Admin API key with the ACLs `admin:authenticate` and `user:update:flags` (`POST /v1/admin/api-keys`). The key is shown once.
2. Give the bot the `RATE_LIMIT_BYPASS` flag (`1 << 47`):

   ```bash
   curl -X PATCH "API_PUBLIC/v1/admin/users/BOT_APP_ID/flags" -H "Authorization: Admin ADMIN_KEY" -H "Content-Type: application/json" -d '{"add_flags":["140737488355328"]}'
   ```

   For a softer option, `HIGH_GLOBAL_RATE_LIMIT` (`8589934592`) raises the global limit from 50 to 1,200 requests per second but keeps route limits. Undo either with `"remove_flags"`.

Webhook posts aren't covered, since they carry no bot token. Each bridged channel's webhook stays limited to 60 messages per minute, and anything over that waits in the queue.

## Other webhooks (GitHub etc.)

Messages from other webhooks and bots are bridged like anyone else's, with their name, avatar and embeds. Point an integration at one side only, or each notification shows up twice on both sides.

## Delivery

- Every gateway event is written to SQLite before it is acknowledged. A single worker relays them in order and retries transient failures forever.
- On every fresh gateway session the bridge fetches channel history after the last relayed message, so downtime doesn't lose messages.
- Permanent failures (bad request, missing permission) go to the `dead` table instead of blocking the queue.

## Storage

- `retentionDays` (default 7) sets how long data is kept. `retentionDaysForMessages` and `retentionDaysForDeadEvents` override it for each kind.
- One row per relayed message (a few integers, no text), pruned after `retentionDaysForMessages`. Pruned messages still exist on both sides, but later edits, deletes and reactions on them stop syncing and replies to them lose the ping and jump link.
- Permanently failed events (full payload, including text) sit in the `dead` table for `retentionDaysForDeadEvents`.
- No attachments are uploaded to the Fluxer instance. Discord images arrive as links Fluxer unfurls, other files as `📎` links, text files with a code preview, spoilers hidden.
- Custom emojis and stickers that belong to the bridged Discord server are copied into the Fluxer guild once, the first time they're used. Emojis and stickers from other Discord servers (Nitro) are never copied. Name clashes are numbered: `wave~1` for stickers, `blob_1` for emojis (Fluxer emoji names can't contain `~`).

## What syncs

Both ways:

- [ ] Text messages, posted by webhook with the author's name (tagged `(Discord)` or `(Fluxer)`) and avatar
- [ ] Mentions turn into plain `**@name**`. Mentions of bridged channels become native channel mentions
- [ ] Copied emojis show as real emojis on both sides. Other custom emojis turn into `:name:`
- [ ] Pins, including unpinning bridged copies
- [ ] Replies: real replies on Fluxer. On Discord, an embed under the message shows `↩️` with the replied person's avatar, name, a snippet and a jump link. Replying to a bridged copy pings the original author natively
- [ ] Edits and deletes of the original update the copy
- [ ] Reactions on an original: unicode and copied emojis as a bot reaction on the copy, other custom emojis appended as `-# :name: 2`
- [ ] Reactions on a copy: unicode and copied emojis as a bot reaction on the original
- [ ] Public threads, announcement threads and forum posts under a bridged channel, mirrored on their first message
- [ ] Publishing an announcement
- [ ] Rich embeds (from bots), forwarded messages
- [ ] Messages sent while the bridge was offline

One way only:

- [ ] Fluxer to Discord: attachments up to 10 MiB in total are re-uploaded to Discord. Anything over that is linked and dies within 24h, when Fluxer's signed links expire
- [ ] Discord to Fluxer: attachments are only linked. Discord CDN links expire after about 24h, so old images may stop loading on Fluxer
- [ ] Fluxer to Discord: Fluxer messages over 2000 characters go into an embed on Discord
- [ ] Discord to Fluxer: stickers from the bridged server are sent as real Fluxer stickers. Others show as image embeds, and Discord's built-in animated stickers (Lottie format) show as text
- [ ] Fluxer to Discord: stickers show as image embeds, since Discord webhooks can't send stickers. Copies of Discord stickers, or ones sharing a Discord sticker's name, use Discord's own image
- [ ] Discord to Fluxer: new emojis and stickers get copied. Fluxer-only emojis never get copied to Discord
- [ ] Fluxer to Discord: `:name:` (typed or a Fluxer emoji) becomes the Discord server's emoji with that name

Not synced either way:

- Reactions on a copy with an emoji that wasn't copied (the bot can't edit someone else's original message)
- Edits, deletes, reactions and pins made while the bridge was offline
- Deleting or editing a copy (the original stays)
- Private threads, voice, polls (show as "unsupported message"), pins, system messages (joins, boosts, pin notices)
- Thread renames, archiving, locking, channel and role changes
