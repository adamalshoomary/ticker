import { describe, expect, test } from 'claude-code/testing'

import { acceptReply, factsOf, feed, heldBack, mask, newTally, promptFor, rulesLine, skipTo, unbackedNumber } from '../hooks/lines'
import { goOutput, makeError, makeOutput, npmOutput, unittestEnd, unittestOutput } from './fixtures'

const read = (text: string) => {
  const t = newTally()
  feed(t, text, text.length)
  return t
}

describe('the rules line', () => {
  test('counts unittest results across the whole output and leads with the failure', () => {
    const t = read(unittestOutput(22))
    expect(factsOf(t)).toContain('Tests finished so far: 22 (21 passed, 1 failed)')
    expect(rulesLine(t, 'python3 -m unittest -v')).toBe('1 test failed so far (test_08_rotate_image); 22 done')
  })

  test('reads the closing summary of a unittest run', () => {
    const t = read(unittestOutput(36) + unittestEnd)
    expect(factsOf(t)).toContain('Tests in this run: 36')
    expect(rulesLine(t, 'python3 -m unittest -v')).toBe('Tests done: 2 failures (test_08_rotate_image, test_33_billing_tax), 34 passed')
  })

  test('gives the same counts when the output arrives cut mid-line', () => {
    const text = unittestOutput(30)
    const t = newTally()
    for (let at = 0; at < text.length; at += 37) feed(t, text.slice(at, at + 37), Math.min(text.length, at + 37))
    expect(factsOf(t)).toEqual(factsOf(read(text)))
  })

  test('counts compiled files and names the current one', () => {
    expect(rulesLine(read(makeOutput(19)), 'make 2>&1')).toBe('Compiling mod18.c, 19 files so far')
  })

  test('names a compiler error from its own line', () => {
    expect(rulesLine(read(makeError), 'make 2>&1')).toBe("Build error: mod08.c: invalid digit '8' in octal constant")
  })

  test('counts top-level Go tests and the one running now', () => {
    expect(rulesLine(read(goOutput), 'go test -v ./...')).toBe('1 test failed so far (TestRefunds); 9 done; now TestWebhooks')
  })

  test('counts each npm package once, though npm fetches it twice', () => {
    const t = read(npmOutput(['typescript', 'eslint', '@babel/core', 'jest']))
    expect(factsOf(t)).toContain('Packages fetched so far: 4')
    expect(rulesLine(t, 'npm install --loglevel http')).toBe('npm is downloading packages: 4 so far, latest jest')
  })

  test('says when a pipe holds the output back', () => {
    const command = 'go test -v -count=1 ./... 2>&1 | tail -25'
    expect(heldBack(command)).toBe('The command pipes into tail, so its output is held back until it ends.')
    expect(rulesLine(newTally(), command)).toBe('Nothing shown yet: it pipes into tail, so results show at the end')
    expect(heldBack('make 2>&1')).toBeUndefined()
    expect(heldBack('make > build.log')).toBe('The command writes its output to build.log, so little shows here.')
  })

  test('reads a progress bar redrawn with carriage returns', () => {
    const t = newTally()
    const text = 'Epoch 1/3\n 45%|████▌     | 450/1000 [00:10<00:12, 45.0it/s]\r 46%|████▌     | 460/1000 [00:10<00:12, 45.0it/s]'
    feed(t, text, text.length)
    expect(rulesLine(t, 'python3 train.py')).toBe('Step 460 of 1000 (46%)')
  })

  test('drops every count once output was skipped', () => {
    const t = newTally()
    skipTo(t, 5_000_000)
    feed(t, unittestOutput(30), 5_100_000)
    expect(factsOf(t).some(one => /\d+ \(/.test(one))).toBe(false)
    expect(rulesLine(t, 'python3 -m unittest -v')).toBe('Running tests')
  })

  test('shows the last line when no rule knows the tool', () => {
    expect(rulesLine(read('Fetching shard alpha\nFetching shard beta\n'), './sync.sh')).toBe('Last printed: Fetching shard beta')
    expect(rulesLine(newTally(), 'python3 train.py --epochs 3')).toBe('Nothing printed yet')
  })
})

describe('masking', () => {
  test('hides keys, tokens and passwords before anything reads a line', () => {
    expect(mask('export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('export ANTHROPIC_API_KEY=[hidden]')
    expect(mask('Authorization: Bearer abc.def-123456789')).toBe('Authorization: Bearer [hidden]')
    expect(mask('cloning with ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('cloning with [hidden]')
    expect(mask('remote: https://adam:hunter22@example.com/repo.git')).toBe('remote: https://[hidden]@example.com/repo.git')
    expect(mask('"password": "correct-horse"')).toBe('"password": "[hidden]"')
  })

  test('keeps ordinary lines whole', () => {
    const line = 'tests/test_api.py::test_this_is_a_really_long_descriptive_test_name PASSED [ 45%]'
    expect(mask(line)).toBe(line)
    expect(mask('npm http fetch GET 200 https://registry.npmjs.org/escalade 24ms')).toBe('npm http fetch GET 200 https://registry.npmjs.org/escalade 24ms')
  })

  test('masks secrets in the lines sent to the model', () => {
    const t = read('Using token=abcd1234efgh\nrunning step two\n')
    const { prompt } = promptFor({ command: './deploy.sh', tally: t, quietMs: 0 })
    expect(prompt.includes('abcd1234efgh')).toBe(false)
    expect(prompt.includes('token=[hidden]')).toBe(true)
  })
})

describe("the model's reply", () => {
  const t = read(unittestOutput(22))
  const { facts, sent } = promptFor({ command: 'python3 -m unittest -v', description: 'Run the 36 app tests', tally: t, quietMs: 0 })

  test('is taken as one clean line', () => {
    expect(acceptReply('"Running the app tests, 22 done, one failure so far."', facts, sent)).toEqual({ line: 'Running the app tests, 22 done, one failure so far' })
    expect(acceptReply('Let me count.\nRunning the app tests, 22 done', facts, sent)).toEqual({ line: 'Running the app tests, 22 done' })
  })

  test('is refused when it states a count the rules did not compute', () => {
    expect(acceptReply('Running the app tests, 22 of 36 done', facts, sent)).toEqual({ refused: 'number not in the facts: 36' })
    expect(acceptReply('Downloading about two dozen packages', facts, sent)).toEqual({ refused: 'number not in the facts: two' })
    expect(acceptReply('Several tests have failed', facts, sent)).toEqual({ refused: 'number not in the facts: several' })
  })

  test('is refused when empty or longer than the row', () => {
    expect(acceptReply('  \n ', facts, sent)).toEqual({ refused: 'empty' })
    expect('refused' in acceptReply('Running '.repeat(15), facts, sent)).toBe(true)
  })

  test('may name a numbered thing it was shown', () => {
    const build = read(makeOutput(19))
    const sentBuild = promptFor({ command: 'make', tally: build, quietMs: 0 })
    expect(unbackedNumber('Compiling the source files, now on module 18', sentBuild.facts, sentBuild.sent)).toBeUndefined()
    expect(unbackedNumber('Compiling mod18.c with python3', sentBuild.facts, `${sentBuild.sent}\npython3`)).toBeUndefined()
    expect(unbackedNumber('Compiling mod99.c', sentBuild.facts, sentBuild.sent)).toBe('mod99.c')
  })
})
