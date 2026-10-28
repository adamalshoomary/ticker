import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'

import { unittestOutput } from './fixtures'

// The hooks each test registers stand for the engine: they answer the mod's
// calls on `$` from a made-up session whose one command prints a unittest
// result every 2.5 s into its output file.

const TASKS = '/private/tmp/claude-501/-work-app/sess-1/tasks'
const TASK = 'b7x2k9q1z'
const FILE = `${TASK}.output`
const COMMAND = 'cd tests && python3 -m unittest -v test_suite 2>&1'
const SPINNER = { word: 'Running the app tests', message: null, suffix: '…', mode: 'tool-use' } as const
const BAND = { hasSurvey: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const

const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

type World = {
  prompts: string[]
  lists: number
  toolUseId: string
  /** The setting `/ticker` flips, as `/config` holds it. */
  summaries: string
  /** Why a change to the setting is refused, when it is. */
  deny?: string
  commands: string[]
}

/**
 * How the command meets the background: `start` runs it there and closes its
 * output with Claude Code's exit line; `moved` sends it there after 40 s, as
 * Ctrl+B does, and ends with no exit line, so only lsof tells it ended.
 */
type Background = 'start' | 'moved'

function session(on: On, clock: MockClock, reply: string, commandMs = 90_000, surfaces: readonly 'desktop'[] = ['desktop'], background?: Background): World {
  const world: World = { prompts: [], lists: 0, toolUseId: '', summaries: 'haiku', commands: [] }
  let startedAt: number | undefined
  /** When a background command ended: its file stays, and no process holds it. */
  let endedAt: number | undefined
  const output = () => {
    if (startedAt === undefined) return ''
    const text = unittestOutput(Math.min(36, Math.floor(((endedAt ?? clock.now()) - startedAt) / 2500)))
    return endedAt !== undefined && background === 'start' ? `${text}\n[exited with code 0]\n` : text
  }

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('config.list', () => ({
    value: [
      { key: 'ticker.summaries', label: 'Who writes the line', kind: 'choice' as const, value: world.summaries, options: ['haiku', 'rules'], provider: { plugin: 'ticker', tier: 'user' as const }, isLocked: false },
    ],
  }))
  on('config.set', (_, e) => {
    if (world.deny !== undefined) return { deny: world.deny }
    world.summaries = String(e.value)
    return { value: e.value }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('env.get', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === TASKS }))
  on('fs.list', () => {
    world.lists += 1
    const link = { name: 'a2fe06a0fcf9634fe.output', kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true }
    return { value: startedAt === undefined ? [link] : [link, { name: FILE, kind: 'file' as const, size: output().length, mtimeMs: 0, isLink: false }] }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: output().length, mtimeMs: 0, isLink: false } }))
  on('process.run', (_, e) => {
    const [command, ...args] = e.argv
    if (command === 'id') return { value: ran('501\n') }
    if (command === 'lsof') return { value: startedAt !== undefined && endedAt === undefined ? ran('4242\n') : ran('', 1) }
    if (command === 'ps') return { value: ran(`/bin/zsh -c source /snap.sh && eval '${COMMAND}' < /dev/null && pwd -P\n`) }
    if (command === '/bin/sh') {
      const from = Number(args[3]) - 1
      return { value: ran(output().slice(from, from + Number(args[5]))) }
    }
    return { value: ran('', 1) }
  })
  on('model.complete', (_, e) => {
    world.prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: reply, usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('tool.call', async (_, e) => {
    world.toolUseId = e.tool_use_id
    startedAt = clock.now()
    if (background === undefined) {
      await clock.sleep(commandMs)
      startedAt = undefined
      return { result: { stdout: 'done', stderr: '', interrupted: false } }
    }
    void clock.sleep(commandMs).then(() => {
      endedAt = clock.now()
    })
    if (background === 'moved') await clock.sleep(40_000)
    return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: TASK, backgroundedByUser: background === 'moved' } }
  })
  // What the engine draws: the spinner's text, and a plain row for the command.
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.message ?? e.props.word}</Text>
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>row</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>group</Text>
  })
  return world
}

/** The spinner row, mounted for the whole test as the app keeps it on screen. */
function spinner($: Engine, requestId = 'main') {
  return $.ui.mount({ plugin: 'ticker', surface: 'desktop', component: 'Spinner', requestId, props: SPINNER })
}

function band($: Engine, isWorking: boolean) {
  return $.ui.mount({ plugin: 'ticker', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, isWorking } })
}

async function textOf(ui: { find: Mounted<'desktop'>['find'] }, text: RegExp = /./) {
  return (await ui.find({ type: 'Text', text }))?.text
}

/** The command's row, mounted and kept on screen as the transcript keeps it. A background command's row has stopped running. */
function toolRow($: Engine, toolUseId: string, isRunning = true) {
  return $.ui.mount({
    plugin: 'ticker',
    surface: 'desktop',
    component: 'ToolUse',
    requestId: toolUseId,
    props: { tool_use_id: toolUseId, tool: 'Bash', input: { command: COMMAND }, isRunning, isErrored: false, isInterrupted: false },
  })
}

async function lineUnder(ui: { find: Mounted<'desktop'>['find'] }) {
  return textOf(ui, /^(?!row$)/)
}

test('the rules line shows under the row at 30 s, then the line from Haiku; the spinner keeps its own words', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests, 12 done, one failure so far')
  const spin = await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, description: 'Run the 36 app tests' })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)

  await clock.advance(24_000)
  expect(await lineUnder(row)).toBeUndefined()

  await clock.advance(5_000)
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 12 done')
  expect(world.prompts.length).toBe(0)

  await clock.advance(1_000)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]?.includes('Tests finished so far: 12 (11 passed, 1 failed)')).toBe(true)
  expect(await lineUnder(row)).toBe('Running the app tests, 12 done, one failure so far')
  expect(await textOf(spin)).toBe('Running the app tests')

  await clock.advance(60_000)
  await call
  expect(await textOf(spin)).toBe('Running the app tests')
})

/** The wave's markup under a row, and the undraw's while the line goes. */
async function wavesUnder(ui: { findAll: Mounted<'desktop'>['findAll'] }) {
  return (await ui.findAll({ type: 'Svg' })).map(one => String(one.props.source))
}

test('the wave keeps one source while the line changes, so the app keeps its frame', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests, 12 done, one failure so far')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(29_000)
  const [first] = await wavesUnder(row)
  expect(first?.includes('animation:i 1.2s')).toBe(true)
  await clock.advance(1_000)
  expect(await lineUnder(row)).toBe('Running the app tests, 12 done, one failure so far')
  expect(await wavesUnder(row)).toEqual([first])
  await clock.advance(30_000)
  expect(await wavesUnder(row)).toEqual([first])
  await clock.advance(30_000)
  await call
})

test('when the command ends, its line stays while the wave draws out over it', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 40_000)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(34_000)
  const [running] = await wavesUnder(row)
  await clock.advance(5_000)
  await call
  await clock.advance(0)
  // The undraw lies over the running wave, which stays until the undraw has loaded.
  const ending = await wavesUnder(row)
  expect(ending.length).toBe(2)
  expect(ending[0]).toBe(running)
  expect(ending[1]?.includes('animation:o 1.7s')).toBe(true)
  expect((await row.find({ type: 'Box', key: 'undraw' }))?.props.position).toBe('absolute')
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 14 done')
  await clock.advance(500)
  const cleared = await wavesUnder(row)
  expect(cleared[0]?.includes('<path')).toBe(false)
  expect(cleared[1]).toBe(ending[1])
  await clock.advance(1_400)
  expect(await lineUnder(row)).toBeUndefined()
  expect(await wavesUnder(row)).toEqual([])
})

test('a command that ends before its line shows leaves nothing to draw out', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 10_000)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(10_000)
  await call
  expect(await wavesUnder(row)).toEqual([])
  expect(await lineUnder(row)).toBeUndefined()
})

/** Where the line's tape starts under a row: the line's padding, and the inset read from the width its icon draws at. */
async function placeUnder(ui: { find: Mounted<'desktop'>['find'] }) {
  const icon = await ui.find({ type: 'Svg' })
  const line = await ui.find({ type: 'Box', text: /^\d/ })
  return icon === undefined ? undefined : { pad: line?.props.paddingLeft, inset: Number(icon.props.width) - 20 }
}

test("a command's line inside a grouped run box moves left with the row's text", { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(30_000)
  expect(await placeUnder(row)).toEqual({ pad: 1, inset: 28 })
  await clock.advance(2_000)

  const calls = [
    { tool_use_id: 'read-1', tool: 'Read', input: { file_path: '/work/app/README.md' }, isRunning: false, isErrored: false, isInterrupted: false },
    { tool_use_id: world.toolUseId, tool: 'Bash', input: { command: COMMAND }, isRunning: true, isErrored: false, isInterrupted: false },
  ]
  await $.ui.mount({ plugin: 'ticker', surface: 'desktop', component: 'ToolGroup', props: { calls, isActive: true, isExpanded: true } })
  await clock.advance(0)
  expect(await placeUnder(row)).toEqual({ pad: 0, inset: 0 })
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 12 done')
  // Moved after its draw in, the wave starts drawn, its sway in step.
  const [moved] = await wavesUnder(row)
  expect(moved?.includes('animation:i ')).toBe(false)
  expect(moved?.includes('animation:s 4.8s')).toBe(true)

  await clock.advance(60_000)
  await call
})

test('a command alone keeps the top-level inset when a group of other calls draws', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  const calls = [{ tool_use_id: 'read-1', tool: 'Read', input: { file_path: '/work/app/README.md' }, isRunning: false, isErrored: false, isInterrupted: false }]
  await $.ui.mount({ plugin: 'ticker', surface: 'desktop', component: 'ToolGroup', props: { calls, isActive: false, isExpanded: true } })
  await clock.advance(30_000)
  expect(await placeUnder(row)).toEqual({ pad: 1, inset: 28 })
  await clock.advance(60_000)
  await call
})

test('Haiku is asked every 20 s while the output changes', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  await toolRow($, world.toolUseId)
  await clock.advance(84_000)
  expect(world.prompts.length).toBe(3)
  await clock.advance(10_000)
  await call
})

test('Haiku is asked every 60 s once the output is quiet', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests', 300_000)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  await toolRow($, world.toolUseId)
  // Output stops at 90 s (36 tests). Asks: 30, 50, 70, 90, then 150, 210, 270.
  await clock.advance(294_000)
  expect(world.prompts.length).toBe(7)
  await clock.advance(10_000)
  await call
})

test('a reply with a count the rules did not compute gives way to the rules line', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests, 12 of 36 done')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, description: 'Run the 36 app tests' })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(30_000)
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 12 done')
  await clock.advance(60_000)
  await call
})

test('the rules setting calls no model', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(59_000)
  expect(world.prompts.length).toBe(0)
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 24 done')
  await clock.advance(30_000)
  await call
})

test('Haiku is skipped while no window shows the session', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 90_000, [])
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(59_000)
  expect(world.prompts.length).toBe(0)
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 24 done')
  await clock.advance(30_000)
  await call
})

test('Haiku is skipped while nothing draws the line', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused')
  await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(60_000)
  expect(world.prompts.length).toBe(0)
  await clock.advance(30_000)
  await call
})

test("a subagent's command gets no line and calls no model", async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests, 12 done, one failure so far')
  const spin = await spinner($)
  const working = await band($, true)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, agentId: 'a1' })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(60_000)
  expect(world.prompts.length).toBe(0)
  expect(world.lists).toBe(0)
  expect(await lineUnder(row)).toBeUndefined()
  expect(await textOf(working)).toBeUndefined()
  expect(await textOf(spin)).toBe('Running the app tests')
  await clock.advance(30_000)
  await call
})

test('a background call whose result names no task gets no line', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 1_000)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(40_000)
  await call
  expect(world.lists).toBe(0)
  expect(world.prompts.length).toBe(0)
})

test('a background command keeps its line under its row until it ends', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 90_000, ['desktop'], 'start')
  const idle = await band($, false)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  const row = await toolRow($, world.toolUseId, false)
  await clock.advance(29_000)
  expect(await lineUnder(row)).toBeUndefined()
  await clock.advance(2_000)
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 12 done')
  expect(await placeUnder(row)).toEqual({ pad: 0, inset: 0 })
  await clock.advance(55_000)
  expect(await lineUnder(row)).toBe('2 tests failed so far (test_08_rotate_image, test_33_billing_tax); 34 done')
  expect(await textOf(idle)).toBeUndefined()
  // The command ends at 90 s with its exit line; the next poll removes the line.
  await clock.advance(10_000)
  expect(await lineUnder(row)).toBeUndefined()
})

test('a command moved to the background keeps its line until no process holds its file', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 90_000, ['desktop'], 'moved')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(30_000)
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 12 done')
  await clock.advance(10_000)
  await call
  // The app redraws the row as stopped.
  await row.unmount()
  const stopped = await toolRow($, world.toolUseId, false)
  expect(await lineUnder(stopped)).toMatch(/^1 test failed so far \(test_08_rotate_image\); 1[46] done$/)
  await clock.advance(45_000)
  expect(await lineUnder(stopped)).toBe('2 tests failed so far (test_08_rotate_image, test_33_billing_tax); 34 done')
  // The command ends at 90 s with no exit line; the polls at 90 s and 95 s find no process holding its file.
  await clock.advance(15_000)
  expect(await lineUnder(stopped)).toBeUndefined()
})

test('Haiku writes a background line too', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests, 12 done, one failure so far', 90_000, ['desktop'], 'start')
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  const row = await toolRow($, world.toolUseId, false)
  await clock.advance(31_000)
  expect(world.prompts.length).toBe(1)
  expect(await lineUnder(row)).toBe('Running the app tests, 12 done, one failure so far')
  await clock.advance(70_000)
  expect(await lineUnder(row)).toBeUndefined()
})

/** `/ticker` as the person types it in the prompt box. */
const TYPED = { command: 'ticker', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

test('/ticker turns on free mode: the next command calls no model', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests')
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  expect(world.commands).toEqual(['ticker'])
  const { text } = await $.command.run(TYPED)
  expect(text).toBe('Free mode is on')
  expect(world.summaries).toBe('rules')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(59_000)
  expect(world.prompts.length).toBe(0)
  expect(await lineUnder(row)).toBe('1 test failed so far (test_08_rotate_image); 24 done')
  await clock.advance(30_000)
  await call
})

test('/ticker in free mode turns Haiku back on', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests')
  world.summaries = 'rules'
  const { text } = await $.command.run(TYPED)
  expect(text).toBe('Haiku is on')
  expect(world.summaries).toBe('haiku')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  const row = await toolRow($, world.toolUseId)
  await clock.advance(30_000)
  expect(world.prompts.length).toBe(1)
  expect(await lineUnder(row)).toBe('Running the app tests')
  await clock.advance(60_000)
  await call
})

test('a refused switch says why and keeps the mode', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests')
  world.deny = 'your organization sets it'
  const { text } = await $.command.run(TYPED)
  expect(text).toBe('Could not switch: your organization sets it')
  expect(world.summaries).toBe('haiku')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(1_000)
  await toolRow($, world.toolUseId)
  await clock.advance(30_000)
  expect(world.prompts.length).toBe(1)
  await clock.advance(60_000)
  await call
})
