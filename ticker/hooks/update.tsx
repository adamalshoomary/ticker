import { atom, read, update } from 'claude-code'
import type { BoxProps, ElementConstructor, EngineInterface, On, RenderChildren, RenderNode } from 'claude-code'

import { arrowBusy, arrowIn, arrowStill, BAND_W, ICON_PX } from './icons'

// The update check, the same file in each of Adam's mods. Once a day at most,
// read the mod's plugin.json on GitHub's main branch, the file
// `claude plugin update` reads too: `<mod>/.claude-plugin/plugin.json` where
// the repository keeps the mod in a folder of its name, else the one at the
// top. Such a repository also keeps the version at the top, for copies made
// before the move, which read only there. When it names a newer version, a line
// above the prompt offers it: Update runs `claude plugin update`, and Not now
// hides that version until a newer one comes out. A pop-up says so once per
// version too, since the app hides the line while its next-step box is up. Nothing installs without
// the click. Offline, or with nonessential traffic turned off, nothing shows.

/** How long a check stands before the next one asks GitHub again. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
const OWNER = 'adamalshoomary'
/** How long the pop-up stays. It shows because the app hides the line above the prompt while its next-step box is up. */
const TOAST_MS = 15_000


/** The line's state. The engine reads the mod's name here, so this is the one line that differs between the mods. */
const view = atom({ plugin: 'ticker', key: 'update' } as const, null)

/** What the store keeps across sessions. */
type Kept = { checkedAt: number; latest: string; dismissed?: string; toasted?: string }

/** `[major, minor, patch]`, or undefined for a string that is no version. */
function parts(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match === null ? undefined : match.slice(1).map(Number)
}

/** True when `a` is a later version than `b`. */
export function isNewer(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  if (x === undefined || y === undefined) return false
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

function versionIn(text: string): string | undefined {
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version
    return typeof version === 'string' && parts(version) !== undefined ? version : undefined
  } catch {
    return undefined
  }
}

async function installedVersion($: EngineInterface): Promise<string | undefined> {
  const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => undefined)
  return typeof text === 'string' ? versionIn(text) : undefined
}

async function latestVersion($: EngineInterface, name: string): Promise<string | undefined> {
  const main = `https://raw.githubusercontent.com/${OWNER}/${name}/main`
  for (const path of [`${name}/.claude-plugin/plugin.json`, '.claude-plugin/plugin.json']) {
    const reply = await $.http.fetch(`${main}/${path}`).catch(() => undefined)
    if (reply === undefined) return undefined
    if (reply.ok) return versionIn(reply.text)
    if (reply.status !== 404) return undefined
  }
  return undefined
}

async function kept($: EngineInterface): Promise<Kept | undefined> {
  const value = (await $.store.get('update')) as Kept | undefined
  return typeof value?.latest === 'string' && typeof value.checkedAt === 'number' ? value : undefined
}

async function check($: EngineInterface) {
  if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return
  const name = $.plugin.name
  const current = await installedVersion($)
  if (current === undefined) return
  const now = await $.clock.now()
  let last = await kept($)
  if (last === undefined || now - last.checkedAt >= CHECK_EVERY_MS) {
    const latest = await latestVersion($, name)
    if (latest === undefined) return
    last = { ...last, checkedAt: now, latest }
    await $.store.set('update', last)
  }
  if (!isNewer(last.latest, current) || last.dismissed === last.latest) return
  await update($, view, () => ({ phase: 'offer' as const, current, latest: last.latest }))
  if (last.toasted !== last.latest) {
    $.ui.toast(`${last.latest} is out. Update it above the prompt.`, { timeoutMs: TOAST_MS })
    await $.store.set('update', { ...last, toasted: last.latest })
  }
}

async function install($: EngineInterface, latest: string) {
  const name = $.plugin.name
  await update($, view, () => ({ phase: 'updating' as const, latest }))
  const claude = (await $.env.get('CLAUDE_CODE_EXECPATH')) || 'claude'
  const by = `claude plugin update ${name}@${name}`
  let text = `Couldn't update. Run ${by} in a terminal.`
  let isWarning = true
  try {
    // `claude plugin update` skips fetching a marketplace it fetched a short while ago, so fetch it first.
    await $.process.run([claude, 'plugin', 'marketplace', 'update', name]).catch(() => undefined)
    const ran = await $.process.run([claude, 'plugin', 'update', `${name}@${name}`, '--json'])
    const line = ran.stdout.split('\n').find(one => one.trim().startsWith('{'))
    const result = line === undefined ? undefined : (JSON.parse(line) as { outcome?: string; newVersion?: string; message?: string })
    if (result?.outcome === 'ok') {
      text = `${name} ${result.newVersion ?? latest} is installed. Next chat uses it.`
      isWarning = false
    } else if (result?.message !== undefined) {
      text = `Couldn't update: ${result.message} Run ${by} in a terminal.`
    }
  } catch {
    // The text above stands: the command could not start or gave no answer.
  }
  await update($, view, () => ({ phase: 'done' as const, text, isWarning }))
}

async function dismiss($: EngineInterface, latest: string) {
  const last = await kept($)
  if (last !== undefined) await $.store.set('update', { ...last, dismissed: latest })
  await update($, view, () => null)
}

/**
 * True when a drawn tree shows nothing: empty boxes, blank text, and Claude
 * Code's own node, which draws nothing in the band above the prompt.
 */
function isBlank(node: RenderNode | RenderChildren): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') return true
  if (typeof node === 'string') return node.trim() === ''
  if (typeof node === 'number') return false
  if (Array.isArray(node)) return node.every(isBlank)
  const el = node as { type?: string; children?: RenderNode[] }
  if (el.type === 'engine') return true
  return (el.type === 'Box' || el.type === 'Text') && (el.children ?? []).every(isBlank)
}

/**
 * What is already in the band above the prompt, then this mod's rows under it,
 * one gap apart: the gap matches the band's own top padding, whichever mods drew.
 */
export function below(Box: ElementConstructor<BoxProps>, rest: RenderNode, rows: RenderChildren) {
  return (
    <Box flexDirection="column" gap="md">
      {isBlank(rest) ? null : rest}
      {rows}
    </Box>
  )
}

/** Starts the check as the session starts, without holding it up. Call it from the mod's one session.start hook. */
export function checkSoon($: EngineInterface) {
  $.clock.after(1, () => void check($).catch(() => undefined))
}

/** Adds the update line above the prompt to a mod: an icon, a few words, buttons. */
export function registerUpdate(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, view)
    if (shown === null || e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Svg = 'Svg' in els ? els.Svg : undefined
    const name = $.plugin.name
    const rest = await next(e)
    // The arrow draws in as the line shows, and rises while Update runs.
    const icon = shown.phase === 'offer' ? arrowIn : shown.phase === 'updating' ? arrowBusy : arrowStill
    let words
    if (shown.phase === 'offer') {
      words = [
        <Text>
          {name} {shown.latest} is out
        </Text>,
        <Button key="update-now" label="Update" variant="primary" onPress={() => install($, shown.latest)} />,
        <Button key="update-later" label="Later" onPress={() => dismiss($, shown.latest)} />,
      ]
    } else if (shown.phase === 'updating') {
      words = [<Text dimColor>Updating {name}...</Text>]
    } else {
      words = [
        <Text color={shown.isWarning ? 'yellow' : undefined} dimColor={!shown.isWarning}>
          {shown.text}
        </Text>,
        <Button key="update-ok" label="OK" onPress={() => update($, view, () => null)} />,
      ]
    }
    return below(
      Box,
      rest,
      <Box key="update" flexDirection="row" alignItems="center" gap="sm">
        {Svg && <Svg source={icon} alt={`${name} update`} width={BAND_W} height={ICON_PX} isInteractive />}
        {words}
      </Box>,
    )
  })
}
