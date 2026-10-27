import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'

import { unittestOutput } from './fixtures'

// The hooks each test registers stand for the engine: they answer the mod's
// calls on `$` from a made-up session whose one command prints a unittest
// result every 2.5 s into its output file.

const TASKS = '/private/tmp/claude-501/-work-app/sess-1/tasks'
const FILE = 'b7x2k9q1z.output'
const COMMAND = 'cd tests && python3 -m unittest -v test_suite 2>&1'
const SPINNER = { word: 'Running the app tests', message: null, suffix: '…', mode: 'tool-use' } as const
const BAND = { hasSurvey: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const

const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

type World = { prompts: string[]; lists: number; toolUseId: string }

function session(on: On, clock: MockClock, reply: string, commandMs = 90_000, surfaces: readonly 'desktop'[] = ['desktop']): World {
  const world: World = { prompts: [], lists: 0, toolUseId: '' }
  let startedAt: number | undefined
  const output = () => (startedAt === undefined ? '' : unittestOutput(Math.min(36, Math.floor((clock.now() - startedAt) / 2500))))

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
    if (command === 'lsof') return { value: ran('4242\n') }
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
    await clock.sleep(commandMs)
    startedAt = undefined
    return { result: { stdout: 'done', stderr: '', interrupted: false } }
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

async function rowLine($: Engine, toolUseId: string) {
  const ui = await $.ui.mount({
    plugin: 'ticker',
    surface: 'desktop',
    component: 'ToolUse',
    requestId: toolUseId,
    props: { tool_use_id: toolUseId, tool: 'Bash', input: { command: COMMAND }, isRunning: true, isErrored: false, isInterrupted: false },
  })
  const line = await textOf(ui, /^(?!row$)/)
  await ui.unmount()
  return line
}

test('the rules line shows at 30 s, then the line from Haiku, in the spinner and under the row', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests, 12 done, one failure so far')
  const row = await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, description: 'Run the 36 app tests' })

  await clock.advance(25_000)
  expect(await textOf(row)).toBe('Running the app tests')
  expect(await rowLine($, world.toolUseId)).toBeUndefined()

  await clock.advance(5_000)
  expect(await textOf(row)).toBe('1 test failed so far (test_08_rotate_image); 12 done')
  expect(world.prompts.length).toBe(0)

  await clock.advance(1_000)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]?.includes('Tests finished so far: 12 (11 passed, 1 failed)')).toBe(true)
  expect(await textOf(row)).toBe('Running the app tests, 12 done, one failure so far')
  expect(await rowLine($, world.toolUseId)).toBe('Running the app tests, 12 done, one failure so far')

  await clock.advance(60_000)
  await call
  expect(await textOf(row)).toBe('Running the app tests')
})

test('Haiku is asked every 20 s while the output changes', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests')
  await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(85_000)
  expect(world.prompts.length).toBe(3)
  await clock.advance(10_000)
  await call
})

test('Haiku is asked every 60 s once the output is quiet', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests', 300_000)
  await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  // Output stops at 90 s (36 tests). Asks: 30, 50, 70, 90, then 150, 210, 270.
  await clock.advance(295_000)
  expect(world.prompts.length).toBe(7)
  await clock.advance(10_000)
  await call
})

test('a reply with a count the rules did not compute gives way to the rules line', async ($, on) => {
  const clock = mock.clock(on)
  session(on, clock, 'Running the app tests, 12 of 36 done')
  const row = await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, description: 'Run the 36 app tests' })
  await clock.advance(31_000)
  expect(await textOf(row)).toBe('1 test failed so far (test_08_rotate_image); 12 done')
  await clock.advance(60_000)
  await call
})

test('the rules setting calls no model', { options: { summaries: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused')
  const row = await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(60_000)
  expect(world.prompts.length).toBe(0)
  expect(await textOf(row)).toBe('1 test failed so far (test_08_rotate_image); 24 done')
  await clock.advance(30_000)
  await call
})

test('Haiku is skipped while no window shows the session', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 90_000, [])
  const row = await spinner($)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(60_000)
  expect(world.prompts.length).toBe(0)
  expect(await textOf(row)).toBe('1 test failed so far (test_08_rotate_image); 24 done')
  await clock.advance(30_000)
  await call
})

test('Haiku is skipped while nothing draws the line', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused')
  const call = $.tool.call({ tool: 'Bash', command: COMMAND })
  await clock.advance(60_000)
  expect(world.prompts.length).toBe(0)
  await clock.advance(30_000)
  await call
})

test("a subagent's command shows in the band while the main chat is idle", async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'Running the app tests, 12 done, one failure so far')
  const idle = await band($, false)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, agentId: 'a1' })
  await clock.advance(31_000)
  expect(world.prompts.length).toBe(1)
  expect(await textOf(idle)).toBe('Subagent: Running the app tests, 12 done, one failure so far')
  await clock.advance(60_000)
  await call
  expect(await textOf(idle)).toBeUndefined()
})

test("a subagent's command shows in the main spinner while the main chat works", async ($, on) => {
  const clock = mock.clock(on)
  session(on, clock, 'Running the app tests, 12 done, one failure so far')
  const row = await spinner($)
  const working = await band($, true)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, agentId: 'a1' })
  await clock.advance(31_000)
  expect(await textOf(row)).toBe('Running the app tests, 12 done, one failure so far')
  expect(await textOf(working)).toBeUndefined()
  await clock.advance(60_000)
  await call
})

test('a background command is left alone', async ($, on) => {
  const clock = mock.clock(on)
  const world = session(on, clock, 'unused', 1_000)
  const call = $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(40_000)
  await call
  expect(world.lists).toBe(0)
  expect(world.prompts.length).toBe(0)
})
