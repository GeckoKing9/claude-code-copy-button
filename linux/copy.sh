#!/bin/sh
# Claude Code copy button (Linux): run through the .ccopy file type with the
# path of a file holding one code block; puts that text on the clipboard with
# wl-copy, xclip or xsel when installed, else with clip.py (libX11, no install).
# Only .ccopy files in this script's own folder are copied, so a stray .ccopy
# file from anywhere else cannot replace the clipboard.
home=$(dirname "$(readlink -f "$0")")
src=$(readlink -f "$1") || exit 1
case "$src" in
  "$home"/*.ccopy) ;;
  *) exit 2 ;;
esac
if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
  exec wl-copy < "$src"
elif [ -n "${DISPLAY:-}" ] && command -v xclip >/dev/null 2>&1; then
  exec xclip -selection clipboard -in < "$src"
elif [ -n "${DISPLAY:-}" ] && command -v xsel >/dev/null 2>&1; then
  exec xsel --clipboard --input < "$src"
elif [ -n "${DISPLAY:-}" ] && command -v python3 >/dev/null 2>&1 && python3 "$home/clip.py" "$src"; then
  exit 0 # no clipboard tool: clip.py owns the clipboard through libX11 itself
fi
command -v notify-send >/dev/null 2>&1 && notify-send "Claude Code copy button" "Nothing here can copy to the clipboard. Install wl-clipboard (Wayland) or xclip (X11)."
exit 3
