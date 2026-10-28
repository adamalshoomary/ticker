// The text work behind ticker, with no `$` in it: clean a running
// command's output, count what known tools report across the whole output,
// mask secrets, write the rules line, build the model's prompt and check its
// reply. The tests feed it saved output directly.

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, 'g')

/** Longest line shown in the spinner row or under the command's row. */
export const MAX_LINE = 90
/** Newest lines kept for the model and the rules. */
const KEEP_LATEST = 25
/** Failure lines kept for the model; the newest win. */
const KEEP_FAILURES = 20
/** Longest unfinished line kept between reads (a progress bar redrawn with \r). */
const MAX_CARRY = 8192

export const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/** One raw line as a person would see it: escape codes gone, a \r redraw kept as its last state. */
export function cleanLine(raw: string): string {
  const parts = raw
    .replace(ANSI, '')
    .split('\r')
    .filter(part => part.trim().length > 0)
  return (parts[parts.length - 1] ?? '').trimEnd()
}

// Secrets that a command may print while it runs. The newest lines go to the
// model several times a minute, so they are masked before anything reads them.
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----.*/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]
/** A long opaque run: mixed case with digits, or long hex. A snake_case test name is neither. */
const OPAQUE = /\b[A-Za-z0-9_+=-]{40,}/g
const isOpaque = (run: string) => (/\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) && !/[a-z]_[a-z]/.test(run)) || /^[0-9a-f]{40,}$/i.test(run)
const SECRET_ASSIGNED =
  /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credentials?|auth))(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi
const SECRET_HEADER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g
const SECRET_IN_URL = /(\/\/)[^\s/:@]+:[^\s/@]+@/g

export function mask(line: string): string {
  let out = line.replace(SECRET_ASSIGNED, '$1$2[hidden]').replace(SECRET_HEADER, '$1 [hidden]').replace(SECRET_IN_URL, '$1[hidden]@')
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[hidden]')
  return out.replace(OPAQUE, run => (isOpaque(run) ? '[hidden]' : run))
}

type Tests = {
  passed: number
  failed: number
  skipped: number
  /** How many tests the runner said the run holds. */
  total?: number
  current?: string
  failedNames: string[]
  /** Test files a jest-style runner reported, which are not tests. */
  files?: { passed: number; failed: number }
  /** The runner printed its closing summary. */
  isFinal: boolean
  pending?: string
}

type Build = {
  /** What is counted: `files` for a C compiler, `crates` for cargo, `tasks` for Gradle. */
  unit?: 'files' | 'crates' | 'tasks'
  compiled: number
  current?: string
  step?: [number, number]
  percent?: number
  errors: number
  firstError?: string
}

type Fetch = {
  tool?: 'npm' | 'pip'
  /** Each package name once: npm fetches a package's details and its archive. */
  names: Set<string>
  latest?: string
  /** The tool's own closing line, such as `added 386 packages in 50s`. */
  finished?: string
}

type Packages = { ok: number; failed: number; failedNames: string[] }

/** What the rules have read from one command's output so far. */
export type Tally = {
  /** Bytes of the output file read so far. */
  bytes: number
  /** Some output was skipped, so no count covers the whole output. */
  isPartial: boolean
  carry: string
  latest: string[]
  failures: string[]
  /** Which reader matched most recently, so the rules line follows the tool that is talking. */
  lastKind?: 'tests' | 'build' | 'fetch'
  tests?: Tests
  build?: Build
  fetch?: Fetch
  packages?: Packages
}

export function newTally(): Tally {
  return { bytes: 0, isPartial: false, carry: '', latest: [], failures: [] }
}

const tests = (t: Tally): Tests => (t.tests ??= { passed: 0, failed: 0, skipped: 0, failedNames: [], isFinal: false })
const build = (t: Tally): Build => (t.build ??= { compiled: 0, errors: 0 })
const fetch = (t: Tally): Fetch => (t.fetch ??= { names: new Set() })

function addName(names: string[], name: string) {
  if (!names.includes(name)) names.push(name)
}

function testResult(t: Tally, name: string, result: string) {
  const s = tests(t)
  const r = result.toLowerCase()
  if (r === 'ok' || r === 'passed' || r === 'pass' || r === 'unexpected success' || r === 'xpass') s.passed += 1
  else if (r === 'fail' || r === 'failed' || r === 'error') {
    s.failed += 1
    addName(s.failedNames, name)
  } else s.skipped += 1
  s.current = undefined
  s.pending = undefined
  t.lastKind = 'tests'
}

const FAILURE_WORD = /\b(error|errors|ERR!|fatal|failed|failure|failures|FAIL|panic|panicked|Traceback|exception|Abort(?:ed)?)\b|^\s*[✗✕×]/i
const FAILURE_TYPE = /[a-z](?:Error|Exception)\b/
const NOT_FAILURE =
  /\b0 (errors?|failures?|failed)\b|\b(errors?|failures?|failed)\s*[=:]\s*0\b|-Werror|\bno (errors?|failures?)\b|without errors?|error[_-]?handl|on_?error|\berrorlevel|\.error\(|^\s*(PASS|ok)\b/i

/** Reads one clean line into the tally. Each reader looks for its own tool's lines. */
export function readLine(t: Tally, line: string) {
  let m: RegExpMatchArray | null

  // Python unittest -v, and the result of a slow test on the next line.
  if ((m = line.match(/^(\w+) \([\w.]+\)(?: \.\.\. ?(.*))?$/))) {
    const result = m[2]?.trim()
    if (result && /^(ok|FAIL|ERROR|skipped\b.*|expected failure|unexpected success)$/.test(result)) testResult(t, m[1] ?? 'a test', result.split(' ')[0] ?? 'skipped')
    else if (m[2] !== undefined) {
      tests(t).current = m[1]
      tests(t).pending = m[1]
      t.lastKind = 'tests'
    }
  } else if (t.tests?.pending && (m = line.match(/^(ok|FAIL|ERROR|skipped\b.*)$/))) {
    testResult(t, t.tests.pending, (m[1] ?? 'skipped').split(' ')[0] ?? 'skipped')
  } else if ((m = line.match(/^Ran (\d+) tests? in /))) {
    const s = tests(t)
    s.total = Number(m[1])
    s.isFinal = true
    t.lastKind = 'tests'
  } else if ((m = line.match(/^(?:FAIL|ERROR): (\w+) \(/))) {
    addName(tests(t).failedNames, m[1] ?? 'a test')
  }

  // pytest: the header count, verbose rows, progress rows of dots, the closing summary.
  else if ((m = line.match(/^collected (\d+) items?/))) {
    tests(t).total = Number(m[1])
    t.lastKind = 'tests'
  } else if ((m = line.match(/^(\S+?)::(\S+) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/))) {
    testResult(t, m[2] ?? 'a test', m[3] === 'XFAIL' ? 'skipped' : (m[3] ?? 'skipped'))
  } else if ((m = line.match(/^(\S+\.py) ([.FEsxX]+)\s*\[\s*\d+%\]$/))) {
    const s = tests(t)
    for (const ch of m[2] ?? '') {
      if (ch === '.' || ch === 'X') s.passed += 1
      else if (ch === 'F' || ch === 'E') {
        s.failed += 1
        addName(s.failedNames, m[1] ?? 'a test file')
      } else s.skipped += 1
    }
    s.current = m[1]
    t.lastKind = 'tests'
  } else if ((m = line.match(/^FAILED (\S+?)::(\S+)/))) {
    addName(tests(t).failedNames, m[2] ?? 'a test')
  } else if ((m = line.match(/^=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s/))) {
    const s = tests(t)
    const count = (word: string) => Number((m?.[1] ?? '').match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0)
    s.passed = count('passed')
    s.failed = count('failed') + count('errors?')
    s.skipped = count('skipped')
    s.isFinal = true
    t.lastKind = 'tests'
  }

  // Go: top-level tests only, then each package's line.
  else if ((m = line.match(/^=== RUN\s+([^\s/]+)$/))) {
    tests(t).current = m[1]
    t.lastKind = 'tests'
  } else if ((m = line.match(/^--- (PASS|FAIL|SKIP): (\S+)/))) {
    testResult(t, m[2] ?? 'a test', m[1] ?? 'SKIP')
  } else if ((m = line.match(/^ok\s+(\S+)\s+[\d.]+s/))) {
    ;(t.packages ??= { ok: 0, failed: 0, failedNames: [] }).ok += 1
    t.lastKind = 'tests'
  } else if ((m = line.match(/^FAIL\s+(\S+)\s+[\d.]+s/))) {
    const p = (t.packages ??= { ok: 0, failed: 0, failedNames: [] })
    p.failed += 1
    addName(p.failedNames, m[1] ?? 'a package')
    t.lastKind = 'tests'
  }

  // cargo test and jest-style summaries.
  else if ((m = line.match(/^test (\S+) \.\.\. (ok|FAILED|ignored)$/))) {
    testResult(t, m[1] ?? 'a test', m[2] === 'ignored' ? 'skipped' : (m[2] ?? 'skipped'))
  } else if ((m = line.match(/^Tests:\s+(.*\d+ total)/))) {
    const s = tests(t)
    const count = (word: string) => Number((m?.[1] ?? '').match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0)
    s.passed = count('passed')
    s.failed = count('failed')
    s.skipped = count('skipped') + count('todo')
    s.total = count('total')
    s.isFinal = true
    t.lastKind = 'tests'
  } else if ((m = line.match(/^(PASS|FAIL)\s+(\S+\.(?:test|spec)\.[jt]sx?)\b/))) {
    const s = tests(t)
    const files = (s.files ??= { passed: 0, failed: 0 })
    if (m[1] === 'FAIL') {
      files.failed += 1
      addName(s.failedNames, (m[2] ?? 'a test file').split('/').pop() ?? 'a test file')
    } else files.passed += 1
    t.lastKind = 'tests'
  }

  // Builds: C compilers, ninja, cmake, cargo, Gradle, make's own error line.
  else if ((m = line.match(/^(\S*\/)?(cc|gcc|clang|g\+\+|c\+\+|clang\+\+)\s.*\s-c\s.*?(\S+\.(?:c|cc|cpp|cxx|m|mm))\b/))) {
    const b = build(t)
    b.unit = 'files'
    b.compiled += 1
    b.current = (m[3] ?? '').split('/').pop()
    t.lastKind = 'build'
  } else if ((m = line.match(/^\[\s*(\d+)\/(\d+)\]\s+(.*)$/))) {
    const b = build(t)
    b.step = [Number(m[1]), Number(m[2])]
    const file = (m[3] ?? '').match(/(\S+\.\w+)\s*$/)?.[1]
    if (file) b.current = file.split('/').pop()
    t.lastKind = 'build'
  } else if ((m = line.match(/^\[\s*(\d+)%\]\s+(?:Building|Linking|Built)\b(.*)$/))) {
    const b = build(t)
    b.percent = Number(m[1])
    const file = (m[2] ?? '').match(/(\S+\.\w+)\s*$/)?.[1]
    if (file) b.current = file.split('/').pop()
    t.lastKind = 'build'
  } else if ((m = line.match(/^\s*Compiling (\S+) v\S+/))) {
    const b = build(t)
    b.unit = 'crates'
    b.compiled += 1
    b.current = m[1]
    t.lastKind = 'build'
  } else if ((m = line.match(/^> Task (\S+)/))) {
    const b = build(t)
    b.unit = 'tasks'
    b.compiled += 1
    b.current = m[1]
    t.lastKind = 'build'
  } else if ((m = line.match(/^(\S+\.\w+):\d+(?::\d+)?: (?:fatal )?error: (.*)$/) ?? line.match(/^(\S+\.\w+)\(\d+,\d+\): error (TS\d+: .*)$/))) {
    const b = build(t)
    b.errors += 1
    b.firstError ??= `${(m[1] ?? '').split('/').pop()}: ${m[2]}`
    t.lastKind = 'build'
  } else if (/^(g?make)(\[\d+\])?: \*\*\*/.test(line)) {
    const b = build(t)
    if (b.errors === 0) b.errors = 1
    b.firstError ??= line
    t.lastKind = 'build'
  }

  // Package downloads.
  else if ((m = line.match(/^npm (?:http|info) fetch GET \d+ https?:\/\/\S*?registry[^/\s]*\/((?:@[^/\s]+(?:%2f|\/))?[^/\s]+)/i))) {
    const f = fetch(t)
    f.tool = 'npm'
    f.latest = decodeURIComponent(m[1] ?? '')
    f.names.add(f.latest)
    t.lastKind = 'fetch'
  } else if ((m = line.match(/^(added|removed|changed) \d+ packages?.*|^up to date.*/))) {
    fetch(t).finished = line
    fetch(t).tool ??= 'npm'
    t.lastKind = 'fetch'
  } else if ((m = line.match(/^Collecting (\S+)/))) {
    const f = fetch(t)
    f.tool = 'pip'
    f.latest = (m[1] ?? '').split(/[<>=!~[;]/)[0] ?? ''
    f.names.add(f.latest.toLowerCase())
    t.lastKind = 'fetch'
  } else if ((m = line.match(/^Successfully installed (.+)$/))) {
    const f = fetch(t)
    f.tool = 'pip'
    f.finished = `installed ${(m[1] ?? '').trim().split(/\s+/).length} packages`
    t.lastKind = 'fetch'
  }

  if ((FAILURE_WORD.test(line) || FAILURE_TYPE.test(line)) && !NOT_FAILURE.test(line)) {
    const kept = cut(line, 200)
    if (!t.failures.includes(kept)) t.failures.push(kept)
    if (t.failures.length > KEEP_FAILURES) t.failures.shift()
  }
}

/**
 * Feeds the bytes read since the last call. `bytes` is where the file now
 * stands. A line is counted once it has ended; the unfinished one is kept,
 * at its last \r state, for the newest-line view.
 */
export function feed(t: Tally, text: string, bytes: number) {
  const parts = (t.carry + text).split('\n')
  const rest = parts.pop() ?? ''
  const redraw = rest.lastIndexOf('\r', rest.length - 2)
  t.carry = (redraw > 0 ? rest.slice(redraw) : rest).slice(-MAX_CARRY)
  for (const raw of parts) {
    const line = mask(cleanLine(raw))
    if (!/[A-Za-z0-9]/.test(line)) continue
    readLine(t, line)
    t.latest.push(cut(line, 200))
    if (t.latest.length > KEEP_LATEST) t.latest.shift()
  }
  t.bytes = bytes
}

/** Marks a jump past output that was never read: the counts no longer cover it. */
export function skipTo(t: Tally, bytes: number) {
  t.isPartial = true
  t.carry = ''
  t.bytes = bytes
}

/** The newest lines, the unfinished one last. */
export function newestLines(t: Tally): string[] {
  const open = mask(cleanLine(t.carry))
  return /[A-Za-z0-9]/.test(open) ? [...t.latest, cut(open, 200)].slice(-KEEP_LATEST) : t.latest
}

/** Progress that the newest line states itself: a percent or a step of a total. */
export function progressOf(line: string | undefined): { percent?: number; step?: [number, number] } {
  if (line === undefined) return {}
  const percent = line.match(/(?:^|[^\d.])(\d{1,3}(?:\.\d+)?)\s?%/)?.[1]
  const step =
    line.match(/\[\s*(\d+)\s*\/\s*(\d+)\s*\]/) ??
    line.match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/) ??
    line.match(/\b(?:step|stage|batch|epoch|item|file|page|chunk|part|task|test|row|record)s?\s*(\d+)\s*(?:\/|of)\s*(\d+)\b/i) ??
    line.match(/\b(\d+)\s+of\s+(\d+)\b/) ??
    line.match(/\b(\d+)\/(\d+)\s+\[/)
  const out: { percent?: number; step?: [number, number] } = {}
  if (percent !== undefined && Number(percent) <= 100) out.percent = Math.round(Number(percent))
  if (step) {
    const [x, y] = [Number(step[1]), Number(step[2])]
    if (y > 1 && x <= y) out.step = [x, y]
  }
  return out
}

/** What the command's own text says about where its output goes. */
/** A pipe into a tool that prints only once its input ends. */
const PIPED = /\|\s*(tail|head|sort|uniq|wc|less|more|jq|column|grep|awk|sed|xargs)\b/

export function heldBack(command: string): string | undefined {
  const pipe = command.match(PIPED)
  if (pipe) return `The command pipes into ${pipe[1]}, so its output is held back until it ends.`
  const redirect = command.match(/(?:^|[^0-9&<>])(?:&>|1?>>?)\s*([^\s;&|]+)/)
  if (redirect && redirect[1] !== '/dev/null' && !/^&\d$/.test(redirect[1] ?? '')) return `The command writes its output to ${redirect[1]}, so little shows here.`
  return undefined
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (list: readonly string[], max = 2) => (list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and others`)

/**
 * The facts the rules computed, one per line, for the model and the guard.
 * Every number the line may state comes from here.
 */
export function factsOf(t: Tally): string[] {
  const facts: string[] = []
  const counts = !t.isPartial
  if (t.isPartial) facts.push('Part of the output was skipped, so nothing here is a full count.')
  const s = t.tests
  if (s) {
    const done = s.passed + s.failed + s.skipped
    if (counts && done > 0) facts.push(`Tests finished so far: ${done} (${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ''})`)
    if (counts && s.total !== undefined) facts.push(`Tests in this run: ${s.total}`)
    if (counts && s.files) facts.push(`Test files finished so far: ${s.files.passed + s.files.failed} (${s.files.failed} failed)`)
    if (s.failedNames.length > 0) facts.push(`Failed: ${names(s.failedNames, 4)}`)
    if (s.current) facts.push(`Running now: ${s.current}`)
    if (s.isFinal) facts.push('The test runner has printed its closing summary.')
  }
  const p = t.packages
  if (p && counts) facts.push(`Packages tested: ${p.ok + p.failed} (${p.failed} failed${p.failedNames.length ? `: ${names(p.failedNames)}` : ''})`)
  const b = t.build
  if (b) {
    if (counts && b.unit && b.compiled > 0) facts.push(`${b.unit === 'files' ? 'Files compiled' : b.unit === 'crates' ? 'Crates compiled' : 'Tasks run'} so far: ${b.compiled}`)
    if (b.step) facts.push(`Build step: ${b.step[0]} of ${b.step[1]}`)
    if (b.percent !== undefined) facts.push(`Build progress: ${b.percent}%`)
    if (b.current) facts.push(`Working on: ${b.current}`)
    if (counts && b.errors > 0) facts.push(`Build errors so far: ${b.errors}`)
    if (b.firstError) facts.push(`First build error: ${b.firstError}`)
  }
  const f = t.fetch
  if (f) {
    if (counts && f.names.size > 0) facts.push(`Packages ${f.tool === 'pip' ? 'collected' : 'fetched'} so far: ${f.names.size}`)
    if (f.latest) facts.push(`Latest package: ${f.latest}`)
    if (f.finished) facts.push(`${f.tool ?? 'The installer'} says: ${f.finished}`)
  }
  const now = progressOf(newestLines(t).at(-1))
  if (now.percent !== undefined) facts.push(`The newest line shows ${now.percent}%`)
  if (now.step) facts.push(`The newest line shows ${now.step[0]} of ${now.step[1]}`)
  return facts
}

function testsLine(t: Tally, s: Tests): string {
  const done = s.passed + s.failed + s.skipped
  const of = s.total !== undefined ? ` of ${s.total}` : ''
  const failed = s.failedNames.length > 0 ? ` (${names(s.failedNames)})` : ''
  if (t.isPartial) return s.current ? `Running tests, now ${s.current}` : 'Running tests'
  if (done === 0 && s.files && !s.isFinal) {
    const filesDone = s.files.passed + s.files.failed
    return s.files.failed > 0
      ? `${plural(s.files.failed, 'test file')} failed so far${failed}; ${filesDone} files done`
      : `Running tests: ${plural(filesDone, 'test file')} done, none failed so far`
  }
  if (s.isFinal) return s.failed > 0 ? `Tests done: ${plural(s.failed, 'failure')}${failed}, ${s.passed} passed` : `Tests done: ${s.passed} passed, none failed`
  const now = s.current ? `; now ${s.current}` : ''
  if (s.failed > 0) return `${plural(s.failed, 'test')} failed so far${failed}; ${done}${of} done${now}`
  return done > 0 ? `Running tests: ${done}${of} done, none failed so far${now}` : `Running tests${s.current ? `, now ${s.current}` : ''}`
}

function buildLine(t: Tally, b: Build): string {
  if (b.firstError) return `Build error: ${b.firstError}`
  const unit = b.unit === 'crates' ? 'crate' : b.unit === 'tasks' ? 'task' : 'file'
  const verb = b.unit === 'tasks' ? 'Running' : 'Compiling'
  if (b.step) return `Building: step ${b.step[0]} of ${b.step[1]}${b.current ? `, ${b.current}` : ''}`
  if (b.percent !== undefined) return `Building: ${b.percent}% done${b.current ? `, ${b.current}` : ''}`
  if (t.isPartial || b.compiled === 0) return `${verb} ${b.current ?? 'the project'}`
  return `${verb} ${b.current ?? `${unit}s`}, ${plural(b.compiled, unit)} so far`
}

function fetchLine(t: Tally, f: Fetch): string {
  const tool = f.tool ?? 'The installer'
  if (f.finished) return `${tool} finished: ${f.finished}`
  if (t.isPartial || f.names.size === 0) return `${tool} is downloading packages${f.latest ? `, latest ${f.latest}` : ''}`
  return `${tool} is downloading packages: ${f.names.size} so far${f.latest ? `, latest ${f.latest}` : ''}`
}

/** The line the rules write with no model: counts only where they cover the whole output. */
export function rulesLine(t: Tally, command: string): string {
  const failure = t.failures.at(-1)
  const kind = t.lastKind
  const line =
    kind === 'tests' && t.tests
      ? testsLine(t, t.tests)
      : kind === 'tests' && t.packages
        ? `Go packages: ${t.packages.ok + t.packages.failed} tested, ${t.packages.failed} failed`
        : kind === 'build' && t.build
          ? buildLine(t, t.build)
          : kind === 'fetch' && t.fetch
            ? fetchLine(t, t.fetch)
            : undefined
  if (line) return cut(line, MAX_LINE)
  const newest = newestLines(t)
  const now = progressOf(newest.at(-1))
  if (now.step) return cut(`Step ${now.step[0]} of ${now.step[1]}${now.percent !== undefined ? ` (${now.percent}%)` : ''}`, MAX_LINE)
  if (now.percent !== undefined) return `${now.percent}% done`
  if (failure) return cut(`Error seen: ${failure.trim()}`, MAX_LINE)
  const last = newest.at(-1)
  if (last) return cut(`Last printed: ${last.trim()}`, MAX_LINE)
  const held = heldBack(command)
  if (held?.includes('pipes')) return cut(`Nothing shown yet: it pipes into ${command.match(PIPED)?.[1] ?? 'another command'}, so results show at the end`, MAX_LINE)
  if (held) return 'Nothing shown yet: it writes to a file'
  return 'Nothing printed yet'
}

export const SYSTEM = [
  'You write the one status line a person sees in Claude Code while a long shell command runs.',
  'Speak as Claude, in plain words, to someone who may not read code.',
  'Rules:',
  '- One line, at most 12 words, present tense, no ending full stop.',
  '- Say what is happening now. Say how far along only with numbers listed under Facts.',
  '- Write no number that is not under Facts. Do not estimate, round or total counts. Numbers in Claude\'s description are guesses: leave them out.',
  '- Name things in plain words: "the billing tax test", not test_33_billing_tax. Short file names are fine.',
  '- If the facts or the lines show an error or a failure, lead with it.',
  '- Do not mention time, durations, line counts or the word output. The time is shown beside your line.',
  '- If a note says the output is held back, say what the command is doing and that results show at the end.',
  '- Never claim success, or guess at progress or causes, beyond what the facts and lines show.',
  'Reply with the line only.',
].join('\n')

export type Ask = {
  command: string
  description?: string
  tally: Tally
  quietMs: number
  previous?: string
}

/** The model's prompt, and the texts the reply's numbers and names are checked against. */
export function promptFor(ask: Ask): { prompt: string; facts: string; sent: string } {
  const t = ask.tally
  const facts = factsOf(t)
  const lines = newestLines(t)
  const held = heldBack(ask.command)
  const failures = t.failures.filter(one => !lines.includes(one)).slice(-8)
  const prompt = [
    `Command: ${mask(cut(ask.command, 300))}`,
    ask.description ? `Claude described it as: ${mask(cut(ask.description, 200))}` : undefined,
    facts.length > 0 ? `Facts counted from the whole output so far:\n${facts.map(one => `- ${one}`).join('\n')}` : 'Facts: none counted.',
    held ? `Note: ${held}` : undefined,
    ask.quietMs > 20000 ? `Note: nothing new has been printed for ${Math.round(ask.quietMs / 1000)} seconds.` : undefined,
    failures.length > 0 ? `Earlier error and failure lines:\n${failures.join('\n')}` : undefined,
    lines.length > 0 ? `Newest lines, last at the bottom:\n${lines.join('\n')}` : 'Nothing has been printed yet.',
    ask.previous ? `Your previous line: ${ask.previous}` : undefined,
  ]
    .filter(part => part !== undefined)
    .join('\n')
  return { prompt, facts: facts.join('\n'), sent: [ask.command, ask.description ?? '', ...lines, ...failures].join('\n') }
}

const NUMBER_WORDS: Readonly<Record<string, number | undefined>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
  dozen: 12, dozens: undefined, hundreds: undefined, thousands: undefined, half: undefined,
  couple: undefined, several: undefined, few: undefined,
}

const value = (token: string) => String(Number(token.replace(/[,%]/g, '')))

/**
 * The first number or count word in the reply that the facts do not hold,
 * else undefined. A number inside a name (`mod18`, `python3`) passes when the
 * name was in what the model was sent.
 */
export function unbackedNumber(reply: string, facts: string, sent: string): string | undefined {
  const allowed = new Set((facts.match(/\d+(?:\.\d+)?/g) ?? []).map(value))
  const seen = `${facts}\n${sent}`.toLowerCase()
  for (const m of reply.matchAll(/[A-Za-z_]*\d[\d,.]*%?[A-Za-z_]*/g)) {
    const token = m[0].replace(/[.,]+$/, '')
    if (/[A-Za-z_]/.test(token)) {
      if (!seen.includes(token.toLowerCase())) return token
      continue
    }
    if (allowed.has(value(token))) continue
    if (/\d\.\d/.test(token) && sent.includes(token)) continue
    return token
  }
  for (const m of reply.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    if (!(m[0] in NUMBER_WORDS)) continue
    const n = NUMBER_WORDS[m[0]]
    if (n === undefined || !allowed.has(String(n))) return m[0]
  }
  return undefined
}

/** The reply as a line to show, or why it is refused. */
export function acceptReply(text: string, facts: string, sent: string): { line: string } | { refused: string } {
  const last = text
    .split('\n')
    .map(one => one.trim())
    .filter(Boolean)
    .at(-1)
  if (last === undefined) return { refused: 'empty' }
  const line = last
    .replace(/^(?:[-*•]\s+|line:\s*|status:\s*)/i, '')
    .replace(/^["'`“‘]+|["'`”’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim()
  if (line.length === 0) return { refused: 'empty' }
  if (line.length > MAX_LINE) return { refused: `too long (${line.length})` }
  const number = unbackedNumber(line, facts, sent)
  if (number !== undefined) return { refused: `number not in the facts: ${number}` }
  return { line: mask(line) }
}
