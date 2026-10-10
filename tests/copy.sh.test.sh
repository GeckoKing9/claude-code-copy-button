#!/bin/sh
# Drives linux/copy.sh with fake clipboard tools on PATH; needs no display
# server and no real tool:
#
#   sh tests/copy.sh.test.sh
#
# Each fake tool appends its name and arguments to $FAKE_LOG, keeps what it
# read from stdin next to the log, and fails when FAKE_FAIL names it. python3
# stands in for clip.py: asked --check it says yes.
set -u
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT INT TERM

# The folder copy.sh and the blocks live in, as the mod lays it out.
home="$T/data/claude-copy"
mkdir -p "$home/sess-1" "$T/elsewhere"
cp "$here/../linux/copy.sh" "$home/copy.sh"
: > "$home/clip.py"
block="$home/sess-1/abc.ccopy"
printf 'echo "hi"\r\n  two' > "$block"
printf 'outside' > "$T/elsewhere/out.ccopy"
ln -s "$T/elsewhere/out.ccopy" "$home/sess-1/link.ccopy"
printf 'txt' > "$home/sess-1/not.txt"

# Tool kits: every tool, xsel alone, python3 alone (so clip.py), and nothing
# that can copy: there python3 answers --check with no, as clip.py does with
# no X11 library (the real python3 would otherwise be found on PATH).
fake() {
  cat > "$1" <<'EOF'
#!/bin/sh
name=$(basename "$0")
printf '%s\n' "$name $*" >> "$FAKE_LOG"
n=$(wc -l < "$FAKE_LOG" | tr -d ' ')
case "$name" in wl-copy | xclip | xsel) cat > "$FAKE_LOG.in.$n" ;; esac
case "$name $*" in "python3 "*" --check") exit 0 ;; esac
[ "${FAKE_FAIL:-}" = "$name" ] && exit 1
exit 0
EOF
  chmod 755 "$1"
}
mkdir -p "$T/bin/all" "$T/bin/xsel" "$T/bin/py" "$T/bin/bare"
for tool in wl-copy xclip xsel notify-send python3; do fake "$T/bin/all/$tool"; done
for tool in xsel notify-send python3; do fake "$T/bin/xsel/$tool"; done
for tool in notify-send python3; do fake "$T/bin/py/$tool"; done
fake "$T/bin/bare/notify-send"
printf '#!/bin/sh\nprintf "%%s\\n" "python3 $*" >> "$FAKE_LOG"\nexit 3\n' > "$T/bin/bare/python3"
chmod 755 "$T/bin/bare/python3"

log="$T/log"
# run <kit> [VAR=value ...] command...: $status and $out afterwards.
run() {
  kit=$1
  shift
  : > "$log"
  rm -f "$log".in.*
  env -i PATH="$T/bin/$kit:/usr/bin:/bin" FAKE_LOG="$log" "$@" > "$T/out" 2> "$T/err"
  status=$?
  out=$(cat "$T/out")
}
pass=0
fail=0
check() {
  what=$1
  shift
  if "$@"; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL: %s\n' "$what"; fi
}
logged() { grep -qxF -- "$1" "$log"; }
notlogged() { ! grep -qF -- "$1" "$log"; }
notified() { grep -F -- "$1" "$log" | grep -q '^notify-send '; }
same() { cmp -s "$block" "$log.in.$1"; }
quiet() { [ ! -s "$log" ]; }

# --check: the tool a click would use, or exit 3.
run all sh "$home/copy.sh" --check
check 'check: no display, nothing can copy' [ "$status" = 3 ]
run all DISPLAY=:0 sh "$home/copy.sh" --check
check 'check: X11 with xclip exits 0' [ "$status" = 0 ]
check 'check: X11 with xclip names xclip' [ "$out" = xclip ]
run all WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 sh "$home/copy.sh" --check
check 'check: Wayland comes first' [ "$out" = wl-copy ]
run xsel DISPLAY=:0 sh "$home/copy.sh" --check
check 'check: xsel when it is the only tool' [ "$out" = xsel ]
run py DISPLAY=:0 sh "$home/copy.sh" --check
check 'check: clip.py when no tool is installed' [ "$out" = clip.py ]
check 'check: clip.py was asked' logged "python3 $home/clip.py --check"
run py WAYLAND_DISPLAY=wayland-0 sh "$home/copy.sh" --check
check 'check: Wayland without an X11 layer cannot use clip.py' [ "$status" = 3 ]
run bare DISPLAY=:0 sh "$home/copy.sh" --check
check 'check: nothing at all exits 3' [ "$status" = 3 ]

# A click: the clipboard, then the primary selection, with the exact bytes.
run all WAYLAND_DISPLAY=wayland-0 sh "$home/copy.sh" "$block"
check 'wl-copy: exit 0' [ "$status" = 0 ]
check 'wl-copy: the clipboard, with a text type' logged 'wl-copy --type text/plain'
check 'wl-copy: the primary selection, with a text type' logged 'wl-copy --type text/plain --primary'
check 'wl-copy: the clipboard gets the exact bytes' same 1
check 'wl-copy: the primary selection gets the exact bytes' same 2
run all DISPLAY=:0 sh "$home/copy.sh" "$block"
check 'xclip: exit 0' [ "$status" = 0 ]
check 'xclip: the clipboard' logged 'xclip -selection clipboard -in'
check 'xclip: the primary selection' logged 'xclip -selection primary -in'
check 'xclip: the clipboard gets the exact bytes' same 1
check 'xclip: the primary selection gets the exact bytes' same 2
run xsel DISPLAY=:0 sh "$home/copy.sh" "$block"
check 'xsel: the clipboard' logged 'xsel --clipboard --input'
check 'xsel: the primary selection' logged 'xsel --primary --input'
run py DISPLAY=:0 sh "$home/copy.sh" "$block"
check 'clip.py: exit 0' [ "$status" = 0 ]
check 'clip.py: given the block' logged "python3 $home/clip.py $block"

# Only .ccopy files in the script's own folder are copied.
run all DISPLAY=:0 sh "$home/copy.sh" "$T/elsewhere/out.ccopy"
check 'a .ccopy outside the folder is refused' [ "$status" = 2 ]
check 'a .ccopy outside the folder runs nothing' quiet
run all DISPLAY=:0 sh "$home/copy.sh" "$home/sess-1/link.ccopy"
check 'a symlink pointing outside is refused' [ "$status" = 2 ]
check 'a symlink pointing outside runs nothing' quiet
run all DISPLAY=:0 sh "$home/copy.sh" "$home/sess-1/not.txt"
check 'another extension in the folder is refused' [ "$status" = 2 ]
run all DISPLAY=:0 sh "$home/copy.sh"
check 'no argument exits 1' [ "$status" = 1 ]

# Failures tell the user what happened.
run all DISPLAY=:0 sh "$home/copy.sh" "$home/sess-1/gone.ccopy"
check 'a pruned block: exit 3' [ "$status" = 3 ]
check 'a pruned block: the notice says it is gone' notified "This block's file is gone"
check 'a pruned block: no tool is run' notlogged 'xclip'
run all DISPLAY=:0 FAKE_FAIL=xclip sh "$home/copy.sh" "$block"
check 'a failing tool: exit 3' [ "$status" = 3 ]
check 'a failing tool: the notice names it' notified 'Copying with xclip failed'
check 'a failing tool: the primary selection is not attempted' notlogged 'xclip -selection primary -in'
run py DISPLAY=:0 FAKE_FAIL=python3 sh "$home/copy.sh" "$block"
check 'clip.py failing: the notice names it' notified 'Copying with clip.py failed'
run bare DISPLAY=:0 sh "$home/copy.sh" "$block"
check 'no tool: exit 3' [ "$status" = 3 ]
check 'no tool: the notice says what to install' notified 'Install wl-clipboard'

printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
