# Project Rules

## Starting the Game Server
- **Use Node.js, not Common Lisp**: Always run the game server using the standalone Node.js server (`node server.js`). Do not invoke Common Lisp (`server.lisp` or `/Users/chang/Anitgravity/Ace's/AIAces/ccl/dx86cl64`).
- **Default Version**: Unless specified otherwise, start the server in `tic tac toe expand remove` on port `8086`.
- **Open in Google Chrome**: Whenever starting the server, always open the game URL in Google Chrome automatically (e.g., `open -a "Google Chrome" http://localhost:8086`), and ensure `play-gui.sh` uses `open -a "Google Chrome"` as well.

## Requesting Access Outside the Workspace
- **Trigger the Native Permission Popup**: When you need access to files or directories outside the active workspace (or when a sandboxed command fails with `Operation not permitted`), do not just ask in plain text. Always trigger Antigravity's built-in permission popup above the chat box (e.g., by calling `read_file` on the external path or re-running `run_command` with `BypassSandbox: true`) so the user can select the approval scope directly from the popup.
