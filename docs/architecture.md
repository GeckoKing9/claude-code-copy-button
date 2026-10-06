# Architecture

How copy-button works and why it is built this way. For users, the README is
enough; this is for anyone changing the code.

## The constraint

Claude Code's normal (classic) renderer gives a mod no click events. The only
click is the terminal's own Ctrl+click on an OSC 8 link, and Claude Code only
makes `http:`, `https:` and `file:` links clickable. So a copy button has to be
a `file:` link to something that, when the operating system opens it, copies.

## The pieces

| Piece | Job |
|---|---|
| `hooks/register.tsx` | Splits each reply at its fenced code blocks, lets the engine draw the prose, draws a box with a link around each block, and saves each block to a `.ccopy` file. Installs and checks the platform side. |
| `.ccopy` file type | Makes "open this file" mean "copy it". Registered per user, no admin. |
| `windows/copy.vbs` | WSL: the Windows handler. Copies with `clip`. |
| `linux/copy.sh` | Linux: picks `wl-copy`, `xclip` or `xsel`, else `clip.py`. `--check` reports the choice. |
| `linux/clip.py` | Linux with no clipboard tool: owns the X11 CLIPBOARD through libX11 (ctypes), like `xclip`. |

## Decisions

- **The engine draws the prose.** The hook calls `next()` per piece of the
  reply and only adds the boxes, so the bullet, indent and markdown stay the
  engine's. Hand-drawing the whole reply lost the bullet.
- **Nothing runs while drawing.** The engine refuses side effects in
  `ui.render`. Lookup, install, saving and pruning run in one background
  queue, each step failing on its own. Drawing only reads: it waits up to 2 s
  on a lookup in flight, else uses the folder a past session stored, because a
  finished reply cannot be redrawn in normal mode.
- **A custom extension, not a script link.** Windows Terminal warns before
  opening anything in `PATHEXT`; `.ccopy` is not in it.
- **Self-healing install.** Each session compares what is there (files, an
  ASCII registry signature on Windows, the xdg default on Linux) with what
  should be, and redoes only what differs.
- **Handlers only copy their own folder.** Any other `.ccopy` file, or a
  symlink pointing out, is refused, so a stray file cannot replace the
  clipboard.
- **Link encoding per platform.** Windows decodes `%XX` in `file:` URLs with
  the ANSI code page, so non-ASCII stays literal there; Linux reads `%XX` as
  UTF-8, so it is escaped there.
- **No package installs.** A plugin cannot ask for a sudo password, and silent
  system installs are what people rightly fear from mods. `clip.py` removes
  the need instead; if even that cannot work, one notice names the command.
- **One source of truth for "can this copy?".** The notice asks
  `copy.sh --check`, which runs the same choice a click makes.

## Testing

- `claude plugin test .` runs `tests/register.test.ts` against the engine's
  test kit, with the platform (process, file system, registry, xdg) mocked.
- Real behaviour is proven by hand on real systems: a recorded Claude Code
  session (rendered with pyte), a real or simulated click, and the clipboard
  read back. Linux runs used Xubuntu 24.04 (X11, xfce4-terminal), with and
  without a clipboard tool, and a nested Weston session for Wayland.
