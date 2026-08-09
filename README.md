# pi-msg-workflow

Numbered message and command stores plus a configurable improvement workflow for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). `/msg 3` sends a predefined message, `/cmd 1` runs a predefined command, and `/workflow` drives the whole loop: a start phase, review rounds of context resets and follow-ups, and a final summary.

## What you get

- **Messages by number.** `/msg 3` sends message 3 as a follow-up. The store is a plain JSON file, editable with `/change-msg`, `/show-msg`, or the editor.
- **Commands by number.** `/cmd 1` runs command 1 via `pi.exec` — no shell, just a whitespace split with quoted-argument support.
- **A configurable workflow.** `workflow.json` defines the start phase, the review loop, and the finally phase. `/workflow 3` runs three review rounds; `/workflow dry` prints the plan without sending or executing anything.
- **An interactive editor.** `/workflow-edit` opens a three-tab overlay for the workflow, messages, and commands: add, edit, delete, reorder, and undo, with cross-tab reference checks on save.
- **Resume where you left off.** An interrupted workflow skips start messages that are already in the session.
- **Customizations that survive updates.** Your copies of the JSON files live in `~/.config/pi-msg-workflow/` and are never overwritten by a package update.

## Quick start

1. Install the extension:

```bash
pi install npm:pi-msg-workflow
```

2. Send a message:

```bash
/msg 1
```

3. Run the workflow:

```bash
/workflow
```

The package ships with default messages (`1`–`8`), commands (`1` = `git add .`), and a workflow, so everything works out of the box.

## Commands

| Command | Description |
| --- | --- |
| `/msg <number>` | Send a predefined message as a follow-up. |
| `/change-msg <number> "<content>"` | Create or update a message (min 5 characters). |
| `/show-msg [number]` | Display a message, or list all messages. |
| `/cmd <number>` | Perform a predefined command. |
| `/change-cmd <number> "<content>"` | Create or update a command (min 5 characters). |
| `/show-cmd [number]` | Display a command, or list all commands. |
| `/workflow [rounds]` | Run the workflow; `dry` or `--dry-run` prints the resolved plan. |
| `/workflow-edit` | Open the interactive editor. |
| `/tree-jump <number>` | Reset the agent's context to the response of message N. |
| `/workflow-stop` | Cancel the running workflow after the current step. |

Commands that take a number offer Tab autocomplete.

## The workflow

The workflow is defined in `workflow.json` (see [Data location](#data-location)):

```json
{
  "rounds": 2,
  "start": [
    { "msg": "1" },
    { "msg": "2" },
    { "msg": "3" },
    { "msg": "4" },
    { "msg": "5" }
  ],
  "loop": [
    { "tree": "1" },
    { "cmd": "1" },
    { "msg": "6" },
    { "msg": "7" },
    { "msg": "5", "onlyIfChanges": true },
    { "cmd": "1" }
  ],
  "finally": [
    { "msg": "8" }
  ]
}
```

### `rounds`

Number of review-loop iterations (default `2`, max `5`). `/workflow <n>` overrides it for a single run.

### `start`

Ordered steps run once before the loop. Each step is `{ "msg": "n" }` or `{ "cmd": "n" }`. msg steps whose text matches the leading user messages of the session are skipped, in order, so a re-run resumes the phase instead of repeating it. The skip stops at the first non-matching user message; cmd steps always re-run.

### `loop`

Ordered steps repeated each round. The first step must be a `tree` step — the context reset always happens at the beginning of the loop.

| Step | Meaning |
| --- | --- |
| `{ "tree": "1" }` | Reset the agent's context to the response of message 1 (same as `/tree-jump 1`). |
| `{ "msg": "6" }` | Send message 6 and wait for the turn to finish. |
| `{ "msg": "5", "onlyIfChanges": true }` | Send message 5 only when `git status --porcelain` shows changes. |
| `{ "cmd": "1" }` | Perform command 1 from the command store. |

`onlyIfChanges` runs `git status --porcelain` in the project directory, so it requires the project to be a git repository.

Message indices refer to the numbered message store — `/msg 6` and `{ "msg": "6" }` address the same message. Command indices refer to the numbered command store — `/cmd 1`, `/change-cmd 1 "git add ."`, and `{ "cmd": "1" }` all address the same command. The default message store is numbered `1`–`8` in workflow order: read, improvements, value check, implement, validate, closer look, fix, summarize.

### `finally`

Ordered steps run once after the loop finishes. Each step is `{ "msg": "n" }` or `{ "cmd": "n" }`. The default config ends with a summary of all changes since the last commit.

Command content is split on whitespace; single- and double-quoted arguments are supported (e.g. `git commit -m "fix"`), with `\"` and `\\` escapes inside double quotes. Unterminated quotes are rejected.

Invalid config values are reported with a `[pi-msg-workflow]` warning and fall back to the defaults shown above.

## The editor

`/workflow-edit` opens an overlay with three tabs: **[Workflow]** (rounds, start/loop/finally steps, tree anchor, add/delete/reorder, if-changes toggle), **[Messages]** and **[Commands]** (add, edit, delete store entries). Changes are saved per tab with `s`; closing with unsaved changes asks for confirmation.

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | switch between Workflow, Messages, and Commands tabs |
| `j` / `k` | move selection |
| `e` | edit the selected row (tree anchor, step index, command index, message/command content) |
| `a` | add a row (`msg <n>` / `cmd <n>` start, loop, or finally step; new message/command) |
| `x` | delete the selected row |
| `J` / `K` | move the selected step up/down (tree step stays first) |
| `t` | toggle `onlyIfChanges` on a msg step |
| `[` / `]` | decrease / increase rounds |
| `u` | undo the last change to the active tab |
| `s` | save the active tab |
| `q` / `Esc` | close (asks for confirmation when there are unsaved changes) |

While editing content, `←` / `→` move the cursor, `Home` / `End` jump to the start / end, `Delete` removes the character under the cursor, and `Backspace` removes the character before it.

Saving the Workflow tab refuses indices that reference missing messages or commands, so add and save those in the Messages/Commands tabs first. Saving the Messages and Commands tabs refuses to delete entries still referenced by the workflow, so drop and save those references in the Workflow tab first. The tree step is fixed as the first loop step — only its anchor index is editable.

## Data location

`workflow.json`, `messages.json`, and `commands.json` live in `~/.config/pi-msg-workflow/`. On first use the packaged defaults are copied there; afterwards all reads and writes use the user copies, so updating the package never overwrites your customizations. If you previously edited these files inside the installed package, back them up before updating — npm replaces the package directory.

Each user copy is tracked against the checksum of the packaged default it was synced with. A file that still matches that checksum is considered unmodified: when a package update ships a new default, the user copy is replaced automatically. Once you edit a file, it no longer matches and is never overwritten. For installs that predate this feature, a user copy that differs from the current default is treated as customized and left alone.

## Limitations

- **No shell operators.** Command content is split on whitespace (single- and double-quoted arguments supported) and executed directly — pipes, `&&`, `||`, and redirection are not supported. Use one command per step or a script.
- **Quotes in `/change-msg` and `/change-cmd`.** Content containing double quotes must be wrapped in single quotes, e.g. `/change-msg 3 'say "hi"'`. Escaped quotes are only supported inside stored command content, not in the change commands.
- **Text-based resume.** The start phase skips msg steps whose text matches the leading user messages of the session, in order, stopping at the first non-matching user message. A message you typed manually with identical text counts as already sent. cmd steps always re-run.
- **One workflow at a time.** `/workflow` refuses to start while another workflow is running. `/workflow-stop` reports when no workflow is running.

## Troubleshooting

- **"Message N does not exist."** Create it with `/change-msg N "content"` or in the editor's Messages tab.
- **The workflow refuses to start.** Another workflow is running — use `/workflow-stop` to cancel it after the current step.
- **The editor refuses to save.** The Workflow tab references messages or commands that don't exist yet: add and save them in the Messages/Commands tabs first. The Messages/Commands tabs refuse to delete entries still referenced by the workflow: drop those references in the Workflow tab first.
- **`onlyIfChanges` never fires.** The project is not a git repository, or `git status --porcelain` reports no changes.
- **My config changes are ignored.** The files live in `~/.config/pi-msg-workflow/`, not inside the installed package. If you edited the packaged copies, back them up and let the user copies sync.
- **`/tree-jump` says the message is not in the session.** The message text must appear verbatim in the session history; send it first with `/msg N`.

## Development

Requires [Node.js](https://nodejs.org) ≥ 22.19 and npm.

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
