# Review bar

Failure here means a `copy` link that opens nothing, copies the wrong text, or
breaks the reply around it. Nobody sees an error: the click just does nothing.

- Drawing (`ui.render`) must never run anything. All work goes through `later`.
- Every hook has to work when another plugin sits above it. Check the session
  transcript for "hook was skipped", not just `claude plugin test`.
- Windows blocks are written with CRLF, Linux with LF.

Skip: `assets/`, `LICENSE`, `.claude-plugin/types/` (written by Claude Code).

## Bug classes seen

- A `classic.*` hook that never runs: on Team and Enterprise accounts the
  built-in `cc-plugin-sec-default` sends classic events past installed plugins.
- A wait with a deadline and no second chance. Anything timed needs a later
  path that catches what it missed.
- A test that can't fail: it checks something the code never touches.
- Tests comparing exact tree JSON break when the engine adds a field.
