# copy-button

**Ctrl+click to copy any code block in Claude Code.** One click, exact text,
straight to your Windows clipboard.

![Ctrl+clicking the copy link on a code block, then pasting it into the prompt](assets/demo.gif)

> **Built for one setup:** Claude Code running in **WSL**, shown in
> **Windows Terminal**, in **normal mode** (the default renderer, not
> fullscreen). You **Ctrl+click** the link. Anywhere else it stays out of the
> way. See [Where it works](#where-it-works).

## Why

Copying a code block out of Claude Code in the terminal is annoying:

- Mouse selection grabs the indent, splits long lines where they wrapped, and
  drags along whatever is next to the block.
- `/copy` copies the last reply (or lets you pick from it), so for a block
  further up you have to count back with `/copy N`.

With this mod every code block gets a small box with a `⧉ copy` link in the
corner. Ctrl+click it and the block is on your clipboard, exactly as written,
no matter how far up it is.

## Install

In Claude Code (terminal):

```
/plugin install copy-button --marketplace GeckoKing9/claude-code-copy-button
```

Answer `y` to add the marketplace and pick the user scope. That's it, it is
active right away. Needs Claude Code 2.1.287 or later (the version that added
mods).

## Where it works

| Setup | Status |
|---|---|
| WSL 2 + Windows Terminal, classic renderer | Yes. Built and tested here. |
| Fullscreen renderer | No. The mod steps aside and the reply is drawn as usual. |
| VS Code terminal, other Windows terminals | No. They open `file:` links their own way. |
| macOS, native Linux | Not yet. The mod draws nothing and runs nothing. |

macOS and Linux would need their own click handler (a file type that runs
`pbcopy`, `wl-copy` or `xclip`). Happy to take a PR from someone who can test
it on a real machine.

## How it works

The classic renderer has no click events. The one click you get is the
terminal's own Ctrl+click on a link. So:

1. When a reply arrives, each code block is saved to
   `%LOCALAPPDATA%\claude-copy\<session>\<hash>.ccopy`.
2. The reply is redrawn with a box around each block and a `⧉ copy` link to
   that file.
3. On first run the mod registers a `.ccopy` file type for your Windows user
   (no admin) that runs `copy.vbs` silently. The script puts the file's text on
   the clipboard.

Why a custom extension instead of linking a script: Windows Terminal warns
before opening anything in `PATHEXT` (`.vbs`, `.cmd`...). `.ccopy` isn't in
it, so the click is silent.

Session folders are deleted two days after the session was last used.

## What it touches

Read this before installing anything that runs scripts, including this.

- **Files:** `%LOCALAPPDATA%\claude-copy` (your code blocks, one folder per
  session, and a copy of `copy.vbs`).
- **Registry:** `HKCU\Software\Classes\.ccopy` and
  `HKCU\Software\Classes\ClaudeCopy` (current user only, no admin). Checked
  each session and repaired if something removed it.
- **Commands:** `cmd.exe` once to find `%LOCALAPPDATA%`, `wslpath`,
  `reg.exe` to check the file type each session (and add it when missing),
  `rm` to prune old session folders. All in the background, never while
  Claude Code is drawing or waiting.
- **Network:** none.

`windows/copy.vbs` is 22 lines and only copies `.ccopy` files from its own
folder, so a stray `.ccopy` file from a download or a web page can't replace
your clipboard. Errors go to the Claude Code debug log (`claude --debug`).

Heads up: Microsoft is phasing VBScript out of Windows. If it gets removed on
your machine the click stops working until the script is replaced.

## Uninstall

1. `/plugin uninstall copy-button`
2. Remove the file type and the files (from WSL):

   ```
   reg.exe delete 'HKCU\Software\Classes\.ccopy' /f
   reg.exe delete 'HKCU\Software\Classes\ClaudeCopy' /f
   rm -rf "$(wslpath "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")/claude-copy"
   ```

## Known limits

- A reply that **starts** with a code block shows no bullet dot in front of it.
- Markdown that spans a code block (a reference link defined on the other side
  of one, a list item continued with 4+ spaces after one) can render
  differently than without the mod, since the reply is drawn in pieces.
- Right after a session starts, a reply can show for a moment without boxes
  while the mod finds your Windows folder; it redraws as soon as it has.

## Develop

```
git clone https://github.com/GeckoKing9/claude-code-copy-button
claude --plugin-dir ./claude-code-copy-button
claude plugin test ./claude-code-copy-button
```

MIT license.
