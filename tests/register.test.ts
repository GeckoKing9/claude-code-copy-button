import { test, expect, mock } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'

const session: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const LOCAL = 'C:\\Users\\Jöhn Smith (x)\\AppData\\Local'
const DIR = '/mnt/c/Users/Jöhn Smith (x)/AppData/Local/claude-copy'
const URL = 'file:///C:/Users/Jöhn%20Smith%20%28x%29/AppData/Local/claude-copy/sess-1/'
const REPLY = 'First line.\n\n```bash\necho hi\n```\n\nLast line.'
const CLASSES = 'HKCU\\Software\\Classes'

type Opts = { canCopy?: boolean; installer?: string; stored?: Record<string, unknown>; gate?: Promise<void>; wsl?: boolean; linux?: { uname?: string; env?: Record<string, string> }; registry?: 'missing' | 'current'; replies?: string[]; failRegAdd?: boolean; failWrite?: (path: string) => boolean }

const result = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: exitCode ? 'failed' : '', isStdoutTruncated: false, isStderrTruncated: false } })

// The world beneath the mod: WSL or not, Windows, a file system in memory, the
// registry, and the engine's stock drawing (which echoes what it was asked).
const world = (on: On, { canCopy = true, installer, stored, gate, wsl = true, linux, registry = 'missing', replies = [], failRegAdd = false, failWrite = () => false }: Opts = {}) => {
  mock.store(on, stored)
  const clock = mock.clock(on)
  mock.env(on, linux ? { HOME: '/home/Jöhn Smith', ...(linux.env ?? { DISPLAY: ':0' }) } : wsl ? { WSL_DISTRO_NAME: 'Ubuntu' } : {})
  let xdgDefault = ''
  let executable = false
  const runs: string[][] = []
  const files = new Map<string, string>()
  const reg = new Map<string, string>()
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (gate && (argv[0] === 'cmd.exe' || argv[0] === 'uname')) await gate
    if (argv[0] === 'uname') return result(0, `${linux?.uname ?? 'Linux'}\n`)
    if (argv[0] === 'test') return result(executable ? 0 : 1)
    if (argv[0] === 'sh' && argv[2]?.startsWith('command -v wl-copy')) return result(canCopy ? 0 : 1)
    if (argv[0] === 'sh' && argv[2]?.startsWith('command -v ')) return result(argv[2] === `command -v ${installer}` ? 0 : 1)
    if (argv[0] === 'chmod') executable = true
    if (argv[0] === 'xdg-mime' && argv[1] === 'query') return result(0, xdgDefault ? `${xdgDefault}\n` : '')
    if (argv[0] === 'xdg-mime' && argv[1] === 'default') {
      xdgDefault = argv[2] ?? ''
      return result(0)
    }
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
  on('fs.read', ($, e) => (e.path.endsWith('/windows/copy.vbs') ? { value: 'VBS' } : e.path.endsWith('/linux/copy.sh') ? { value: 'SH' } : e.path.endsWith('/linux/clip.py') ? { value: 'PY' } : files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: 'ENOENT' }))
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
  const notices: string[] = []
  on('ui.log', ($, e) => {
    notices.push(e.text)
    return { value: undefined }
  })
  const asked: { text: string; isFirstOfReply: boolean }[] = []
  on('ui.render', ($, e) => {
    const p = e.props as { text?: string; isFirstOfReply?: boolean }
    asked.push({ text: p.text ?? '', isFirstOfReply: p.isFirstOfReply ?? false })
    return { type: 'Text', props: {}, children: [`STOCK:${p.text ?? ''}`] }
  })
  const adds = () => runs.filter(r => r[0] === 'reg.exe' && r[1] === 'add')
  const saved = () => [...files.entries()].filter(([p]) => p.endsWith('.ccopy'))
  return { notices, runs, files, reg, asked, adds, saved, clock, lose: () => (executable = false) }
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
  expect(tree).toContain(`[⧉ copy](${URL}`)
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

// ---- Linux -------------------------------------------------------------------

const LINUX_DIR = '/home/Jöhn Smith/.local/share/claude-copy'

test('linux: the link is a UTF-8 encoded file: URL and the block is saved with LF', async ($, on) => {
  const w = world(on, { linux: {}, replies: ['Run:\n\n```sh\nline one\nline two\n```'] })
  await started($)
  const tree = flat(await $.ui.render(message(REPLY)))
  expect(tree).toContain('[❐ copy](file:///home/J%C3%B6hn%20Smith/.local/share/claude-copy/sess-1/')
  expect(w.saved().map(([, b]) => b)).toEqual(['line one\nline two'])
  expect(w.saved()[0]?.[0]).toStartWith(`${LINUX_DIR}/sess-1/`)
})

test('linux: the file type is installed once, as the default app, with a quoted Exec', async ($, on) => {
  const w = world(on, { linux: {} })
  await started($)
  expect(w.files.get(`${LINUX_DIR}/copy.sh`)).toBe('SH')
  expect(w.files.get(`${LINUX_DIR}/clip.py`)).toBe('PY')
  expect(w.notices).toEqual([])
  expect(w.files.get('/home/Jöhn Smith/.local/share/mime/packages/claude-copy.xml')).toContain('<glob pattern="*.ccopy"')
  expect(w.files.get('/home/Jöhn Smith/.local/share/applications/claude-copy.desktop')).toContain(`Exec="${LINUX_DIR}/copy.sh" %f`)
  const ran = (name: string) => w.runs.filter(r => r[0] === name).map(r => r.join(' '))
  expect(ran('chmod')).toEqual([`chmod 755 ${LINUX_DIR}/copy.sh`])
  expect(ran('xdg-mime').filter(r => r.startsWith('xdg-mime default '))).toEqual(['xdg-mime default claude-copy.desktop application/x-claude-copy'])
  const writes = w.files.size
  await started($)
  expect(ran('chmod').length).toBe(1)
  expect(w.files.size).toBe(writes)
})

test('linux: XDG_DATA_HOME is where everything goes', async ($, on) => {
  const w = world(on, { linux: { env: { DISPLAY: ':0', XDG_DATA_HOME: '/data/' } } })
  await started($)
  expect(w.files.get('/data/claude-copy/copy.sh')).toBe('SH')
  expect([...w.files.keys()].every(p => p.startsWith('/data/'))).toBe(true)
})

test('macOS and a session with no display are left alone', async ($, on) => {
  const mac = world(on, { linux: { uname: 'Darwin' }, replies: [REPLY] })
  await started($)
  expect(flat(await $.ui.render(message(REPLY)))).toBe(stock(REPLY))
  expect(mac.runs.map(r => r[0])).toEqual(['uname'])
  expect(mac.files.size).toBe(0)
})

test('a reply drawn while the folder is being looked up waits for it', async ($, on) => {
  let open = () => {}
  const gate = new Promise<void>(r => (open = r))
  const w = world(on, { gate })
  await $.session.start(session)
  await settle()
  expect(w.runs.map(r => r[0])).toEqual(['cmd.exe'])
  const drawing = $.ui.render(message(REPLY))
  await settle()
  open()
  expect(flat(await drawing)).toContain('.ccopy)')
})

test('linux: a lost run permission on copy.sh is put back next session', async ($, on) => {
  const w = world(on, { linux: {} })
  await started($)
  w.lose()
  await started($)
  expect(w.runs.filter(r => r[0] === 'chmod').length).toBe(2)
})

test('linux: a Wayland-only session is a Linux desktop', async ($, on) => {
  const w = world(on, { linux: { env: { WAYLAND_DISPLAY: 'wayland-0' } }, replies: [REPLY] })
  await started($)
  expect(w.saved().length).toBe(1)
})

test('linux: a forwarded display (ssh -X) is left alone', async ($, on) => {
  const w = world(on, { linux: { env: { DISPLAY: 'localhost:10.0', SSH_CONNECTION: '10.0.0.2 5000 10.0.0.9 22' } }, replies: [REPLY] })
  await started($)
  expect(flat(await $.ui.render(message(REPLY)))).toBe(stock(REPLY))
  expect(w.runs).toEqual([])
})

test('linux: a relative XDG_DATA_HOME is ignored, as the spec says', async ($, on) => {
  const w = world(on, { linux: { env: { DISPLAY: ':0', XDG_DATA_HOME: 'data' } } })
  await started($)
  expect(w.files.get(`${LINUX_DIR}/copy.sh`)).toBe('SH')
})

test('linux: Exec escapes $, quotes and backslashes twice and doubles %', async ($, on) => {
  const w = world(on, { linux: { env: { DISPLAY: ':0', XDG_DATA_HOME: '/d/a$b"c\\d%e' } } })
  await started($)
  expect(w.files.get('/d/a$b"c\\d%e/applications/claude-copy.desktop')).toContain('Exec="/d/a\\\\$b\\\\"c\\\\\\\\d%%e/claude-copy/copy.sh" %f')
})

test('a lookup slower than the wait leaves that one reply to the engine', async ($, on) => {
  const gate = new Promise<void>(() => {})
  const w = world(on, { gate })
  await $.session.start(session)
  await settle()
  const drawing = $.ui.render(message(REPLY))
  await settle()
  await w.clock.advance(2_000)
  expect(flat(await drawing)).toBe(stock(REPLY))
})

test('a resumed session drawing before the lookup uses the folder a past session kept', async ($, on) => {
  const kept = { kind: 'wsl', dir: DIR, win: `${LOCAL}\\claude-copy`, url: 'file:///C:/kept', systemRoot: 'C:\\WINDOWS' }
  world(on, { stored: { 'home.v3': kept } })
  expect(flat(await $.ui.render(message(REPLY)))).toContain('(file:///C:/kept/sess-1/')
})

test('linux: with nothing that can copy, one notice names the command for this system', async ($, on) => {
  const w = world(on, { linux: {}, canCopy: false, installer: 'dnf' })
  await started($)
  expect(w.notices).toEqual(['copy-button: nothing on this system can copy to the clipboard; to make the copy links work, run: sudo dnf install xclip'])
})

test('linux: with no known package manager, the notice names both tools', async ($, on) => {
  const w = world(on, { linux: {}, canCopy: false })
  await started($)
  expect(w.notices[0]).toEndWith('install xclip (X11) or wl-clipboard (Wayland)')
})
