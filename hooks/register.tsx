import type { Register } from 'claude-code'

// A boxed "⧉ copy" link on every fenced code block in Claude's replies.
// See ../README.md for the moving parts and how to uninstall.
//
// Classic renderer: Ctrl+click it. Windows Terminal ShellExecutes the
// file:///<home>/<session>/<hash>.ccopy link; the .ccopy file type (HKCU) runs
// <home>\copy.vbs silently, which puts that file's text on the clipboard.
// .ccopy, unlike .vbs, is not in PATHEXT, so Windows Terminal opens it without
// its "unsafe link" dialog. Fullscreen renderer: a plain click lands in
// onLinkPress -> $.ui.copy.
//
// Files are written outside ui.render (the engine refuses side effects while
// drawing): when a reply is appended, and at session start for the replies a
// resume loads. Classic Claude Code prints a file: link's URL after it; the
// link sits in a 6x1 box with overflow hidden, so only "⧉ copy" shows.
//
// Lifetime: one folder per session, stamped (.last) at most every 10 minutes
// while the session is used; a folder unused for KEEP_MS is deleted by the
// next session start or hourly check. No per-turn transcript reads.

const KEEP_MS = 2 * 86_400_000
const STAMP_EVERY_MS = 10 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
const ERR_LOG = '/tmp/claude-copy-errors.log'
const STORE_KEY = 'home'

type Segment = { kind: 'prose'; text: string } | { kind: 'code'; lang: string; body: string; raw: string }

const OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/

// CommonMark-ish fences: any indent (list items), closed by the same char at
// >= the opening length. An unclosed fence (still streaming) stays prose.
function split(text: string): Segment[] {
  const lines = text.split('\n')
  const out: Segment[] = []
  let prose: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const m = OPEN.exec(line)
    const [, lead = '', fence = '', info = ''] = m ?? []
    if (!m || (fence.startsWith('`') && info.includes('`'))) {
      prose.push(line)
      i++
      continue
    }
    const indent = lead.replace(/\t/g, '    ').length
    const close = new RegExp('^[ \\t]*' + (fence.startsWith('`') ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$')
    let j = i + 1
    while (j < lines.length && !close.test(lines[j] ?? '')) j++
    if (j >= lines.length) {
      prose.push(...lines.slice(i))
      break
    }
    const body = lines.slice(i + 1, j).map(l => {
      let k = 0
      while (k < indent && l[k] === ' ') k++
      return l.slice(k)
    })
    if (prose.length) out.push({ kind: 'prose', text: prose.join('\n') })
    prose = []
    const raw = [line.slice(Math.min(indent, lead.length)), ...body, fence].join('\n')
    out.push({ kind: 'code', lang: info.trim().split(/\s+/)[0] ?? '', body: body.join('\n'), raw })
    i = j + 1
  }
  if (prose.length) out.push({ kind: 'prose', text: prose.join('\n') })
  return out
}

function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

const lineCount = (t: string) => t.split('\n').length

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
        .join('\n')
    : typeof content === 'string'
      ? content
      : ''

type Run = (argv: readonly string[], init?: { cwd?: string; stdin?: string }) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>
type Host = {
  fs: {
    read: (p: string) => Promise<string>
    write: (p: string, t: string) => Promise<void>
    list: (p?: string) => Promise<readonly { name: string; kind: string }[]>
    stat: (p: string) => Promise<{ mtimeMs: number }>
  }
  process: { run: Run }
  session: { id: () => Promise<string>; messages: () => Promise<readonly { role: string; text: string }[]> }
  store: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> }
  plugin: { root: string }
}

// Where the files live: %LOCALAPPDATA%\claude-copy, as a Linux path (to write)
// and a file: URL (to link). Asked of Windows once, then kept in $.store.
type Home = { dir: string; win: string; url: string }
let home: Home | undefined
let sid: string | undefined

async function getHome($: Host): Promise<Home> {
  if (home) return home
  const kept = (await $.store.get(STORE_KEY)) as Home | undefined
  if (kept?.dir) return (home = kept)
  // Off WSL there is no cmd.exe: the run fails and nothing is kept, so the
  // next call asks again instead of caching an empty path.
  const local = (await $.process.run(['cmd.exe', '/c', 'echo %LOCALAPPDATA%'], { cwd: '/mnt/c' })).stdout.trim()
  if (!/^[A-Za-z]:\\/.test(local)) throw new Error(`no %LOCALAPPDATA% (not WSL?): ${JSON.stringify(local)}`)
  const win = `${local}\\claude-copy`
  const dir = (await $.process.run(['wslpath', '-u', win])).stdout.trim()
  if (!dir.startsWith('/')) throw new Error(`wslpath failed for ${win}`)
  home = { dir, win, url: 'file:///' + win.replace(/\\/g, '/') }
  await $.store.set(STORE_KEY, home)
  return home
}

const sessionId = async ($: Pick<Host, 'session'>) => (sid ??= await $.session.id())

const logError = ($: Host, what: string, err: unknown) =>
  $.process
    .run(['sh', '-c', `cat >> ${ERR_LOG}`], { stdin: `${new Date().toISOString()} ${what}: ${err}\n` })
    .catch(() => undefined)

// Puts copy.vbs and the .ccopy file type in place when missing or changed:
// a single marker read on a normal start.
async function install($: Host, h: Home): Promise<void> {
  const vbs = await $.fs.read(`${$.plugin.root}/windows/copy.vbs`)
  const version = hash(vbs + h.win)
  if ((await $.fs.read(`${h.dir}/.installed`).catch(() => '')) === version) return
  await $.fs.write(`${h.dir}/copy.vbs`, vbs)
  // The open command, then escaped for a .reg string (\ -> \\, " -> \").
  const command = `"C:\\Windows\\System32\\wscript.exe" //B //Nologo "${h.win}\\copy.vbs" "%1"`
  const reg = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\.ccopy]',
    '@="ClaudeCopy"',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\ClaudeCopy]',
    '@="Claude Code block"',
    '',
    '[HKEY_CURRENT_USER\\Software\\Classes\\ClaudeCopy\\shell\\open\\command]',
    `@="${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    '',
  ].join('\r\n')
  await $.fs.write(`${h.dir}/install.reg`, reg)
  const r = await $.process.run(['reg.exe', 'import', `${h.win}\\install.reg`], { cwd: '/mnt/c' })
  await $.process.run(['rm', '-f', `${h.dir}/install.reg`])
  if (r.exitCode !== 0) throw new Error(`reg import: ${r.stderr.trim()}`)
  await $.fs.write(`${h.dir}/.installed`, version)
}

const written = new Set<string>()

async function saveBlocks($: Host, text: string): Promise<void> {
  const folder = `${(await getHome($)).dir}/${await sessionId($)}`
  for (const s of split(text.replace(/\r\n/g, '\n'))) {
    if (s.kind !== 'code' || !s.body.trim()) continue
    const path = `${folder}/${hash(s.body)}.ccopy`
    if (written.has(path)) continue
    try {
      await $.fs.write(path, s.body.replace(/\n/g, '\r\n'))
      written.add(path)
    } catch (err) {
      await logError($, path, err)
    }
  }
}

let lastStamp = 0
async function stamp($: Host): Promise<void> {
  const now = Date.now()
  if (now - lastStamp < STAMP_EVERY_MS) return
  lastStamp = now
  await $.fs.write(`${(await getHome($)).dir}/${await sessionId($)}/.last`, String(now)).catch(err => logError($, 'stamp', err))
}

let lastPrune = 0
async function prune($: Host): Promise<void> {
  const now = Date.now()
  if (now - lastPrune < PRUNE_EVERY_MS) return
  lastPrune = now
  const { dir } = await getHome($)
  const mine = await sessionId($)
  const expired: string[] = []
  for (const e of await $.fs.list(dir).catch(() => [])) {
    if (e.kind !== 'dir' || e.name === mine) continue
    const folder = `${dir}/${e.name}`
    const used = await $.fs
      .stat(`${folder}/.last`)
      .catch(() => $.fs.stat(folder))
      .then(s => s.mtimeMs, () => now)
    if (now - used > KEEP_MS) expired.push(folder)
  }
  if (expired.length) await $.process.run(['rm', '-rf', '--', ...expired]).catch(err => logError($, 'prune', err))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      await install($, await getHome($))
    } catch (err) {
      await logError($, 'install', err)
    }
    await stamp($).catch(err => logError($, 'stamp', err))
    await prune($).catch(err => logError($, 'prune', err))
    // A resumed session draws old replies without appending them.
    for (const m of await $.session.messages().catch(() => [])) if (m.role === 'assistant' && m.text) await saveBlocks($, m.text).catch(err => logError($, 'save', err))
    return r
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    if (!e.agentId) await saveBlocks($, textOf(e.message.content)).catch(err => logError($, 'save', err))
    return stored
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      await stamp($).catch(err => logError($, 'stamp', err))
      await prune($).catch(err => logError($, 'prune', err))
    }
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const segments = split(e.props.text)
    if (!segments.some(s => s.kind === 'code' && s.body.trim())) return next(e)

    // No Windows home (not WSL, or the lookup failed): draw the stock reply.
    // (Not named h: JSX compiles to the global h.)
    const where = await getHome($).catch(() => undefined)
    if (!where) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const base = `${where.url}/${await sessionId($)}`
    let n = 0

    return (
      <Box flexDirection="column">
        {segments.map((s, idx) => {
          if (s.kind === 'prose') {
            return s.text.trim() ? <Markdown key={`p${idx}`} text={s.text} /> : null
          }
          const k = n++
          const lines = lineCount(s.body)
          return (
            <Box key={`c${k}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor>{s.lang || 'text'}</Text>
                <Box width={6} height={1} overflow="hidden">
                  <Markdown
                    key={`copy${k}`}
                    text={`[⧉ copy](${base}/${hash(s.body)}.ccopy)`}
                    onLinkPress={async (_link, press) => {
                      const r = await $.ui.copy({ text: s.body, surface: press.surface })
                      $.ui.toast(r.isCopied ? `Copied ${lines} line${lines === 1 ? '' : 's'}` : `Copy failed: ${r.reason}`)
                    }}
                  />
                </Box>
              </Box>
              <Markdown text={s.raw} />
            </Box>
          )
        })}
      </Box>
    )
  })
}
