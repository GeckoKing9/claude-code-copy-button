#!/bin/sh
# Claude Code copy button (Linux): run through the .ccopy file type with the
# path of a file holding one code block; puts that text on the clipboard.
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
fi
command -v notify-send >/dev/null 2>&1 && notify-send "Claude Code copy button" "Install xclip (X11) or wl-clipboard (Wayland) to copy code blocks."
exit 3
