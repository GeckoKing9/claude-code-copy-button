import type { EngineInterface, Register } from 'claude-code'

// A boxed "⧉ copy" link on every fenced code block in Claude's replies, for
// Claude Code in WSL shown in Windows Terminal with the classic renderer.
// See ../README.md for the moving parts and how to uninstall.
//
// The classic renderer has no click events; the one click there is Windows
// Terminal's own Ctrl+click on a link. Each block is saved to
// %LOCALAPPDATA%\claude-copy\<session>\<hash>.ccopy and linked; the .ccopy
// file type (HKCU) runs copy.vbs silently, which puts the file's text on the
// clipboard. .ccopy, unlike .vbs, is not in PATHEXT, so Windows Terminal opens
// it without its "unsafe link" dialog.
//
// The engine still draws the prose (bullet, indent, markdown); this hook only
// cuts the reply at its code blocks and draws a box around each one. Classic
// Claude Code prints a file: link's URL after it, so the link sits in a 6x1
// box with overflow hidden and only "⧉ copy" shows.
//
// Drawing never runs anything: the engine refuses side effects there. All
// work (finding the Windows folder, the file type, writing blocks, pruning)
// runs in a background queue, one task at a time, each failure on its own.
// Until the folder is known, replies are drawn as the engine draws them, and
// a redraw follows once it is. Off WSL nothing is drawn or run.

const KEEP_MS = 2 * 86_400_000
const STAMP_EVERY_MS = 10 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
const RETRY_MS = 5 * 60_000
const STORE_KEY = 'home.v2'
const CLASSES = 'HKCU\\Software\\Classes'
const LINK_WIDTH = 6
const GUTTER = 2

type Host = Pick<EngineInterface, 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'store' | 'ui'>

type Code = { kind: 'code'; lang: string; body: string; raw: string }
type Segment = { kind: 'prose'; text: string } | Code

// ---- Parsing ---------------------------------------------------------------

const OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/

const columns = (lead: string) => [...lead].reduce((col, c) => (c === '\t' ? col + 4 - (col % 4) : col + 1), 0)

// Removes `indent` columns of leading whitespace, tabs stopping every 4
// columns; a tab that straddles the edge leaves its extra columns as spaces,
// as CommonMark strips a fenced block's body.
function dedent(line: string, indent: number): string {
  let col = 0
  let i = 0
  while (i < line.length && col < indent) {
    const c = line[i]
    if (c === ' ') col++
    else if (c === '\t') col += 4 - (col % 4)
    else break
    i++
  }
  return ' '.repeat(Math.max(0, col - indent)) + line.slice(i)
}

// CommonMark-ish fences: any indent (list items), closed by the same char at
// >= the opening length, indented at most 3 columns past the opening fence.
// An unclosed fence (still streaming) stays prose.
function split(text: string): Segment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
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
    const indent = columns(lead)
    const close = new RegExp(`^([ \\t]*)${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`)
    const closes = (l: string) => {
      const c = close.exec(l)
      return c !== null && columns(c[1] ?? '') <= indent + 3
    }
    let j = i + 1
    while (j < lines.length && !closes(lines[j] ?? '')) j++
    if (j >= lines.length) {
      prose.push(...lines.slice(i))
      break
    }
    const body = lines.slice(i + 1, j).map(l => dedent(l, indent))
    if (prose.length) out.push({ kind: 'prose', text: prose.join('\n') })
    prose = []
    out.push({ kind: 'code', lang: info.trim().split(/\s+/)[0] ?? '', body: body.join('\n'), raw: [line.slice(lead.length), ...body, fence].join('\n') })
    i = j + 1
  }
  if (prose.length) out.push({ kind: 'prose', text: prose.join('\n') })
  return out
}

// A code block with something in it; an empty one is drawn as the engine draws it.
const copyable = (s: Segment): Code | undefined => (s.kind === 'code' && s.body.trim() !== '' ? s : undefined)

// 53-bit hash (cyrb53): a file per distinct block, collisions out of reach.
function hash(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map(b => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
        .join('\n')
    : typeof content === 'string'
      ? content
      : ''

// ---- Where the files live --------------------------------------------------

// %LOCALAPPDATA%\claude-copy as a Linux path (to write), a Windows path (for
// the registry) and a file: URL (to link), plus %SystemRoot%.
type Home = { dir: string; win: string; url: string; systemRoot: string }

// A file: URL path segment that is also a valid markdown link destination.
// Only ASCII that would break either is escaped; non-ASCII stays literal,
// because Windows decodes %XX in file: URLs with the ANSI code page, so a
// UTF-8 escape of "é" names a different folder.
const urlSegment = (s: string) => s.replace(/[\x00-\x20"#%'()<>?[\\\]^`{|}\x7f]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
const fileUrl = (win: string) => {
  const [drive = '', ...rest] = win.split('\\')
  return `file:///${drive}/${rest.map(urlSegment).join('/')}`
}

async function locate($: Host): Promise<Home | null> {
  // Not WSL: there is no Windows side to copy through. Settled for good.
  if (!(await $.env.get('WSL_DISTRO_NAME')) && !(await $.env.get('WSL_INTEROP'))) return null
  const kept = (await $.store.get(STORE_KEY)) as Home | undefined
  if (kept?.dir && kept.systemRoot) return kept
  // chcp 65001: the paths come back as UTF-8 whatever the user's name is.
  const r = await $.process.run(['cmd.exe', '/d', '/c', 'chcp 65001 >nul & echo %LOCALAPPDATA%& echo %SystemRoot%'], { cwd: '/mnt/c' })
  const [local = '', systemRoot = ''] = r.stdout.split(/\r?\n/).map(l => l.trim())
  if (!/^[A-Za-z]:\\/.test(local) || !/^[A-Za-z]:\\/.test(systemRoot)) throw new Error(`no %LOCALAPPDATA%: ${JSON.stringify(r.stdout)} ${r.stderr}`)
  const win = `${local}\\claude-copy`
  const w = await $.process.run(['wslpath', '-u', win])
  const dir = w.stdout.trim()
  if (w.exitCode !== 0 || !dir.startsWith('/')) throw new Error(`wslpath ${win}: ${w.stderr}`)
  const home = { dir, win, url: fileUrl(win), systemRoot }
  await $.store.set(STORE_KEY, home)
  return home
}

// What drawing reads: undefined until looked up, null off WSL.
let known: Home | null | undefined
let failedAt = 0

async function getHome($: Host): Promise<Home | null> {
  if (known !== undefined) return known
  // On WSL a failed lookup (interop off, cmd.exe missing) is retried, not
  // hammered: once per RETRY_MS at most.
  if (Date.now() - failedAt < RETRY_MS) return null
  try {
    known = await locate($)
  } catch (err) {
    failedAt = Date.now()
    throw err
  }
  if (known) $.ui.invalidate('ui.render')
  return known
}

const log = ($: Host, what: string, err: unknown) => $.ui.log(`copy-button: ${what}: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })

// ---- Background work, one task at a time ----------------------------------

let queue: Promise<void> = Promise.resolve()
const later = ($: Host, what: string, task: (h: Home) => Promise<void>) => {
  queue = queue
    .then(async () => {
      const h = await getHome($)
      if (h) await task(h)
    })
    .catch(err => log($, what, err))
}

const run = async ($: Host, argv: string[]) => {
  const r = await $.process.run(argv, { cwd: '/mnt/c' })
  if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')}: exit ${r.exitCode} ${r.stderr.trim()}`)
  return r.stdout
}

// Puts copy.vbs and the .ccopy file type in place, checked against what is
// actually there each session, so a removed or stale entry heals itself. The
// check reads an ASCII signature of the command, never the command itself:
// reg.exe prints in the console code page, which mangles non-ASCII paths.
async function install($: Host, h: Home): Promise<void> {
  const vbs = await $.fs.read(`${$.plugin.root}/windows/copy.vbs`)
  if ((await $.fs.read(`${h.dir}/copy.vbs`).catch(() => '')) !== vbs) await $.fs.write(`${h.dir}/copy.vbs`, vbs)
  // %L: the long path, so copy.vbs compares like with like.
  const command = `"${h.systemRoot}\\System32\\wscript.exe" //B //Nologo "${h.win}\\copy.vbs" "%L"`
  const signature = hash(command)
  const query = (key: string, value: string[]) => $.process.run(['reg.exe', 'query', key, ...value], { cwd: '/mnt/c' }).then(r => r.stdout, () => '')
  const [ext, sig] = await Promise.all([query(`${CLASSES}\\.ccopy`, ['/ve']), query(`${CLASSES}\\ClaudeCopy`, ['/v', 'Signature'])])
  if (ext.includes('ClaudeCopy') && sig.includes(signature)) return
  // Arguments, not a .reg file: WSL hands them to reg.exe as UTF-16, so a
  // non-ASCII user name survives.
  await run($, ['reg.exe', 'add', `${CLASSES}\\ClaudeCopy\\shell\\open\\command`, '/ve', '/d', command, '/f'])
  await run($, ['reg.exe', 'add', `${CLASSES}\\ClaudeCopy`, '/ve', '/d', 'Claude Code block', '/f'])
  await run($, ['reg.exe', 'add', `${CLASSES}\\.ccopy`, '/ve', '/d', 'ClaudeCopy', '/f'])
  await run($, ['reg.exe', 'add', `${CLASSES}\\ClaudeCopy`, '/v', 'Signature', '/d', signature, '/f'])
}

const written = new Set<string>()

// Writes each block of a reply; a block that fails is logged and left for the
// next save to retry, the others are still written.
async function saveBlocks($: Host, h: Home, text: string): Promise<void> {
  const folder = `${h.dir}/${await $.session.id()}`
  for (const s of split(text)) {
    const code = copyable(s)
    if (!code) continue
    const path = `${folder}/${hash(code.body)}.ccopy`
    if (written.has(path)) continue
    try {
      await $.fs.write(path, code.body.replace(/\n/g, '\r\n'))
      written.add(path)
    } catch (err) {
      log($, `save ${path}`, err)
    }
  }
}

// Every reply of the conversation: at start, after /resume or /clear, and
// when this session's folder has gone missing.
async function saveAll($: Host, h: Home): Promise<void> {
  for (const m of await $.session.messages()) if (m.role === 'assistant' && m.text) await saveBlocks($, h, m.text)
}

// Marks this session's folder as in use. If it is gone (pruned by another
// session after two idle days), every block is written again.
let lastStamp = 0
async function stamp($: Host, h: Home): Promise<void> {
  const now = Date.now()
  if (now - lastStamp < STAMP_EVERY_MS) return
  lastStamp = now
  const folder = `${h.dir}/${await $.session.id()}`
  if (written.size && !(await $.fs.exists(folder))) {
    written.clear()
    await saveAll($, h)
  }
  await $.fs.write(`${folder}/.last`, String(now))
}

// Deletes session folders unused for KEEP_MS, temp files copy.vbs left behind
// after a failed click, and files older versions wrote.
const LITTER = /^(rad[0-9a-f]+\.tmp|clip\.u16|\.installed)$/i
let lastPrune = 0
async function prune($: Host, h: Home): Promise<void> {
  const now = Date.now()
  if (now - lastPrune < PRUNE_EVERY_MS) return
  lastPrune = now
  const mine = await $.session.id()
  const expired: string[] = []
  for (const e of await $.fs.list(h.dir)) {
    const path = `${h.dir}/${e.name}`
    if (e.kind === 'file' && LITTER.test(e.name)) {
      expired.push(path)
      continue
    }
    if (e.kind !== 'dir' || e.name === mine) continue
    const used = await $.fs
      .stat(`${path}/.last`)
      .catch(() => $.fs.stat(path))
      .then(s => s.mtimeMs, () => now)
    if (now - used > KEEP_MS) expired.push(path)
  }
  if (expired.length) await run($, ['rm', '-rf', '--', ...expired])
}

// ---- Hooks -----------------------------------------------------------------

export const register: Register = on => {
  // Once per process and per reload of this module.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    later($, 'install', h => install($, h))
    later($, 'stamp', h => stamp($, h))
    later($, 'prune', h => prune($, h))
    later($, 'save', h => saveAll($, h))
    return r
  })

  // /resume and /clear swap the conversation without a session.start.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'resume' || e.source === 'clear' || e.source === 'fork') {
      lastStamp = 0
      later($, 'save', h => saveAll($, h))
      later($, 'stamp', h => stamp($, h))
    }
    return r
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    // The row as stored, after any plugin beneath rewrote it.
    if (!e.agentId && stored.deny === undefined) {
      const text = textOf(stored.message.content)
      later($, 'save', h => saveBlocks($, h, text))
    }
    return stored
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      later($, 'stamp', h => stamp($, h))
      later($, 'prune', h => prune($, h))
    }
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Classic terminal only: the fullscreen renderer, desktop and IDE surfaces
    // have mouse handling of their own; a summary row is not the saved text.
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen || e.props.isSummary) return next(e)
    const where = known // (not named h: JSX compiles to the global h)
    if (!where) return next(e)
    const segments = split(e.props.text)
    if (!segments.some(copyable)) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const base = `${where.url}/${urlSegment(await $.session.id())}`
    // Laid out as the engine lays out a reply: the bullet on the first piece,
    // every other piece under it (GUTTER), a blank line between pieces. The
    // engine's own drawing of a piece brings its blank line; a box adds one.
    const parts = []
    let isFirst = e.props.isFirstOfReply
    for (const [i, s] of segments.entries()) {
      const code = copyable(s)
      if (!code) {
        const text = (s.kind === 'prose' ? s.text : s.raw).replace(/^\n+|\n+$/g, '')
        if (!text.trim()) continue
        const drawn = await next({ ...e, props: { ...e.props, text, isFirstOfReply: isFirst } })
        parts.push(
          <Box key={`p${i}`} marginLeft={isFirst ? 0 : GUTTER}>
            {drawn}
          </Box>,
        )
        isFirst = false
        continue
      }
      parts.push(
        <Box key={`c${i}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1} marginLeft={GUTTER}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{code.lang || 'text'}</Text>
            <Box width={LINK_WIDTH} height={1} overflow="hidden">
              <Markdown text={`[⧉ copy](${base}/${hash(code.body)}.ccopy)`} />
            </Box>
          </Box>
          <Markdown text={code.raw} />
        </Box>,
      )
      isFirst = false
    }
    return <Box flexDirection="column">{parts}</Box>
  })
}
