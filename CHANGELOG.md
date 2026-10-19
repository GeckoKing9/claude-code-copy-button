# Changelog

## 0.6.3

- No more "copy-button: its classic.SessionStart hook was skipped" at every
  start on Claude Team and Enterprise accounts. Claude Code's built-in
  `cc-plugin-sec-default` sends classic hook events past installed plugins
  there, so `/resume`, `/clear` and `/branch` never reached the mod and links
  on a resumed conversation's replies opened nothing. The mod now listens for
  the session ending instead, waits for the new session id, then saves; a
  move it misses is saved when the next turn ends.
- Tests: pass on Claude Code 2.1.304, whose test kit stamps each drawn tree
  with the plugin that drew it.

## 0.6.2

- Wayland: blocks that look like Perl, PHP, Ruby or a certificate paste
  correctly (`wl-copy` is told the text is plain text).
- Linux: a data folder path containing `%` no longer breaks every click.
- Linux: `clip.py` refuses a malformed paste request instead of crashing and
  losing the clipboard.
- Linux: a failing clipboard tool is named in the notice, and a link whose
  block was already pruned says so.
- Linux: only a real "nothing can copy" result suggests installing a tool.
- Windows: `copy.vbs` runs `cmd.exe` and `clip.exe` from System32 with
  AutoRun off, so nothing in the working folder or PATH can stand in for them.
- README: what to do when `⧉ copy` shows but Ctrl+click does nothing
  (`FORCE_HYPERLINK=1`).

## 0.6.1

- Linux: a click now fills the primary selection too, so a middle-click or
  Shift+Insert pastes the block, not whatever text was last highlighted.

## 0.6.0

- Linux needs nothing installed: with no `wl-copy`, `xclip` or `xsel`, the
  handler copies with `linux/clip.py`, which owns the clipboard through
  libX11 (Python standard library only): exact bytes, INCR for large blocks,
  MULTIPLE, and it gives up on a paste that stalls.
- Wayland tested in a Weston session, through `wl-copy` and, with no tool,
  through Xwayland.
- If nothing can copy, one notice per session names the install command for
  the system (apt, dnf, pacman, zypper).

## 0.5.0

- Linux desktops: a `.ccopy` file type (shared-mime type plus a hidden
  `.desktop` entry) runs `linux/copy.sh`, which copies with `wl-copy`, `xclip`
  or `xsel`. Tested with a real Ctrl+click on Xubuntu 24.04 (X11,
  xfce4-terminal). Wayland goes through the same handler, untested so far.
- Linux links use the ❐ icon: the default monospace font there has no ⧉.
- SSH sessions, including a forwarded display (`ssh -X`), are left alone.
- A reply drawn while the mod is still finding its folder waits up to 2
  seconds instead of losing its box; a resumed session uses the folder a past
  session found.

## 0.4.1

- README: normal mode and Ctrl+click stated up front.

## 0.4.0

- The engine draws the reply's text (bullet, indent, markdown); the mod only
  boxes the code blocks.
- Nothing runs while drawing; setup, saving and pruning run in the
  background, each step on its own.
- File links escape spaces and parentheses and keep non-ASCII literal; the
  registry is written through `reg.exe` arguments and checked each session.
- `/resume` and `/clear` save the loaded conversation.
- `copy.vbs` only copies `.ccopy` files from its own folder.
