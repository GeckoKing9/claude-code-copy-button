# Changelog

## 0.6.0

- Linux needs nothing installed: with no `wl-copy`, `xclip` or `xsel`, the
  handler copies with `linux/clip.py`, which owns the clipboard through
  libX11 (Python standard library only), INCR included for large blocks.
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
