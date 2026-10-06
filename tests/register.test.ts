import { test, expect, mock } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const LOCAL = 'C:\\Users\\Jöhn Smith (x)\\AppData\\Local'
const DIR = '/mnt/c/Users/Jöhn Smith (x)/AppData/Local/claude-copy'
const URL = 'file:///C:/Users/Jöhn%20Smith%20%28x%29/AppData/Local/claude-copy/sess-1/'
const REPLY = 'First line.\n\n```bash\necho hi\n```\n\nLast line.'
const CLASSES = 'HKCU\\Software\\Classes'

type Opts = { wsl?: boolean; registry?: 'missing' | 'current'; replies?: string[]; failRegAdd?: boolean; failWrite?: (path: string) => boolean }

const result = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: exitCode ? 'failed' : '', isStdoutTruncated: false, isStderrTruncated: false } })

// The world beneath the mod: WSL or not, Windows, a file system in memory, the
// registry, and the engine's stock drawing (which echoes what it was asked).
const world = (on: On, { wsl = true, registry = 'missing', replies = [], failRegAdd = false, failWrite = () => false }: Opts = {}) => {
  mock.store(on)
  mock.env(on, wsl ? { WSL_DISTRO_NAME: 'Ubuntu' } : {})
  const runs: string[][] = []
  const files = new Map<string, string>()
  const reg = new Map<string, string>()
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv[0] === 'cmd.exe') return result(0, `${LOCAL}\r\nC:\\WINDOWS\r\n`)
    if (argv[0] === 'wslpath') return result(0, `${DIR}\n`)
    if (argv[0] === 'reg.exe') {
      const name = `${argv[2]}|${argv[3] === '/v' ? argv[4] : ''}`
      if (argv[1] === 'query') return reg.has(name) ? result(0, `    ${argv[4] ?? '(Default)'}    REG_SZ    ${reg.get(name)}\r\n`) : result(1)
      if (failRegAdd) return result(1)
      reg.set(name, argv[argv.indexOf('/d') + 1] ?? '')
      return result(0)
    }
    return result(0)
  })
  on('fs.read', ($, e) => (e.path.endsWith('/windows/copy.vbs') ? { value: 'VBS' } : files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => {
    if (failWrite(e.path)) return { deny: 'EBUSY' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.list', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.messages', () => ({ value: replies.map(text => ({ role: 'assistant' as const, text, toolUses: [] })) }))
  on('ui.invalidate', () => ({ value: undefined }))
  const asked: { text: string; isFirstOfReply: boolean }[] = []
  on('ui.render', ($, e) => {
    const p = e.props as { text?: string; isFirstOfReply?: boolean }
    asked.push({ text: p.text ?? '', isFirstOfReply: p.isFirstOfReply ?? false })
    return { type: 'Text', props: {}, children: [`STOCK:${p.text ?? ''}`] }
  })
  const adds = () => runs.filter(r => r[0] === 'reg.exe' && r[1] === 'add')
  const saved = () => [...files.entries()].filter(([p]) => p.endsWith('.ccopy'))
  return { runs, files, reg, asked, adds, saved }
}

const message = (text: string, extra: Record<string, unknown> = {}, surface: 'terminal' | 'desktop' = 'terminal') => ({
  surface,
  component: 'AssistantMessage' as const,
  requestId: 'm1',
  props: { text, isFirstOfReply: true, ...extra },
})

const flat = (tree: unknown): string => JSON.stringify(tree)
const stock = (text: string) => flat({ type: 'Text', props: {}, children: [`STOCK:${text}`] })
const settle = async () => {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}
const started = async ($: { session: { start: (e: SessionStartInput) => Promise<unknown> } }) => {
  await $.session.start(session)
  await settle()
}

test('before the Windows folder is known, the reply is the engine\'s and drawing runs nothing', async ($, on) => {
  const w = world(on)
  expect(flat(await $.ui.render(message(REPLY)))).toBe(stock(REPLY))
  expect(w.runs).toEqual([])
})

test('the engine draws the prose, the code gets a box with a file: link', async ($, on) => {
  const w = world(on)
  await started($)
  const tree = flat(await $.ui.render(message(REPLY)))
  // Spaces and parentheses escaped, the ö literal (Windows reads %XX as ANSI).
  expect(tree).toContain(`(${URL}`)
  expect(w.asked).toEqual([
    { text: 'First line.', isFirstOfReply: true },
    { text: 'Last line.', isFirstOfReply: false },
  ])
})

test('off WSL the reply is the engine\'s and nothing is ever run', async ($, on) => {
  const w = world(on, { wsl: false, replies: [REPLY] })
  await started($)
  expect(flat(await $.ui.render(message(REPLY)))).toBe(stock(REPLY))
  expect(w.runs).toEqual([])
  expect(w.files.size).toBe(0)
})

test('no code, an empty block, a summary row, fullscreen and the desktop are left to the engine', async ($, on) => {
  world(on)
  await started($)
  expect(flat(await $.ui.render(message('No code here.')))).toBe(stock('No code here.'))
  expect(flat(await $.ui.render(message('Look:\n\n```\n   \n```')))).toBe(stock('Look:\n\n```\n   \n```'))
  expect(flat(await $.ui.render(message(REPLY, { isSummary: true })))).toBe(stock(REPLY))
  expect(flat(await $.ui.render({ ...message(REPLY), viewport: { columns: 120, rows: 40, isFullscreen: true } }))).toBe(stock(REPLY))
  expect(flat(await $.ui.render(message(REPLY, {}, 'desktop')))).toBe(stock(REPLY))
})

test('the saved file and the drawn link agree on CRLF text; tabs dedent by columns', async ($, on) => {
  const text = 'Steps:\r\n  ```make\r\n\tgcc a.c\r\n  \tx\r\n  ```\r\n'
  const w = world(on, { replies: [text] })
  await started($)
  const tree = flat(await $.ui.render(message(text)))
  const [[path = '', body = ''] = []] = w.saved()
  expect(tree).toContain(path.slice(path.lastIndexOf('/') + 1))
  // The fence sits at 2 columns: a leading tab (4 columns) keeps 2 as spaces.
  expect(body).toBe('  gcc a.c\r\n\tx')
})

test('a closing fence indented past the opening one by 4+ columns is content', async ($, on) => {
  const text = 'Example:\n\n````md\n```js\nx\n    ````\n````'
  const w = world(on, { replies: [text] })
  await started($)
  expect(w.saved().map(([, b]) => b)).toEqual(['```js\r\nx\r\n    ````'])
})

test('a missing file type is registered with its signature', async ($, on) => {
  const w = world(on)
  await started($)
  expect(w.reg.get(`${CLASSES}\\.ccopy|`)).toBe('ClaudeCopy')
  expect(w.reg.get(`${CLASSES}\\ClaudeCopy\\shell\\open\\command|`)).toBe(`"C:\\WINDOWS\\System32\\wscript.exe" //B //Nologo "${LOCAL}\\claude-copy\\copy.vbs" "%L"`)
  expect(w.reg.get(`${CLASSES}\\ClaudeCopy|Signature`)).toMatch(/^[0-9a-f]{14}$/)
  expect(w.files.get(`${DIR}/copy.vbs`)).toBe('VBS')
})

test('a current file type gets no writes on the next start', async ($, on) => {
  const w = world(on)
  await started($)
  const first = w.adds().length
  await started($)
  expect(first).toBe(4)
  expect(w.adds().length).toBe(4)
})

test('a failed install still saves the blocks', async ($, on) => {
  const w = world(on, { failRegAdd: true, replies: [REPLY] })
  await started($)
  expect(w.saved().map(([, b]) => b)).toEqual(['echo hi'])
})

test('a block that fails to write does not stop the others, and is retried', async ($, on) => {
  let failures = 1
  const two = 'A:\n\n```\none\n```\n\nB:\n\n```\ntwo\n```'
  const w = world(on, { replies: [two], failWrite: p => p.endsWith('.ccopy') && failures-- > 0 })
  await started($)
  expect(w.saved().map(([, b]) => b)).toEqual(['two'])
  await started($)
  expect(w.saved().map(([, b]) => b).sort()).toEqual(['one', 'two'])
})

test('/resume saves the loaded conversation, which session.start never sees', async ($, on) => {
  const w = world(on, { replies: [REPLY] })
  await $.classic.SessionStart({ source: 'resume' })
  await settle()
  expect(w.saved().map(([, b]) => b)).toEqual(['echo hi'])
})
