#!/usr/bin/env python3
"""Claude Code copy button: put a file's text on the X11 CLIPBOARD with no
clipboard tool installed, through libX11 directly (ctypes, standard library
only). Also reaches Wayland desktops through their X11 layer (XWayland), whose
clipboard GNOME and KDE share with Wayland apps.

Like xclip, the clipboard text lives in this process: it forks, owns the
selection in the background and answers paste requests until another program
takes the clipboard. Blocks larger than one X request go out with the INCR
protocol. Exit status: 0 copied, 1 bad usage, 3 no X display or no libX11.
"""
import ctypes
import ctypes.util
import os
import sys
from ctypes import POINTER, Structure, Union, byref, c_char_p, c_int, c_long, c_uint, c_ulong, c_void_p

Window = Atom = Time = c_ulong

SELECTION_CLEAR, SELECTION_REQUEST, SELECTION_NOTIFY, PROPERTY_NOTIFY = 29, 30, 31, 28
PROPERTY_CHANGE_MASK = 1 << 22
PROP_MODE_REPLACE, PROP_MODE_APPEND = 0, 2
PROPERTY_DELETE = 1
XA_ATOM, XA_INTEGER, XA_STRING = 4, 19, 31


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
    name = ctypes.util.find_library("X11") or "libX11.so.6"
    try:
        x = ctypes.cdll.LoadLibrary(name)
    except OSError:
        return None
    x.XOpenDisplay.argtypes, x.XOpenDisplay.restype = [c_char_p], c_void_p
    x.XDefaultRootWindow.argtypes, x.XDefaultRootWindow.restype = [c_void_p], Window
    x.XCreateSimpleWindow.argtypes = [c_void_p, Window, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
    x.XCreateSimpleWindow.restype = Window
    x.XInternAtom.argtypes, x.XInternAtom.restype = [c_void_p, c_char_p, c_int], Atom
    x.XSetSelectionOwner.argtypes = [c_void_p, Atom, Window, Time]
    x.XGetSelectionOwner.argtypes, x.XGetSelectionOwner.restype = [c_void_p, Atom], Window
    x.XNextEvent.argtypes = [c_void_p, POINTER(XEvent)]
    x.XChangeProperty.argtypes = [c_void_p, Window, Atom, Atom, c_int, c_int, c_void_p, c_int]
    x.XSendEvent.argtypes = [c_void_p, Window, c_int, c_long, POINTER(XEvent)]
    x.XSelectInput.argtypes = [c_void_p, Window, c_long]
    x.XFlush.argtypes = [c_void_p]
    x.XExtendedMaxRequestSize.argtypes, x.XExtendedMaxRequestSize.restype = [c_void_p], c_long
    x.XMaxRequestSize.argtypes, x.XMaxRequestSize.restype = [c_void_p], c_long
    return x


# A requestor that vanished mid-transfer raises BadWindow; ignore it instead of
# letting Xlib's default handler kill the process.
ERROR_HANDLER = ctypes.CFUNCTYPE(c_int, c_void_p, c_void_p)(lambda d, e: 0)


class Owner:
    def __init__(self, x, dpy, text):
        self.x, self.dpy = x, dpy
        self.utf8 = text.encode("utf-8")
        self.latin1 = text.encode("latin-1", "replace")
        atom = lambda n: x.XInternAtom(dpy, n.encode(), 0)
        self.clipboard, self.targets, self.timestamp = atom("CLIPBOARD"), atom("TARGETS"), atom("TIMESTAMP")
        self.incr, self.utf8_string = atom("INCR"), atom("UTF8_STRING")
        self.formats = {
            self.utf8_string: (self.utf8_string, self.utf8),
            atom("text/plain;charset=utf-8"): (atom("text/plain;charset=utf-8"), self.utf8),
            atom("text/plain"): (atom("text/plain"), self.utf8),
            atom("TEXT"): (self.utf8_string, self.utf8),
            XA_STRING: (XA_STRING, self.latin1),
        }
        size = x.XExtendedMaxRequestSize(dpy) or x.XMaxRequestSize(dpy)
        self.chunk = max(4096, size * 4 - 1024)
        self.window = x.XCreateSimpleWindow(dpy, x.XDefaultRootWindow(dpy), 0, 0, 1, 1, 0, 0, 0)
        self.transfers = {}  # (requestor, property) -> [type, data, offset]

    def own(self):
        """Takes the CLIPBOARD with a real server timestamp (ICCCM), not CurrentTime."""
        x, ev = self.x, XEvent()
        x.XSelectInput(self.dpy, self.window, PROPERTY_CHANGE_MASK)
        x.XChangeProperty(self.dpy, self.window, self.timestamp, XA_STRING, 8, PROP_MODE_APPEND, None, 0)
        while True:
            x.XNextEvent(self.dpy, byref(ev))
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

    def answer(self, req):
        x, prop = self.x, req.property or req.target  # obsolete clients send no property
        if req.selection != self.clipboard or (req.time and req.time < self.time):
            return self.notify(req, 0)
        if req.target == self.targets:
            atoms = [self.targets, self.timestamp, *self.formats]
            arr = (c_ulong * len(atoms))(*atoms)
            x.XChangeProperty(self.dpy, req.requestor, prop, XA_ATOM, 32, PROP_MODE_REPLACE, arr, len(atoms))
        elif req.target == self.timestamp:
            t = c_ulong(self.time)
            x.XChangeProperty(self.dpy, req.requestor, prop, XA_INTEGER, 32, PROP_MODE_REPLACE, byref(t), 1)
        elif req.target in self.formats:
            kind, data = self.formats[req.target]
            if len(data) <= self.chunk:
                x.XChangeProperty(self.dpy, req.requestor, prop, kind, 8, PROP_MODE_REPLACE, data, len(data))
            else:
                # INCR: announce the size, then one chunk per property deletion.
                x.XSelectInput(self.dpy, req.requestor, PROPERTY_CHANGE_MASK)
                n = c_ulong(len(data))
                x.XChangeProperty(self.dpy, req.requestor, prop, self.incr, 32, PROP_MODE_REPLACE, byref(n), 1)
                self.transfers[(req.requestor, prop)] = [kind, data, 0]
        else:
            return self.notify(req, 0)
        self.notify(req, prop)

    def send_chunk(self, pev):
        key = (pev.window, pev.atom)
        if pev.state != PROPERTY_DELETE or key not in self.transfers:
            return
        kind, data, offset = self.transfers[key]
        piece = data[offset:offset + self.chunk]
        self.x.XChangeProperty(self.dpy, pev.window, pev.atom, kind, 8, PROP_MODE_REPLACE, piece, len(piece))
        if piece:
            self.transfers[key][2] = offset + len(piece)
        else:  # the empty write ends the transfer
            del self.transfers[key]
            self.x.XSelectInput(self.dpy, pev.window, 0)

    def serve(self):
        x, ev, owning = self.x, XEvent(), True
        while owning or self.transfers:
            x.XNextEvent(self.dpy, byref(ev))
            if ev.type == SELECTION_REQUEST:
                self.answer(ev.xselectionrequest)
            elif ev.type == PROPERTY_NOTIFY:
                self.send_chunk(ev.xproperty)
            elif ev.type == SELECTION_CLEAR and ev.xselectionclear.selection == self.clipboard:
                owning = False  # finish any transfer in flight, then leave
            x.XFlush(self.dpy)


def main(argv):
    if len(argv) != 2:
        return 1
    with open(argv[1], encoding="utf-8", errors="replace") as f:
        text = f.read()
    x = load_x11()
    if x is None or not os.environ.get("DISPLAY"):
        return 3
    x.XSetErrorHandler(ERROR_HANDLER)
    ready_r, ready_w = os.pipe()
    if os.fork():  # the parent reports whether the child took the clipboard
        os.close(ready_w)
        ok = os.read(ready_r, 1) == b"1"
        return 0 if ok else 3
    os.close(ready_r)
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    dpy = x.XOpenDisplay(None)
    owner = Owner(x, dpy, text) if dpy else None
    taken = owner is not None and owner.own()
    os.write(ready_w, b"1" if taken else b"0")
    os.close(ready_w)
    if taken:
        owner.serve()
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
