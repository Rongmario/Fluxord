import { expect, test } from 'bun:test'
import { convert, join, reactsLine, snippet } from './render'

const look = { channel: (id: string) => (id === '7' ? '<#70>' : '#general'), role: (id: string) => (id === '5' ? 'Mods' : undefined), emoji: (id: string) => (id === '9' ? '99' : undefined), named: (name: string) => (name === 'wave' ? '<:wave:5>' : undefined) }

test('convert strips platform tokens', () => {
  const mentions = [{ id: '1', username: 'bob', global_name: 'Bob', member: { nick: 'Bobby' } }]
  expect(convert('hi <@1> <@!2> <@&5> <@&6> <#7> <#8> <:blob:123> <a:party-cat:9>', mentions, look)).toBe(
    'hi **@Bobby** **@unknown-user** **@Mods** **@unknown-role** <#70> #general :blob: <a:party-cat:99>',
  )
})

test('convert maps raw and unmapped :name: to server emoji', () => {
  expect(convert(':wave: :nope: <:wave:1> <a:wave:2> 12:30:45', [], look)).toBe('<:wave:5> :nope: <:wave:5> <:wave:5> 12:30:45')
})

test('convert pings mapped roles only', () => {
  const pinging = { ...look, ping: (id: string) => (id === '5' ? '50' : undefined) }
  expect(convert('<@&5> <@&6>', [], pinging)).toBe('<@&50> **@unknown-role**')
})

test('snippet collapses and truncates', () => {
  expect(snippet('line one\n\n  two')).toBe('line one two')
  expect(snippet('a'.repeat(150)).length).toBe(100)
})

test('reactsLine and join', () => {
  expect(reactsLine([])).toBe('')
  expect(reactsLine([{ name: '👍', count: 2 }, { name: 'blob', id: '1', count: 1 }])).toBe('-# 👍 2 · :blob: 1')
  expect(join('', 'a', '', 'b')).toBe('a\nb')
})
