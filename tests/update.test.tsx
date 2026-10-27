import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { isNewer } from '../hooks/update'

// The hooks below stand for the engine and the network: the installed
// plugin.json, the one on GitHub, the store, and `claude plugin update`.

const NAME = 'ticker'
const CLAUDE = '/app/claude'
const RAW = `https://raw.githubusercontent.com/adamalshoomary/${NAME}/main/.claude-plugin/plugin.json`
/** The mod's own band line, which sits beside the update line. */
const OWN_BAND: RegExp | undefined = undefined
const DAY = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

type World = {
  installed: string
  /** The version on GitHub; null answers 404, 'offline' rejects. */
  latest: string | null | 'offline'
  fetches: string[]
  store: Map<string, unknown>
  runs: string[][]
  toasts: string[]
  /** What `claude plugin update --json` prints. */
  reply: object
}

function world(on: On, env: Record<string, string> = {}): World {
  const w: World = {
    installed: '1.0.0',
    latest: '1.1.0',
    fetches: [],
    store: new Map(),
    runs: [],
    toasts: [],
    reply: { command: 'update', outcome: 'ok', pluginId: `${NAME}@${NAME}`, updateOutcome: 'updated', oldVersion: '1.0.0', newVersion: '1.1.0' },
  }
  on('fs.read', (_, e) => ({ value: e.path.endsWith('/.claude-plugin/plugin.json') ? JSON.stringify({ name: NAME, version: w.installed }) : '' }))
  on('http.fetch', async (_, e) => {
    w.fetches.push(e.url)
    if (w.latest === 'offline') throw new Error('offline')
    const isFound = w.latest !== null && e.url === RAW
    return { value: { status: isFound ? 200 : 404, ok: isFound, headers: {}, text: isFound ? JSON.stringify({ name: NAME, version: w.latest }) : 'Not Found' } }
  })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    const stdout = e.argv[0] === CLAUDE ? `${JSON.stringify(w.reply)}\n` : ''
    return { value: { exitCode: e.argv[0] === CLAUDE ? 0 : 1, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  mock.env(on, { CLAUDE_CODE_EXECPATH: CLAUDE, ...env })
  return w
}

const BAND = {
  plugin: NAME,
  surface: 'desktop',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

async function start($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
}

async function lineOf(ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' }))
    .map(found => found.text)
    .filter(text => text !== 'engine' && text.trim() !== '' && OWN_BAND?.test(text) !== true)
    .join('')
    .trim()
}

test('versions compare by number', async () => {
  expect(isNewer('1.1.0', '1.0.0')).toBe(true)
  expect(isNewer('1.10.0', '1.9.3')).toBe(true)
  expect(isNewer('2.0.0', '10.0.0')).toBe(false)
  expect(isNewer('1.0.0', '1.0.0')).toBe(false)
  expect(isNewer('0.9.9', '1.0.0')).toBe(false)
  expect(isNewer('main', '1.0.0')).toBe(false)
})

test('a newer version is offered, and Update installs it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  const band = await $.ui.mount(BAND)
  await start($, clock)
  expect(w.fetches).toEqual([RAW])
  expect(await lineOf(band)).toBe(`${NAME} 1.1.0 is out`)
  expect(w.toasts).toEqual(['1.1.0 is out. Update it above the prompt.'])
  expect((await band.find({ key: 'update-now' }))?.props.label).toBe('Update')
  await band.press({ key: 'update-now' })
  expect(w.runs.at(-1)).toEqual([CLAUDE, 'plugin', 'update', `${NAME}@${NAME}`, '--json'])
  expect(await lineOf(band)).toBe(`${NAME} 1.1.0 is installed. Next chat uses it.`)
  await band.press({ key: 'update-ok' })
  expect(await lineOf(band)).toBe('')
})

test('the same or an older version shows nothing', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.latest = '1.0.0'
  const band = await $.ui.mount(BAND)
  await start($, clock)
  expect(await lineOf(band)).toBe('')
  w.installed = '1.2.0'
  w.latest = '1.1.0'
  await clock.advance(DAY)
  await start($, clock)
  expect(w.fetches.length).toBe(2)
  expect(await lineOf(band)).toBe('')
})

test('offline, or a missing file, shows nothing and keeps no check', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.latest = 'offline'
  const band = await $.ui.mount(BAND)
  await start($, clock)
  expect(await lineOf(band)).toBe('')
  w.latest = null
  await start($, clock)
  expect(await lineOf(band)).toBe('')
  expect(w.fetches.length).toBe(2)
  expect(w.store.has('update')).toBe(false)
})

test('one check a day: a second session that day reads the kept answer', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  const band = await $.ui.mount(BAND)
  await start($, clock)
  await clock.advance(DAY / 2)
  await start($, clock)
  expect(w.fetches.length).toBe(1)
  expect(await lineOf(band)).toBe(`${NAME} 1.1.0 is out`)
  expect(w.toasts.length).toBe(1)
})

test('Not now hides that version until a newer one comes out', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  const band = await $.ui.mount(BAND)
  await start($, clock)
  await band.press({ key: 'update-later' })
  expect(await lineOf(band)).toBe('')
  expect(w.runs.filter(argv => argv[0] === CLAUDE).length).toBe(0)
  await clock.advance(DAY)
  await start($, clock)
  expect(await lineOf(band)).toBe('')
  w.latest = '1.2.0'
  await clock.advance(DAY)
  await start($, clock)
  expect(await lineOf(band)).toBe(`${NAME} 1.2.0 is out`)
  expect(w.toasts.length).toBe(2)
})

test('an update Claude Code finds already done says so', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.reply = { command: 'update', outcome: 'ok', pluginId: `${NAME}@${NAME}`, updateOutcome: 'up_to_date', oldVersion: '1.1.0', newVersion: '1.1.0' }
  const band = await $.ui.mount(BAND)
  await start($, clock)
  await band.press({ key: 'update-now' })
  expect(await lineOf(band)).toBe(`${NAME} 1.1.0 is installed. Next chat uses it.`)
})

test('a failed update says so and names the command', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.reply = { command: 'update', outcome: 'failed', pluginId: `${NAME}@${NAME}`, message: 'Network error.', failureCode: 'network' }
  const band = await $.ui.mount(BAND)
  await start($, clock)
  await band.press({ key: 'update-now' })
  expect(await lineOf(band)).toBe(`Couldn't update: Network error. Run claude plugin update ${NAME}@${NAME} in a terminal.`)
})

test('nonessential traffic turned off: no check at all', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const band = await $.ui.mount(BAND)
  await start($, clock)
  expect(w.fetches.length).toBe(0)
  expect(await lineOf(band)).toBe('')
  expect(w.toasts.length).toBe(0)
})
