import type { EngineInterface, Register } from 'claude-code'

// A boxed "⧉ copy" link on every fenced code block in Claude's replies, for
// Claude Code in the classic renderer: in WSL shown in Windows Terminal, or on
// a Linux desktop. See ../README.md for the moving parts and how to uninstall.
//
// The classic renderer has no click events; the one click there is the
// terminal's own Ctrl+click on a link. Each block is saved to a .ccopy file
// and linked, and the .ccopy file type copies the file's text:
// - WSL: %LOCALAPPDATA%\claude-copy\<session>\<hash>.ccopy; the file type
//   (HKCU) runs copy.vbs silently. .ccopy, unlike .vbs, is not in PATHEXT, so
//   Windows Terminal opens it without its "unsafe link" dialog.
// - Linux: $XDG_DATA_HOME/claude-copy/<session>/<hash>.ccopy; a shared-mime
//   type and a hidden .desktop entry run copy.sh (wl-copy, xclip or xsel).
//
// The engine still draws the prose (bullet, indent, markdown); this hook only
// cuts the reply at its code blocks and draws a box around each one. Classic
// Claude Code prints a file: link's URL after it, so the link sits in a 6x1
// box with overflow hidden and only "⧉ copy" shows.
//
// Drawing never runs anything: the engine refuses side effects there. All
// work (finding the Windows folder, the file type, writing blocks, pruning)
// runs in a background queue, one task at a time, each failure on its own.
// A reply drawn while the folder is being looked up waits for it (up to
// LOOKUP_WAIT_MS): the classic renderer cannot redraw a finished reply. Anywhere else (no Windows side and no Linux
// display: macOS, a plain SSH session) nothing is drawn or run.

const KEEP_MS = 2 * 86_400_000
const STAMP_EVERY_MS = 10 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
const RETRY_MS = 5 * 60_000
const LOOKUP_WAIT_MS = 2_000
const STORE_KEY = 'home.v3'
const MIME = 'application/x-claude-copy'
const DESKTOP = 'claude-copy.desktop'
const CLASSES = 'HKCU\\Software\\Classes'
const LINK_WIDTH = 6
// The link's icon: Windows Terminal's fonts have ⧉; Linux's default monospace
// (DejaVu Sans Mono) has ❐ but not ⧉, which it draws as an empty box.
const ICON = { wsl: '⧉', linux: '❐' } as const
const GUTTER = 2

type Host = Pick<EngineInterface, 'clock' | 'env' | 'fs' | 'plugin' | 'process' | 'session' | 'store' | 'ui'>

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

// WSL: %LOCALAPPDATA%\claude-copy as a Linux path (to write), a Windows path
// (for the registry) and a file: URL (to link), plus %SystemRoot%.
// Linux: $XDG_DATA_HOME/claude-copy and its file: URL.
type Home = { kind: 'wsl'; dir: string; win: string; url: string; systemRoot: string } | { kind: 'linux'; dir: string; url: string; dataHome: string }

// A file: URL path segment that is also a valid markdown link destination.
// Windows decodes %XX in file: URLs with the ANSI code page, so a UTF-8
// escape of "é" names a different folder there: only ASCII that would break
// the URL or the markdown is escaped and non-ASCII stays literal. Linux reads
// %XX as UTF-8, so everything outside unreserved ASCII is escaped.
const escape = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
const winSegment = (s: string) => s.replace(/[\x00-\x20"#%'()<>?[\\\]^`{|}\x7f]/g, escape)
const linuxSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, escape)
const winUrl = (win: string) => {
  const [drive = '', ...rest] = win.split('\\')
  return `file:///${drive}/${rest.map(winSegment).join('/')}`
}
const linuxUrl = (dir: string) => `file://${dir.split('/').map(linuxSegment).join('/')}`
const urlSegment = (h: Home, s: string) => (h.kind === 'wsl' ? winSegment(s) : linuxSegment(s))

async function locateWsl($: Host): Promise<Home> {
  const kept = (await $.store.get(STORE_KEY)) as Home | undefined
  if (kept?.kind === 'wsl' && kept.dir && kept.systemRoot) return kept
  // chcp 65001: the paths come back as UTF-8 whatever the user's name is.
  const r = await $.process.run(['cmd.exe', '/d', '/c', 'chcp 65001 >nul & echo %LOCALAPPDATA%& echo %SystemRoot%'], { cwd: '/mnt/c' })
  const [local = '', systemRoot = ''] = r.stdout.split(/\r?\n/).map(l => l.trim())
  if (!/^[A-Za-z]:\\/.test(local) || !/^[A-Za-z]:\\/.test(systemRoot)) throw new Error(`no %LOCALAPPDATA%: ${JSON.stringify(r.stdout)} ${r.stderr}`)
  const win = `${local}\\claude-copy`
  const w = await $.process.run(['wslpath', '-u', win])
  const dir = w.stdout.trim()
  if (w.exitCode !== 0 || !dir.startsWith('/')) throw new Error(`wslpath ${win}: ${w.stderr}`)
  const home: Home = { kind: 'wsl', dir, win, url: winUrl(win), systemRoot }
  await $.store.set(STORE_KEY, home)
  return home
}

async function locateLinux($: Host): Promise<Home | null> {
  const kept = (await $.store.get(STORE_KEY)) as Home | undefined
  if (kept?.kind === 'linux' && kept.dir) return kept
  const r = await $.process.run(['uname', '-s'])
  if (r.stdout.trim() !== 'Linux') return null // macOS and others: not yet
  const user = await $.env.get('HOME')
  if (!user?.startsWith('/')) return null
  // The XDG spec: a relative XDG_DATA_HOME is invalid and ignored.
  const xdg = (await $.env.get('XDG_DATA_HOME'))?.replace(/\/+$/, '')
  const dataHome = xdg?.startsWith('/') ? xdg : `${user}/.local/share`
  const dir = `${dataHome}/claude-copy`
  const home: Home = { kind: 'linux', dir, url: linuxUrl(dir), dataHome }
  await $.store.set(STORE_KEY, home)
  return home
}

// Which side this session copies through, from the environment alone, so
// drawing may ask too. A forwarded display (ssh -X, a container) is not
// the screen the user clicks on: the links would name the remote machine.
async function platformOf($: Host): Promise<Home['kind'] | null> {
  if ((await $.env.get('WSL_DISTRO_NAME')) || (await $.env.get('WSL_INTEROP'))) return 'wsl'
  if ((await $.env.get('SSH_CONNECTION')) || (await $.env.get('SSH_TTY'))) return null
  if (!(await $.env.get('DISPLAY')) && !(await $.env.get('WAYLAND_DISPLAY'))) return null
  return 'linux'
}

async function locate($: Host): Promise<Home | null> {
  const platform = await platformOf($)
  if (platform === 'wsl') return locateWsl($)
  if (platform === 'linux') return locateLinux($)
  return null
}

// What drawing reads: undefined until looked up, null where the mod stays out;
// `lookup` is the lookup in flight, which drawing may wait on but never starts.
// Before that, drawing falls back on the folder a past session kept.
let known: Home | null | undefined
let lookup: Promise<Home | null> | undefined
let failedAt = 0

async function getHome($: Host): Promise<Home | null> {
  if (known !== undefined) return known
  // On WSL a failed lookup (interop off, cmd.exe missing) is retried, not
  // hammered: once per RETRY_MS at most.
  if (Date.now() - failedAt < RETRY_MS) return null
  lookup ??= locate($)
    .then(
      h => {
        known = h
        if (h) $.ui.invalidate('ui.render')
        return h
      },
      err => {
        failedAt = Date.now()
        throw err
      },
    )
    .finally(() => {
      lookup = undefined
    })
  return lookup
}

// For a reply drawn before the folder is known: wait on the lookup in flight
// (up to LOOKUP_WAIT_MS), or, before one has started (a resumed session draws
// early), take the folder a past session kept. Reads only: drawing runs nothing.
async function homeWhileDrawing($: Host, signal: AbortSignal): Promise<Home | null> {
  if (lookup) return Promise.race([lookup.catch(() => null), $.clock.sleep(LOOKUP_WAIT_MS, { signal }).then(() => null, () => null)])
  const kept = (await $.store.get(STORE_KEY).catch(() => undefined)) as Home | undefined
  return kept && kept.kind === (await platformOf($)) ? kept : null
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

// Windows programs run from /mnt/c: a Linux working directory makes cmd.exe
// and reg.exe warn about UNC paths.
const run = async ($: Host, argv: string[], cwd?: string) => {
  const r = await $.process.run(argv, cwd ? { cwd } : {})
  if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')}: exit ${r.exitCode} ${r.stderr.trim()}`)
  return r.stdout
}

// Puts copy.vbs and the .ccopy file type in place, checked against what is
// actually there each session, so a removed or stale entry heals itself. The
// check reads an ASCII signature of the command, never the command itself:
// reg.exe prints in the console code page, which mangles non-ASCII paths.
async function installWsl($: Host, h: Extract<Home, { kind: 'wsl' }>): Promise<void> {
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
  await run($, ['reg.exe', 'add', `${CLASSES}\\ClaudeCopy\\shell\\open\\command`, '/ve', '/d', command, '/f'], '/mnt/c')
  await run($, ['reg.exe', 'add', `${CLASSES}\\ClaudeCopy`, '/ve', '/d', 'Claude Code block', '/f'], '/mnt/c')
  await run($, ['reg.exe', 'add', `${CLASSES}\\.ccopy`, '/ve', '/d', 'ClaudeCopy', '/f'], '/mnt/c')
  await run($, ['reg.exe', 'add', `${CLASSES}\\ClaudeCopy`, '/v', 'Signature', '/d', signature, '/f'], '/mnt/c')
}

// A path in a .desktop Exec line: double-quoted, with the characters the
// spec reserves escaped, and % doubled.
const execArg = (path: string) =>
  `"${path.replace(/["`$\\]/g, c => `\\${c}`)}"`
    // then the key-file string escape over the whole value: \ is written \\
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '%%')

// The freedesktop way: a shared-mime type for *.ccopy, a hidden .desktop entry
// that runs copy.sh on the file, and that entry as the type's default app,
// all under the user's own data and config folders. Checked each session
// like the Windows side: a file that differs, or another default, is redone.
async function installLinux($: Host, h: Extract<Home, { kind: 'linux' }>): Promise<void> {
  const script = `${h.dir}/copy.sh`
  const want = new Map([
    [script, await $.fs.read(`${$.plugin.root}/linux/copy.sh`)],
    [`${h.dir}/clip.py`, await $.fs.read(`${$.plugin.root}/linux/clip.py`)],
    [
      `${h.dataHome}/mime/packages/claude-copy.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="${MIME}">
    <comment>Claude Code block</comment>
    <glob pattern="*.ccopy" weight="90"/>
  </mime-type>
</mime-info>
`,
    ],
    [
      `${h.dataHome}/applications/${DESKTOP}`,
      // sh runs the script so that its path is an argument, not argv[0]: GLib
      // checks that argv[0] exists before it unescapes %%, so a % in the path
      // would make the entry unloadable and every click do nothing. It also
      // spares the exec bit.
      `[Desktop Entry]
Type=Application
Name=Claude Code copy button
Comment=Copies a Claude Code block to the clipboard
Exec=sh ${execArg(script)} %f
MimeType=${MIME};
NoDisplay=true
Terminal=false
`,
    ],
  ])
  const stale: string[] = []
  for (const [path, text] of want) if ((await $.fs.read(path).catch(() => '')) !== text) stale.push(path)
  const current = await $.process.run(['xdg-mime', 'query', 'default', MIME]).then(r => r.stdout.trim(), () => '')
  const runnable = await $.process.run(['test', '-x', script]).then(r => r.exitCode === 0, () => false)
  if (stale.length || current !== DESKTOP || !runnable) {
    for (const path of stale) await $.fs.write(path, want.get(path) ?? '')
    await run($, ['chmod', '755', script])
    await run($, ['update-mime-database', `${h.dataHome}/mime`])
    await $.process.run(['update-desktop-database', `${h.dataHome}/applications`]).catch(() => undefined)
    await run($, ['xdg-mime', 'default', DESKTOP, MIME])
  }
}

// The package that gives a click something to copy with: wl-clipboard on a
// Wayland session with no X11 layer, xclip otherwise.
const INSTALL: Record<string, (pkg: string) => string> = {
  'apt-get': pkg => `sudo apt install ${pkg}`,
  dnf: pkg => `sudo dnf install ${pkg}`,
  pacman: pkg => `sudo pacman -S ${pkg}`,
  zypper: pkg => `sudo zypper install ${pkg}`,
}
const FIRST_INSTALLER = `for t in ${Object.keys(INSTALL).join(' ')}; do command -v "$t" >/dev/null 2>&1 && { echo "$t"; break; }; done`
const WARNED_KEY = 'warned-session'

// The one notice this mod ever shows: a click would copy nothing. copy.sh
// answers that itself (--check runs the exact choice a click makes), so the
// notice and the click cannot disagree. Once per session, reloads included.
async function warnIfNothingCopies($: Host, h: Extract<Home, { kind: 'linux' }>): Promise<void> {
  if ((await $.process.run(['sh', `${h.dir}/copy.sh`, '--check'])).exitCode === 0) return
  const session = await $.session.id()
  if ((await $.store.get(WARNED_KEY)) === session) return
  await $.store.set(WARNED_KEY, session)
  const pkg = (await $.env.get('WAYLAND_DISPLAY')) && !(await $.env.get('DISPLAY')) ? 'wl-clipboard' : 'xclip'
  const installer = (await $.process.run(['sh', '-c', FIRST_INSTALLER])).stdout.trim()
  const how = INSTALL[installer]?.(pkg) ?? `install ${pkg}`
  $.ui.log(`copy-button: nothing on this system can copy to the clipboard; to make the copy links work, run: ${how}`)
}

const install = ($: Host, h: Home) => (h.kind === 'wsl' ? installWsl($, h) : installLinux($, h))

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
      await $.fs.write(path, h.kind === 'wsl' ? code.body.replace(/\n/g, '\r\n') : code.body)
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
    later($, 'clipboard check', h => (h.kind === 'linux' ? warnIfNothingCopies($, h) : Promise.resolve()))
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
    const segments = split(e.props.text)
    if (!segments.some(copyable)) return next(e)
    const where = known ?? (await homeWhileDrawing($, next.signal)) // (not named h: JSX compiles to the global h)
    if (!where) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    const base = `${where.url}/${urlSegment(where, await $.session.id())}`
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
              <Markdown text={`[${ICON[where.kind]} copy](${base}/${hash(code.body)}.ccopy)`} />
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
