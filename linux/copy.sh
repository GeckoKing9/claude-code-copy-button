#!/bin/sh
# Claude Code copy button (Linux): run through the .ccopy file type with the
# path of a file holding one code block; puts that text on the clipboard with
# wl-copy, xclip or xsel when installed, else with clip.py (libX11, no install).
# It fills both places Linux pastes from: the clipboard (Ctrl+V, Ctrl+Shift+V)
# and the primary selection (middle-click, Shift+Insert).
# Only .ccopy files in this script's own folder are copied, so a stray .ccopy
# file from anywhere else cannot replace the clipboard.
#
# copy.sh --check prints the tool a click would use here and exits 0, or
# exits 3 when nothing can copy; the mod asks this before warning anyone.
home=$(dirname "$(readlink -f "$0")")

# The tool a click uses, in the order it tries them.
backend() {
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wl-copy >/dev/null 2>&1; then
    echo wl-copy
  elif [ -n "${DISPLAY:-}" ] && command -v xclip >/dev/null 2>&1; then
    echo xclip
  elif [ -n "${DISPLAY:-}" ] && command -v xsel >/dev/null 2>&1; then
    echo xsel
  elif [ -n "${DISPLAY:-}" ] && command -v python3 >/dev/null 2>&1 && python3 "$home/clip.py" --check; then
    echo clip.py
  else
    return 3
  fi
}

if [ "${1:-}" = --check ]; then
  backend
  exit
fi

src=$(readlink -f "$1") || exit 1
case "$src" in
  "$home"/*.ccopy) ;;
  *) exit 2 ;;
esac
case "$(backend)" in
  # --type: left to itself wl-copy sniffs the block with xdg-mime and adds the
  # plain-text offers only when the sniffed type looks like text to it. A Perl,
  # PHP or Ruby script or a certificate block sniffs as something else, and a
  # terminal paste of it came back empty.
  wl-copy) wl-copy --type text/plain < "$src" && exec wl-copy --type text/plain --primary < "$src" ;;
  xclip) xclip -selection clipboard -in < "$src" && exec xclip -selection primary -in < "$src" ;;
  xsel) xsel --clipboard --input < "$src" && exec xsel --primary --input < "$src" ;;
  clip.py)
    python3 "$home/clip.py" "$src" && exit 0
    msg="Copying failed. Try the link again." ;;
  *) msg="Nothing here can copy to the clipboard. Install wl-clipboard (Wayland) or xclip (X11)." ;;
esac
command -v notify-send >/dev/null 2>&1 && notify-send "Claude Code copy button" "$msg"
exit 3
