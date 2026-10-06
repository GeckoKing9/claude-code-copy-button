#!/usr/bin/env python3
"""Claude Code copy button: put a file's text on the X11 CLIPBOARD with no
clipboard tool installed, through libX11 directly (ctypes, standard library
only). Also reaches Wayland desktops through their X11 layer (Xwayland), whose
clipboard GNOME and KDE share with Wayland apps.

Like xclip, the clipboard text lives in this process: it forks, owns the
selection in the background and answers paste requests until another program
takes the clipboard. Large blocks go out with the INCR protocol.

Usage: clip.py FILE    copy FILE's bytes, exactly as they are
       clip.py --check say whether this can copy here (exit 0) or not (3)
Exit status: 0 copied, 1 bad usage, 3 no X display or no libX11,
4 the clipboard could not be taken.
"""
import ctypes
import ctypes.util
import os
import select
import sys
import time
from ctypes import POINTER, Structure, Union, byref, c_char_p, c_int, c_long, c_uint, c_ulong, c_void_p

Window = Atom = Time = c_ulong

SELECTION_CLEAR, SELECTION_REQUEST, SELECTION_NOTIFY, PROPERTY_NOTIFY = 29, 30, 31, 28
PROPERTY_CHANGE_MASK = 1 << 22
PROP_MODE_REPLACE, PROP_MODE_APPEND = 0, 2
PROPERTY_DELETE = 1
ANY_PROPERTY_TYPE, XA_ATOM, XA_INTEGER, XA_STRING = 0, 4, 19, 31
READY_TIMEOUT = 5  # seconds the launcher waits for the clipboard to be taken
STALL_TIMEOUT = 10  # seconds an INCR paste may sit without its next request


class XSelectionRequestEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", c_void_p),
                ("owner", Window), ("requestor", Window), ("selection", Atom), ("target", Atom),
                ("property", Atom), ("time", Time)]


class XSelectionEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", c_void_p),
                ("requestor", Window), ("selection", Atom), ("target", Atom), ("property", Atom),
                ("time", Time)]


class XSelectionClearEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", c_void_p),
                ("window", Window), ("selection", Atom), ("time", Time)]


class XPropertyEvent(Structure):
    _fields_ = [("type", c_int), ("serial", c_ulong), ("send_event", c_int), ("display", c_void_p),
                ("window", Window), ("atom", Atom), ("time", Time), ("state", c_int)]


class XEvent(Union):
    _fields_ = [("type", c_int), ("xselectionrequest", XSelectionRequestEvent),
                ("xselection", XSelectionEvent), ("xselectionclear", XSelectionClearEvent),
                ("xproperty", XPropertyEvent), ("pad", c_long * 24)]


def load_x11():
    for name in (ctypes.util.find_library("X11"), "libX11.so.6"):
        if not name:
            continue
        try:
            x = ctypes.cdll.LoadLibrary(name)
            break
        except OSError:
            continue
    else:
        return None
    x.XOpenDisplay.argtypes, x.XOpenDisplay.restype = [c_char_p], c_void_p
    x.XConnectionNumber.argtypes, x.XConnectionNumber.restype = [c_void_p], c_int
    x.XPending.argtypes, x.XPending.restype = [c_void_p], c_int
    x.XDefaultRootWindow.argtypes, x.XDefaultRootWindow.restype = [c_void_p], Window
    x.XCreateSimpleWindow.argtypes = [c_void_p, Window, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
    x.XCreateSimpleWindow.restype = Window
    x.XInternAtom.argtypes, x.XInternAtom.restype = [c_void_p, c_char_p, c_int], Atom
    x.XSetSelectionOwner.argtypes = [c_void_p, Atom, Window, Time]
    x.XGetSelectionOwner.argtypes, x.XGetSelectionOwner.restype = [c_void_p, Atom], Window
    x.XNextEvent.argtypes = [c_void_p, POINTER(XEvent)]
    x.XChangeProperty.argtypes = [c_void_p, Window, Atom, Atom, c_int, c_int, c_void_p, c_int]
    x.XGetWindowProperty.argtypes = [c_void_p, Window, Atom, c_long, c_long, c_int, Atom, POINTER(Atom),
                                     POINTER(c_int), POINTER(c_ulong), POINTER(c_ulong), POINTER(c_void_p)]
    x.XFree.argtypes = [c_void_p]
    x.XSendEvent.argtypes = [c_void_p, Window, c_int, c_long, POINTER(XEvent)]
    x.XSelectInput.argtypes = [c_void_p, Window, c_long]
    x.XFlush.argtypes = [c_void_p]
    x.XMaxRequestSize.argtypes, x.XMaxRequestSize.restype = [c_void_p], c_long
    return x


# A requestor that vanished mid-transfer raises BadWindow; ignore it instead of
# letting Xlib's default handler kill the process. Stalls are caught by timeouts.
ERROR_HANDLER = ctypes.CFUNCTYPE(c_int, c_void_p, c_void_p)(lambda d, e: 0)


def before(a, b):
    """Whether X server time a is earlier than b, across the 32-bit wrap (~49 days)."""
    return a != b and ((a - b) & 0xFFFFFFFF) >= 0x80000000


class Owner:
    def __init__(self, x, dpy, data):
        self.x, self.dpy, self.data = x, dpy, data
        self.fd = x.XConnectionNumber(dpy)
        atom = lambda n: x.XInternAtom(dpy, n.encode(), 0)
        self.clipboard, self.targets, self.timestamp = atom("CLIPBOARD"), atom("TARGETS"), atom("TIMESTAMP")
        self.multiple, self.atom_pair, self.incr = atom("MULTIPLE"), atom("ATOM_PAIR"), atom("INCR")
        utf8_string = atom("UTF8_STRING")
        # target -> (property type, encoding: None for the bytes as they are)
        self.formats = {
            utf8_string: (utf8_string, None),
            atom("text/plain;charset=utf-8"): (atom("text/plain;charset=utf-8"), None),
            atom("text/plain"): (atom("text/plain"), None),
            atom("TEXT"): (utf8_string, None),
            XA_STRING: (XA_STRING, "latin-1"),
        }
        # Pieces of a quarter of the server's request limit, as xclip does.
        self.chunk = max(4096, x.XMaxRequestSize(dpy))
        self.window = x.XCreateSimpleWindow(dpy, x.XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0)
        self.transfers = {}  # (requestor, property) -> [type, bytes, offset, last activity]
        self.time = 0

    def next_event(self, timeout):
        """The next X event, or None once `timeout` seconds pass (None: wait forever)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self.x.XPending(self.dpy):
            self.x.XFlush(self.dpy)
            left = None if deadline is None else deadline - time.monotonic()
            if left is not None and left <= 0:
                return None
            select.select([self.fd], [], [], left)
        ev = XEvent()
        self.x.XNextEvent(self.dpy, byref(ev))
        return ev

    def own(self):
        """Takes the CLIPBOARD with a real server timestamp (ICCCM), not CurrentTime."""
        x = self.x
        if not self.window:
            return False
        x.XSelectInput(self.dpy, self.window, PROPERTY_CHANGE_MASK)
        x.XChangeProperty(self.dpy, self.window, self.timestamp, XA_STRING, 8, PROP_MODE_APPEND, None, 0)
        deadline = time.monotonic() + READY_TIMEOUT
        while True:
            ev = self.next_event(deadline - time.monotonic())
            if ev is None:
                return False
            if ev.type == PROPERTY_NOTIFY and ev.xproperty.window == self.window:
                self.time = ev.xproperty.time
                break
        x.XSetSelectionOwner(self.dpy, self.clipboard, self.window, self.time)
        x.XFlush(self.dpy)
        return x.XGetSelectionOwner(self.dpy, self.clipboard) == self.window

    def notify(self, req, prop):
        ev = XEvent()
        ev.xselection.type, ev.xselection.display = SELECTION_NOTIFY, req.display
        ev.xselection.requestor, ev.xselection.selection = req.requestor, req.selection
        ev.xselection.target, ev.xselection.property, ev.xselection.time = req.target, prop, req.time
        self.x.XSendEvent(self.dpy, req.requestor, 0, 0, byref(ev))

    def convert(self, requestor, target, prop):
        """Writes `target` to `prop` on `requestor`; False for a target it can't give."""
        x = self.x
        if target == self.targets:
            atoms = [self.targets, self.timestamp, self.multiple, *self.formats]
            arr = (c_ulong * len(atoms))(*atoms)
            x.XChangeProperty(self.dpy, requestor, prop, XA_ATOM, 32, PROP_MODE_REPLACE, arr, len(atoms))
        elif target == self.timestamp:
            t = c_ulong(self.time)
            x.XChangeProperty(self.dpy, requestor, prop, XA_INTEGER, 32, PROP_MODE_REPLACE, byref(t), 1)
        elif target in self.formats:
            kind, encoding = self.formats[target]
            data = self.data if encoding is None else self.data.decode("utf-8", "replace").encode(encoding, "replace")
            if len(data) <= self.chunk:
                x.XChangeProperty(self.dpy, requestor, prop, kind, 8, PROP_MODE_REPLACE, data, len(data))
            else:
                # INCR: announce the size, then one piece per deletion of the property.
                x.XSelectInput(self.dpy, requestor, PROPERTY_CHANGE_MASK)
                n = c_ulong(len(data))
                x.XChangeProperty(self.dpy, requestor, prop, self.incr, 32, PROP_MODE_REPLACE, byref(n), 1)
                self.transfers[(requestor, prop)] = [kind, data, 0, time.monotonic()]
        else:
            return False
        return True

    def convert_multiple(self, requestor, prop):
        """MULTIPLE (ICCCM 2.6.2): a list of (target, property) pairs on `prop`;
        each one converted, and a pair that failed gets its property set to None."""
        x = self.x
        kind, fmt, n, after, items = Atom(), c_int(), c_ulong(), c_ulong(), c_void_p()
        if x.XGetWindowProperty(self.dpy, requestor, prop, 0, 0x7FFFFFFF, 0, ANY_PROPERTY_TYPE, byref(kind),
                                byref(fmt), byref(n), byref(after), byref(items)) != 0 or not items.value:
            return False
        pairs = list(ctypes.cast(items, POINTER(c_ulong * n.value)).contents)
        x.XFree(items)
        for i in range(0, len(pairs) - 1, 2):
            if not self.convert(requestor, pairs[i], pairs[i + 1]):
                pairs[i + 1] = 0
        arr = (c_ulong * len(pairs))(*pairs)
        x.XChangeProperty(self.dpy, requestor, prop, self.atom_pair, 32, PROP_MODE_REPLACE, arr, len(pairs))
        return True

    def answer(self, req):
        prop = req.property or req.target  # obsolete clients send no property
        ok = req.selection == self.clipboard and not (req.time and before(req.time, self.time))
        if ok:
            if req.target == self.multiple:
                ok = req.property != 0 and self.convert_multiple(req.requestor, prop)
            else:
                ok = self.convert(req.requestor, req.target, prop)
        self.notify(req, prop if ok else 0)

    def finish(self, key):
        del self.transfers[key]
        requestor = key[0]
        if not any(r == requestor for r, _ in self.transfers):
            self.x.XSelectInput(self.dpy, requestor, 0)

    def send_chunk(self, pev):
        key = (pev.window, pev.atom)
        if pev.state != PROPERTY_DELETE or key not in self.transfers:
            return
        kind, data, offset, _ = self.transfers[key]
        piece = data[offset:offset + self.chunk]
        self.x.XChangeProperty(self.dpy, pev.window, pev.atom, kind, 8, PROP_MODE_REPLACE, piece, len(piece))
        if piece:
            self.transfers[key][2:] = [offset + len(piece), time.monotonic()]
        else:  # the empty piece ends the transfer
            self.finish(key)

    def serve(self):
        owning = True
        while owning or self.transfers:
            ev = self.next_event(STALL_TIMEOUT if self.transfers else None)
            if ev is None or self.transfers:  # drop pastes whose requestor went quiet
                now = time.monotonic()
                for key in [k for k, t in self.transfers.items() if now - t[3] > STALL_TIMEOUT]:
                    self.finish(key)
            if ev is None:
                continue
            if ev.type == SELECTION_REQUEST:
                self.answer(ev.xselectionrequest)
            elif ev.type == PROPERTY_NOTIFY:
                self.send_chunk(ev.xproperty)
            elif ev.type == SELECTION_CLEAR and ev.xselectionclear.selection == self.clipboard:
                owning = False  # finish the pastes in flight, then leave
            self.x.XFlush(self.dpy)


def daemon(x, data, ready_w):
    """The background owner: detached from the launcher, holds the clipboard."""
    os.setsid()
    os.chdir("/")
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    os.close(null)
    dpy = x.XOpenDisplay(None)
    owner = Owner(x, dpy, data) if dpy else None
    taken = owner is not None and owner.own()
    os.write(ready_w, b"1" if taken else b"0")
    os.close(ready_w)
    if taken:
        owner.serve()
    os._exit(0)


def main(argv):
    if argv[1:] == ["--check"]:
        return 0 if os.environ.get("DISPLAY") and load_x11() else 3
    if len(argv) != 2:
        return 1
    with open(argv[1], "rb") as f:
        data = f.read()
    x = load_x11() if os.environ.get("DISPLAY") else None
    if x is None:
        return 3
    x.XSetErrorHandler(ERROR_HANDLER)
    ready_r, ready_w = os.pipe()
    if os.fork() == 0:
        os.close(ready_r)
        daemon(x, data, ready_w)
    os.close(ready_w)
    ready, _, _ = select.select([ready_r], [], [], READY_TIMEOUT)
    return 0 if ready and os.read(ready_r, 1) == b"1" else 4


if __name__ == "__main__":
    sys.exit(main(sys.argv))
