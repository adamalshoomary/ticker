import type { EngineInterface, Register } from 'claude-code'

import { acceptReply, feed, newTally, promptFor, rulesLine, skipTo, SYSTEM, type Tally } from './lines'
import { HOLD_S, UNDRAW_S, waveCleared, waveRunning, waveUndraw } from './icons'
import { checkSoon, registerUpdate } from './update'

// ticker: while a Bash command runs in the main chat, read the output file
// Claude Code writes for it, count what known tools report, and show one
// plain-words line under the command's row. The spinner keeps Claude Code's
// own words. A command that runs in the background keeps its line under its
// row, though the row has stopped running, until no process holds its output
// file open. A subagent's commands get no line. Haiku writes the sentence from
// the counted facts; the rules line stands in until it answers, and whenever
// it cannot. When the command ends, its line stays while the wave draws out.

/** How often the output file is read. */
const POLL_MS = 5_000
/** When the line first shows. A shorter command needs no line. */
const SHOW_AFTER_MS = 30_000
/** How often Haiku is asked again while the output keeps changing, and while it is quiet. */
const ASK_CHANGED_MS = 20_000
const ASK_QUIET_MS = 60_000
/** Haiku calls for one command at most; after that the rules line stands. */
const MAX_ASKS = 30
/** Polls in a row with no window drawing the session before Haiku is skipped. */
const HIDDEN_POLLS = 3
/** Polls in a row with no process holding a background command's output file before its line goes. */
const FREE_POLLS = 2
/** How long a new line has to be drawn somewhere before Haiku is asked for it. */
const SEEN_WAIT_MS = 500
/** New output read in one poll at most; past it the counts are dropped as partial. */
const READ_MAX = 1 << 20
const READ_TAIL = 64 * 1024
/** What `/ticker` says once it has switched, by the setting's new value. The app puts "ticker:" before it. */
const SWITCHED = { rules: 'Free mode is on', haiku: 'Haiku is on' } as const
/** A path to log each step to while developing; empty in a release. */
const DEV_LOG: string = ''

type Run = {
  id: string
  command: string
  description?: string
  startedAt: number
  /** Output files that were there before the command started. */
  before: Set<string>
  file?: string
  tally: Tally
  changedAt: number
  rules?: string
  sentence?: string
  asks: number
  askedAt: number
  askedBytes: number
  isAsking: boolean
  isPolling: boolean
  hiddenPolls: number
  /** A surface has drawn this command's line; Haiku is asked only for a line someone can see. */
  isSeen: boolean
  /** Haiku writes this command's line. Set as the command starts, so a switch applies from the next command. */
  useModel: boolean
  /** The command runs on in the background: started there, or moved there by Ctrl+B or its timeout. */
  isBackground: boolean
  freePolls: number
  timer?: { cancel(): void }
  /** When a surface first drew this command's line. */
  shownAt?: number
  /** The wave's markup for the inset it draws at. It stays the same while the inset does, so the app keeps its frame. */
  wave?: { inset: number; source: string }
  /** Where the line last drew. */
  place?: Place
}

/** A line whose command has ended, kept while its wave draws out over the running one. */
type Leaving = { text: string; place: Place; wave: string; undraw: string; isCleared: boolean }

const runs = new Map<string, Run>()
const leaving = new Map<string, Leaving>()
let tasksDir: string | undefined
const logLines: string[] = []

async function log($: EngineInterface, text: string) {
  if (DEV_LOG === '') return
  const now = new Date(await $.clock.now()).toISOString().slice(11, 23)
  logLines.push(`${now} ${text}`)
  if (logLines.length > 2000) logLines.splice(0, 500)
  await $.fs.write(DEV_LOG, `${logLines.join('\n')}\n`).catch(() => undefined)
}

// Claude Code writes a running command's output to
// <tmp>/claude-<uid>/<project path with / as ->/<session id>/tasks/<id>.output.
// The folder appears with the session's first command, so a miss is not kept.
async function findTasksDir($: EngineInterface): Promise<string | undefined> {
  if (tasksDir !== undefined) return tasksDir
  const [uid, id, root, tmp] = await Promise.all([
    $.process.run(['id', '-u']).then(r => r.stdout.trim()),
    $.session.id(),
    $.session.root(),
    $.env.get('CLAUDE_CODE_TMPDIR'),
  ])
  const slug = root.replace(/[^A-Za-z0-9]/g, '-')
  const bases = [tmp, '/private/tmp', '/tmp'].filter((one): one is string => Boolean(one)).map(one => `${one.replace(/\/$/, '')}/claude-${uid}`)
  for (const base of bases) {
    const guess = `${base}/${slug}/${id}/tasks`
    if (await $.fs.exists(guess)) return (tasksDir = guess)
  }
  // A long project path is shortened in the folder's name: look for the session id instead.
  for (const base of bases) {
    const projects = await $.fs.list(base).catch(() => [])
    for (const one of projects) {
      const guess = `${base}/${one.name}/${id}/tasks`
      if (one.kind === 'dir' && (await $.fs.exists(guess))) return (tasksDir = guess)
    }
  }
  return undefined
}

async function outputFiles($: EngineInterface, dir: string) {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.filter(one => one.name.endsWith('.output') && one.kind === 'file' && !one.isLink)
}

// The shell that runs the command holds its output file open, and its own
// command line holds the command after `eval '`. That ties a new file to its
// command when two commands start together.
async function claimFile($: EngineInterface, run: Run, dir: string) {
  const held = new Set([...runs.values()].map(one => one.file))
  const fresh = (await outputFiles($, dir)).filter(one => !run.before.has(one.name) && !held.has(one.name))
  if (fresh.length === 0) return
  const head = run.command.split(/['\n]/)[0]?.slice(0, 60) ?? ''
  let isLsofRun = false
  for (const one of fresh) {
    const lsof = await $.process.run(['lsof', '-t', `${dir}/${one.name}`]).catch(() => undefined)
    if (lsof === undefined) continue
    isLsofRun = true
    for (const pid of lsof.stdout.split(/\s+/).filter(Boolean)) {
      const ps = await $.process.run(['ps', '-ww', '-o', 'command=', '-p', pid]).catch(() => undefined)
      if (ps?.stdout.includes(`eval '${head}`)) {
        run.file = one.name
        await log($, `claim ${run.id} file=${one.name} by=lsof candidates=${fresh.length}`)
        return
      }
    }
  }
  // Without lsof, one new file and one command waiting for a file belong together.
  const waiting = [...runs.values()].filter(one => one.file === undefined)
  if (!isLsofRun && fresh.length === 1 && waiting.length === 1 && fresh[0]) {
    run.file = fresh[0].name
    await log($, `claim ${run.id} file=${run.file} by=only-one`)
  }
}

async function readNew($: EngineInterface, run: Run, path: string, now: number) {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.size === run.tally.bytes) return
  let from = run.tally.bytes
  if (stat.size < from) from = 0
  let length = stat.size - from
  if (length > READ_MAX) {
    skipTo(run.tally, stat.size - READ_TAIL)
    from = stat.size - READ_TAIL
    length = READ_TAIL
  }
  const read = await $.process.run(['/bin/sh', '-c', 'tail -c "+$1" "$2" | head -c "$3"', 'sh', String(from + 1), path, String(length)])
  if (read.exitCode !== 0 && read.stdout === '') return
  feed(run.tally, read.stdout, from + length)
  run.changedAt = now
}

// The session's window can be closed or on another chat; Haiku is skipped
// once no surface has drawn the session for a few polls in a row.
async function isWatched($: EngineInterface, run: Run) {
  const surfaces = await $.session.surfaces().catch(() => undefined)
  run.hiddenPolls = surfaces !== undefined && surfaces.length === 0 ? run.hiddenPolls + 1 : 0
  return run.hiddenPolls < HIDDEN_POLLS
}

async function ask($: EngineInterface, run: Run) {
  const now = await $.clock.now()
  run.isAsking = true
  run.asks += 1
  run.askedAt = now
  run.askedBytes = run.tally.bytes
  const { prompt, facts, sent } = promptFor({
    command: run.command,
    description: run.description,
    tally: run.tally,
    quietMs: now - run.changedAt,
    previous: run.sentence,
  })
  const answer = await $.model
    .complete({ model: 'haiku', system: SYSTEM, prompt, maxTokens: 60, effort: 'low', timeoutMs: 8_000 })
    .catch((error: unknown) => ({ isAnswered: false as const, reason: String(error), usage: undefined }))
  run.isAsking = false
  if (!runs.has(run.id)) return
  const took = (await $.clock.now()) - now
  if (!answer.isAnswered) {
    run.sentence = undefined
    await log($, `model ${run.id} #${run.asks} ms=${took} unanswered=${answer.reason}`)
  } else {
    const accepted = acceptReply(answer.text, facts, sent)
    run.sentence = 'line' in accepted ? accepted.line : undefined
    await log(
      $,
      `model ${run.id} #${run.asks} ms=${took} in=${answer.usage.input_tokens} out=${answer.usage.output_tokens} text=${JSON.stringify(answer.text)} ${'line' in accepted ? 'shown' : `refused=${accepted.refused}`}`,
    )
  }
  $.ui.invalidate('ui.render')
}

/** The last line Claude Code writes to a background command's output file when the command ends. */
const EXITED = /^\[exited with code -?\d+\]$/

// The shell that runs a command holds its output file open until the command
// ends. Without lsof nothing counts as held, so a background line goes at once.
async function isHeld($: EngineInterface, path: string) {
  const lsof = await $.process.run(['lsof', '-t', path]).catch(() => undefined)
  return lsof !== undefined && lsof.stdout.trim() !== ''
}

/** A background command has ended at its exit line, or after polls in a row with no process holding its file. */
async function hasEnded($: EngineInterface, run: Run, path: string) {
  if (EXITED.test(run.tally.latest.at(-1) ?? '')) return true
  run.freePolls = (await isHeld($, path)) ? 0 : run.freePolls + 1
  return run.freePolls >= FREE_POLLS
}

async function end($: EngineInterface, run: Run) {
  run.timer?.cancel()
  runs.delete(run.id)
  grouped.delete(run.id)
  const now = await $.clock.now()
  await log($, `end ${run.id} after ${Math.round((now - run.startedAt) / 1000)}s asks=${run.asks}`)
  const text = lineOf(run)
  if (text !== undefined && run.wave !== undefined && run.place !== undefined && run.shownAt !== undefined) {
    // The undraw is drawn over the running wave, which stays until the
    // undraw's frame has loaded and covers it; a swapped source would blink.
    const ageS = (now - run.shownAt) / 1000
    const line: Leaving = { text, place: run.place, wave: run.wave.source, undraw: waveUndraw(LINE_PX, run.place.inset, ageS), isCleared: false }
    leaving.set(run.id, line)
    $.clock.after(HOLD_S * 1000 - 50, () => {
      line.isCleared = true
      $.ui.invalidate('ui.render')
    })
    $.clock.after((HOLD_S + UNDRAW_S) * 1000 + 150, () => {
      if (leaving.get(run.id) === line) leaving.delete(run.id)
      $.ui.invalidate('ui.render')
    })
  }
  if (run.rules !== undefined) $.ui.invalidate('ui.render')
}

/** The tool's result names a background task when the command runs on after the call returns. */
function backgroundTaskOf(answer: unknown) {
  const id = (answer as { result?: { backgroundTaskId?: unknown } } | undefined)?.result?.backgroundTaskId
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined
}

/** Keeps a command's line going under its row after the call returns, while the command runs on. */
async function follow($: EngineInterface, run: Run, taskId: string) {
  run.isBackground = true
  run.file = `${taskId}.output`
  runs.set(run.id, run)
  run.timer ??= $.clock.every(POLL_MS, () => {
    void poll($, run)
  })
  await log($, `background ${run.id} task=${taskId}`)
  if (run.rules !== undefined) $.ui.invalidate('ui.render')
}

async function poll($: EngineInterface, run: Run) {
  if (run.isPolling) return
  run.isPolling = true
  try {
    const now = await $.clock.now()
    const dir = await findTasksDir($)
    if (dir !== undefined && run.file === undefined) await claimFile($, run, dir)
    if (dir !== undefined && run.file !== undefined) await readNew($, run, `${dir}/${run.file}`, now)
    if (run.isBackground && dir !== undefined && run.file !== undefined && (await hasEnded($, run, `${dir}/${run.file}`))) {
      return void (await end($, run))
    }
    const watched = await isWatched($, run)
    const elapsed = now - run.startedAt
    if (elapsed < SHOW_AFTER_MS - 1_000) return
    const rules = rulesLine(run.tally, run.command)
    const isNew = run.rules === undefined
    run.rules = rules
    await log($, `poll ${run.id} t=${Math.round(elapsed / 1000)}s file=${run.file ?? '-'} bytes=${run.tally.bytes} rules=${JSON.stringify(rules)}`)
    if (isNew || run.sentence === undefined) $.ui.invalidate('ui.render')
    if (!run.useModel || !watched || run.isAsking || run.asks >= MAX_ASKS) return
    const wait = run.asks === 0 ? 0 : run.tally.bytes !== run.askedBytes ? ASK_CHANGED_MS : ASK_QUIET_MS
    if (now - run.askedAt < wait - 1_000) return
    if (!run.isSeen) await $.clock.sleep(SEEN_WAIT_MS)
    if (run.isSeen && runs.has(run.id)) void ask($, run)
    else if (isNew) await log($, `model ${run.id} skipped: no surface drew the line`)
  } catch (error) {
    await log($, `poll ${run.id} failed: ${String(error)}`)
  } finally {
    run.isPolling = false
  }
}

const drawn = new Set<string>()

// Development evidence: each new line a surface asked the mod to draw, once.
async function noteDrawn($: EngineInterface, site: string, surface: string, line: string) {
  if (DEV_LOG === '' || drawn.has(`${site}/${line}`)) return
  drawn.add(`${site}/${line}`)
  await log($, `drawn ${site} surface=${surface} line=${JSON.stringify(line)}`)
}

function lineOf(run: Run | undefined) {
  return run?.sentence ?? run?.rules
}

/** Where the tape starts under a row, so it sits under the first letter of the row's text: padding in cells, then an inset in CSS pixels. */
type Place = { pad: number; inset: number }
const TOP_LEVEL: Place = { pad: 1, inset: 28 }
/** Inside a grouped run box the row's text starts at the line's own left edge (measured on desktop, 2026-10-28). */
const GROUPED: Place = { pad: 0, inset: 0 }
/** A stopped row, such as a background command's, draws no spinner, so its text starts at the same edge (desktop, 2026-10-28). */
const STOPPED: Place = GROUPED

/** Running commands the app has drawn inside a grouped run box, by tool_use_id. */
const grouped = new Set<string>()

/** The size the wave draws at, in CSS pixels. */
const LINE_PX = 20

/**
 * The line under a row: the wave starts under the row text's first letter,
 * the words follow it. As the line goes, its undraw lies exactly over the wave.
 */
function subLine(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  text: string,
  { place, wave, undraw }: { place: Place; wave: string; undraw?: string },
) {
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Svg = 'Svg' in els ? els.Svg : undefined
  const width = LINE_PX + place.inset
  return (
    <Box flexDirection="row" alignItems="center" gap={2} paddingLeft={place.pad}>
      {Svg && (
        <Box key="tape" position="relative">
          <Box key="wave">
            <Svg source={wave} alt="ticker" width={width} height={LINE_PX} isInteractive />
          </Box>
          {undraw !== undefined && (
            <Box key="undraw" position="absolute" top={0} left={0}>
              <Svg source={undraw} alt="ticker" width={width} height={LINE_PX} isInteractive />
            </Box>
          )}
        </Box>
      )}
      <Text size="footnote" dimColor>
        {text}
      </Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  let useModel = options.summaries !== 'rules'
  registerUpdate(on)

  on('session.start', ($, e, next) => {
    checkSoon($)
    void $.command.register({ name: 'ticker', description: 'Switch the line between Haiku and free mode' }).catch(() => undefined)
    return next(e)
  })

  // `/ticker` flips the mod's own setting, so `/config` shows the same choice
  // and it lasts across chats. The next command follows it.
  on('command.run', { command: 'ticker' }, async $ => {
    const key = `${$.plugin.name}.summaries`
    const row = (await $.config.list().catch(() => [])).find(one => one.key === key)
    const to = (row?.value ?? options.summaries) === 'rules' ? 'haiku' : 'rules'
    const done = await $.config.set({ key, value: to }).catch((error: unknown) => ({ deny: String(error) }))
    if (done.deny !== undefined) return { text: `Could not switch: ${done.deny}` }
    useModel = to === 'haiku'
    return { text: SWITCHED[to] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const isBackground = e.run_in_background === true
    const dir = isBackground ? undefined : await findTasksDir($)
    const startedAt = await $.clock.now()
    const run: Run = {
      id: e.tool_use_id,
      command: e.command,
      description: e.description,
      startedAt,
      before: new Set(dir === undefined ? [] : (await outputFiles($, dir)).map(one => one.name)),
      tally: newTally(),
      changedAt: startedAt,
      asks: 0,
      askedAt: 0,
      askedBytes: -1,
      isAsking: false,
      isPolling: false,
      hiddenPolls: 0,
      isSeen: false,
      isBackground: false,
      freePolls: 0,
      useModel,
    }
    await log($, `start ${run.id} background=${isBackground} model=${run.useModel} cmd=${JSON.stringify(run.command.slice(0, 120))}`)
    if (isBackground) {
      const answer = await next(e)
      const taskId = backgroundTaskOf(answer)
      if (taskId !== undefined) await follow($, run, taskId)
      return answer
    }
    runs.set(run.id, run)
    run.timer = $.clock.every(POLL_MS, () => {
      void poll($, run)
    })
    let taskId: string | undefined
    try {
      const answer = await next(e)
      taskId = backgroundTaskOf(answer)
      return answer
    } finally {
      if (taskId === undefined) await end($, run)
      else await follow($, run, taskId)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash') return next(e)
    const gone = leaving.get(e.props.tool_use_id)
    if (gone !== undefined) {
      const { Box } = $.ui.resolve(e)
      const row = await next(e)
      const wave = gone.isCleared ? waveCleared(LINE_PX, gone.place.inset) : gone.wave
      return (
        <Box flexDirection="column">
          {row}
          {subLine($, e, gone.text, { place: gone.place, wave, undraw: gone.undraw })}
        </Box>
      )
    }
    const run = runs.get(e.props.tool_use_id)
    const line = lineOf(run)
    // A row that stops before the command's end is handled keeps the line where it was.
    if (run === undefined || line === undefined || !(e.props.isRunning || run.isBackground || run.place !== undefined)) return next(e)
    run.isSeen = true
    const isGrouped = grouped.has(run.id)
    void noteDrawn($, isGrouped ? 'ToolUse in group' : 'ToolUse', e.surface, line)
    const place = isGrouped ? GROUPED : e.props.isRunning ? TOP_LEVEL : run.isBackground ? STOPPED : (run.place ?? STOPPED)
    const now = await $.clock.now()
    run.shownAt ??= now
    if (run.wave?.inset !== place.inset) run.wave = { inset: place.inset, source: waveRunning(LINE_PX, place.inset, (now - run.shownAt) / 1000) }
    run.place = place
    const { Box } = $.ui.resolve(e)
    const row = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        {subLine($, e, line, { place, wave: run.wave.source })}
      </Box>
    )
  })

  // When Claude batches calls, the app folds them into one box, and a row
  // inside it starts further left. The box names its calls, so a command's
  // row there gets the grouped inset; a line already drawn is redrawn. The box
  // can draw before the command's tool.call hook runs, so its ids are kept
  // until it says the command ended.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    let isMoved = false
    for (const call of e.props.calls) {
      const id = call.tool_use_id
      if (id === undefined || call.tool !== 'Bash') continue
      if (!call.isRunning) {
        grouped.delete(id)
        continue
      }
      if (grouped.has(id)) continue
      grouped.add(id)
      void log($, `grouped ${id} surface=${e.surface} expanded=${e.props.isExpanded}`)
      if (lineOf(runs.get(id)) !== undefined) isMoved = true
    }
    if (isMoved) $.ui.invalidate('ui.render')
    return next(e)
  })
}
