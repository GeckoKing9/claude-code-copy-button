# copy-button

A Claude Code mod that puts a copy link on every code block Claude writes.
Ctrl+click it and the block is on your Windows clipboard. Exact text, no
leading spaces, no line wrapping, no box-drawing characters dragged along.

Made for one setup: **Claude Code running in WSL, shown in Windows Terminal,
with the classic (non-fullscreen) renderer.** That is the setup where copying
a code block by mouse is painful, and where there was no click handler to
hook. In the fullscreen renderer a plain click works too.

Anywhere else (macOS, plain Linux) it stays out of the way and draws replies
as usual.

## Install

In a Claude Code session in the terminal:

```
/plugin install copy-button --marketplace GeckoKing9/claude-code-copy-button
```

Answer `y` to add the marketplace, pick the user scope, and it is active.
Needs Claude Code 2.1.287 or later (the version that added mods).

## How it works

Windows Terminal will open a link on Ctrl+click, and that is the only click
the classic renderer gives you. So the mod turns each block into a file and
the link opens the file:

1. When a reply arrives, each code block is saved to
   `%LOCALAPPDATA%\claude-copy\<session>\<hash>.ccopy`.
2. The reply is redrawn with a small box around each block and a `⧉ copy`
   link pointing at that file.
3. On first run the mod registers a `.ccopy` file type for your Windows user
   (HKCU, no admin) that runs `copy.vbs` silently. The script puts the file's
   text on the clipboard.

Why a custom extension and not just a `.vbs` link: Windows Terminal shows an
"unsafe link" warning for anything in PATHEXT. `.ccopy` isn't, so the click
is silent.

Session folders are deleted two days after the session was last used.

## What it touches, plainly

Read this before installing anything that runs scripts, including this.

- Writes files under `%LOCALAPPDATA%\claude-copy` (your code blocks, a copy of
  `copy.vbs`, a marker file).
- Adds three registry keys under `HKCU\Software\Classes` (`.ccopy` and
  `ClaudeCopy`). See `windows/uninstall.reg`.
- Runs `cmd.exe` once to find `%LOCALAPPDATA%`, `wslpath`, `reg.exe import`
  on first run, and `rm` to prune old session folders.
- No network access. Errors go to `/tmp/claude-copy-errors.log`.

`copy.vbs` is 12 lines. Read it in `windows/`.

Heads up: Microsoft is phasing VBScript out of Windows. When it is gone the
click stops working and the script will need replacing.

## Uninstall

1. `/plugin uninstall copy-button`
2. Remove the file type:
   `reg.exe import "$(wslpath -w <plugin folder>/windows/uninstall.reg)"`
3. Delete `%LOCALAPPDATA%\claude-copy`.

## Develop

```
claude --plugin-dir ./claude-code-copy-button
claude plugin test ./claude-code-copy-button
```

MIT license.
