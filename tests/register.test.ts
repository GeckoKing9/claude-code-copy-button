import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const REPLY = 'Run this:\n\n```bash\necho hi\n```\n\nDone.'

const message = (text: string) => ({
  surface: 'terminal' as const,
  component: 'AssistantMessage' as const,
  requestId: 'm1',
  props: { text, isFirstOfReply: true },
})

// The world beneath the mod: a store, Windows (or not), and the stock drawing.
const world = (on: On, windows: boolean) => {
  mock.store(on)
  const runs: string[] = []
  on('process.run', ($, e) => {
    runs.push(e.argv.join(' '))
    if (e.argv[0] === 'cmd.exe') return { value: windows ? { exitCode: 0, stdout: 'C:\\Users\\me\\AppData\\Local\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } : { exitCode: 127, stdout: '', stderr: 'cmd.exe: not found', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'wslpath') return { value: { exitCode: 0, stdout: '/mnt/c/Users/me/AppData/Local/claude-copy\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['STOCK'] }))
  return { runs }
}

const flat = (tree: unknown): string => JSON.stringify(tree)

test('on WSL a code block gets a copy link to its .ccopy file', async ($, on) => {
  world(on, true)
  const tree = await $.ui.render(message(REPLY))
  expect(flat(tree)).toContain('copy](file:///C:/Users/me/AppData/Local/claude-copy/sess-1/')
  expect(flat(tree)).toContain('.ccopy)')
  expect(flat(tree)).not.toContain('STOCK')
})

test('off WSL the stock reply is drawn and the failed lookup is not cached (asked again)', async ($, on) => {
  const w = world(on, false)
  expect(flat(await $.ui.render(message(REPLY)))).toContain('STOCK')
  expect(flat(await $.ui.render(message(REPLY)))).toContain('STOCK')
  expect(w.runs.filter(r => r.startsWith('cmd.exe')).length).toBe(2)
})

test('a reply with no code block is left alone', async ($, on) => {
  world(on, true)
  expect(flat(await $.ui.render(message('No code here.')))).toContain('STOCK')
})
