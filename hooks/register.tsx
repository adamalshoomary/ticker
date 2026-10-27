import type { EngineInterface, Register } from 'claude-code'

import { acceptReply, feed, newTally, promptFor, rulesLine, skipTo, SYSTEM, type Tally } from './lines'
import { sized, tape } from './icons'
import { below, checkSoon, registerUpdate } from './update'

// ticker: while a Bash command runs in the main chat or a subagent,
// read the output file Claude Code writes for it, count what known tools
// report, and show one plain-words line under the command's row. The
// spinner keeps Claude Code's own words. A subagent's command, whose row the
// main chat does not show, has its line in the band above the prompt.
// Haiku writes the sentence from the counted facts; the rules line stands in
// until it answers, and whenever it cannot.

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
/** How long a new line has to be drawn somewhere before Haiku is asked for it. */
const SEEN_WAIT_MS = 500
/** New output read in one poll at most; past it the counts are dropped as partial. */
const READ_MAX = 1 << 20
const READ_TAIL = 64 * 1024
/** A path to log each step to while developing; empty in a release. */
const DEV_LOG: string = ''

type Run = {
  id: string
  agentId?: string
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
}

const runs = new Map<string, Run>()
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
// command when a subagent's command starts beside the main chat's.
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

async function poll($: EngineInterface, run: Run, useModel: boolean) {
  if (run.isPolling) return
  run.isPolling = true
  try {
    const now = await $.clock.now()
    const dir = await findTasksDir($)
    if (dir !== undefined && run.file === undefined) await claimFile($, run, dir)
    if (dir !== undefined && run.file !== undefined) await readNew($, run, `${dir}/${run.file}`, now)
    const watched = await isWatched($, run)
    const elapsed = now - run.startedAt
    if (elapsed < SHOW_AFTER_MS - 1_000) return
    const rules = rulesLine(run.tally, run.command)
    const isNew = run.rules === undefined
    run.rules = rules
    await log($, `poll ${run.id} t=${Math.round(elapsed / 1000)}s file=${run.file ?? '-'} bytes=${run.tally.bytes} rules=${JSON.stringify(rules)}`)
    if (isNew || run.sentence === undefined) $.ui.invalidate('ui.render')
    if (!useModel || !watched || run.isAsking || run.asks >= MAX_ASKS) return
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

/** How far the tape sits in from the row's left edge, in CSS pixels: under the first letter of the row's text. */
const TAPE_INSET_PX = 28

/** The tape drawn `inset` pixels in from its own left edge, so it lines up under the row's text. */
function insetTape(px: number, inset: number) {
  const units = (inset * 24) / px
  return sized(tape, px)
    .replace(`width="${px}"`, `width="${px + inset}"`)
    .replace('viewBox="0 0 24 24"', `viewBox="${-units} 0 ${24 + units} 24"`)
}

/** The line under a row: the tape starts under the row text's first letter, the words follow it. */
function subLine($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], text: string, key?: string) {
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Svg = 'Svg' in els ? els.Svg : undefined
  return (
    <Box key={key} flexDirection="row" alignItems="center" gap={2} paddingLeft={1}>
      {Svg && <Svg source={insetTape(20, TAPE_INSET_PX)} alt="ticker" width={20 + TAPE_INSET_PX} height={20} isInteractive />}
      <Text size="footnote" dimColor>
        {text}
      </Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const useModel = options.summaries !== 'rules'
  registerUpdate(on)

  on('session.start', ($, e, next) => {
    checkSoon($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background === true) return next(e)
    const dir = await findTasksDir($)
    const startedAt = await $.clock.now()
    const run: Run = {
      id: e.tool_use_id,
      agentId: e.agentId,
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
    }
    runs.set(run.id, run)
    await log($, `start ${run.id} agent=${run.agentId ?? 'main'} model=${useModel} cmd=${JSON.stringify(run.command.slice(0, 120))}`)
    const timer = $.clock.every(POLL_MS, () => {
      void poll($, run, useModel)
    })
    try {
      return await next(e)
    } finally {
      timer.cancel()
      runs.delete(run.id)
      await log($, `end ${run.id} after ${Math.round(((await $.clock.now()) - startedAt) / 1000)}s asks=${run.asks}`)
      if (run.rules !== undefined) $.ui.invalidate('ui.render')
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash' || !e.props.isRunning) return next(e)
    const run = runs.get(e.props.tool_use_id)
    const line = lineOf(run)
    if (run === undefined || line === undefined) return next(e)
    run.isSeen = true
    void noteDrawn($, 'ToolUse', e.surface, line)
    const { Box } = $.ui.resolve(e)
    const row = await next(e)
    return (
      <Box flexDirection="column">
        {row}
        {subLine($, e, line)}
      </Box>
    )
  })

  // The band holds each subagent's line: the main chat shows no row for it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = [...runs.values()].filter(one => one.agentId !== undefined && lineOf(one) !== undefined)
    if (shown.length === 0) return next(e)
    const { Box } = $.ui.resolve(e)
    const rest = await next(e)
    for (const one of shown) {
      one.isSeen = true
      void noteDrawn($, 'AbovePrompt', e.surface, lineOf(one) ?? '')
    }
    return below(
      Box,
      rest,
      shown.map(one => subLine($, e, `Subagent: ${lineOf(one) ?? ''}`, one.id)),
    )
  })
}
