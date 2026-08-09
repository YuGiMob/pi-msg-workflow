# pi-workflow

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that combines two numbered stores — **messages** you send to the agent and **commands** the agent performs — with a fully configurable improvement workflow.

## Features

- **`/msg <number>`** — send a predefined message to the agent as a follow-up.
- **`/change-msg <number> "<content>"`** / **`/show-msg [number]`** — create, update and list messages (min 5 chars).
- **`/cmd <number>`** — perform a predefined command (e.g. `git add .` is executed via `pi.exec`).
- **`/change-cmd <number> "<content>"`** / **`/show-cmd [number]`** — create, update and list commands.
- **`/workflow [rounds]`** — runs the configured workflow: a start phase (msg/cmd steps), review rounds, and a finally phase. The whole sequence is defined in `workflow.json`, so you decide which messages or commands happen when. `/workflow dry` prints the resolved plan without running it.
- **`/workflow-edit`** — opens an interactive editor overlay with three tabs: **[Workflow]** (rounds, start/loop/finally steps, tree anchor, add/delete/reorder, if-changes toggle), **[Messages]** and **[Commands]** (add, edit and delete store entries). Changes are saved with `s` (per tab) and closing with unsaved changes asks for confirmation.
- **`/tree-jump <number>`** — resets the agent's context to the response of a predefined message (by its index). The workflow loop always begins with a tree step.
- **`/workflow-stop`** — cancels a running workflow after the current step completes.
- **Start-phase resume.** msg steps whose text matches the leading user messages of the session are skipped, so an interrupted workflow continues where it left off.
- **Resilient sends.** Follow-ups are polled until they appear in the session branch (up to 3 attempts) before waiting for idle.
- **Config validation.** Invalid `workflow.json` values are reported and fall back to safe defaults.
- **Autocomplete.** Press Tab after `/msg `, `/cmd ` or `/change-msg ` to pick a number.

## Installation

```bash
pi install npm:pi-msg-workflow
```

The package ships with default `messages.json` (`1`–`8`), `commands.json` (`1` = `git add .`) and `workflow.json`, so `/workflow` works out of the box.

## Usage

```bash
/change-msg 1 "Read the entirety of the codebase"
/msg 1
/change-cmd 1 "git add ."
/cmd 1
/workflow
/workflow 3
/workflow dry
/tree-jump 1
/workflow-edit
/workflow-stop
```

### `/workflow-edit` key map

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | switch between Workflow, Messages and Commands tabs |
| `j` / `k` | move selection |
| `e` | edit the selected row (tree anchor, step index, command index, message/command content) |
| `a` | add a row (`msg <n>` / `cmd <n>` start, loop or finally step, new message/command) |
| `x` | delete the selected row |
| `J` / `K` | move the selected step up/down (tree step stays first) |
| `t` | toggle `onlyIfChanges` on a msg step |
| `[` / `]` | decrease / increase rounds |
| `s` | save the active tab |
| `q` / `Esc` | close (asks for confirmation when there are unsaved changes) |

Saving the Workflow tab refuses indices that reference missing messages or commands, so add and save those in the Messages/Commands tabs first. Saving the Messages and Commands tabs refuses to delete entries still referenced by the workflow, so drop and save those references in the Workflow tab first. The tree step is fixed as the first loop step — only its anchor index is editable.

## Configuration

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

Number of review-loop iterations (default `2`, max `5`). `/workflow <n>` overrides it for a single run. `/workflow dry` (or `/workflow --dry-run`) prints the resolved plan — rounds, start steps, loop steps and finally steps — without sending or executing anything.

### `start`
Ordered list of steps run once before the loop begins. Each step is `{ "msg": "n" }` (send message n) or `{ "cmd": "n" }` (perform command n). msg steps whose text is already in the session are skipped, so a re-run resumes the phase instead of repeating it.

### `loop`

Ordered list of steps repeated each round. The **first step must be a `tree` step** — the context reset always happens at the beginning of the loop. Supported steps:

| Step | Meaning |
| --- | --- |
| `{ "tree": "1" }` | Reset the agent's context to the response of message `1` (same as `/tree-jump 1`) |
| `{ "msg": "6" }` | Send message `6` and wait for the turn to finish |
| `{ "msg": "5", "onlyIfChanges": true }` | Send message `5` only when `git status --porcelain` shows changes |
| `{ "cmd": "1" }` | Perform command `1` from the command store (e.g. `git add .`) |

`onlyIfChanges` runs `git status --porcelain` in the project directory, so it requires the project to be a git repository.
Message indices refer to the numbered message store — `/msg 6` and `{ "msg": "6" }` address the same message. Command indices refer to the numbered command store — `/cmd 1`, `/change-cmd 1 "git add ."`, and `{ "cmd": "1" }` all address the same command. The default message store is numbered `1`–`8` in workflow order: read, improvements, value check, implement, validate, closer look, fix, summarize. The default command store has `1` = `git add .`.

### `finally`

Ordered list of steps run once after the loop finishes. Each step is `{ "msg": "n" }` (send message n) or `{ "cmd": "n" }` (perform command n). The default config ends with a summary of all changes since the last commit.
Command content is split on whitespace; single- and double-quoted arguments are supported (e.g. `git commit -m "fix"`), with `\"` and `\\` escapes inside double quotes. Unterminated quotes are rejected.

Invalid config values are reported with a `[pi-msg-workflow]` warning and fall back to the defaults shown above.

### Data location

`workflow.json`, `messages.json` and `commands.json` live in `~/.config/pi-msg-workflow/`. On first use the packaged defaults are copied there; afterwards all reads and writes use the user copies, so updating the package never overwrites your customizations. If you previously edited these files inside the installed package, back them up before updating — npm replaces the package directory.

Each user copy is tracked against the checksum of the packaged default it was synced with. A file that still matches that checksum is considered unmodified: when a package update ships a new default, the user copy is replaced automatically. Once you edit a file, it no longer matches and is never overwritten. For installs that predate this feature, a user copy that differs from the current default is treated as customized and left alone.

## Limitations

- **No shell operators.** Command content is split on whitespace (single- and double-quoted arguments supported) and executed directly — pipes, `&&`, `||` and redirection are not supported. Use one command per step or a script.
- **Quotes in `/change-msg` and `/change-cmd`.** Content containing double quotes must be wrapped in single quotes, e.g. `/change-msg 3 'say "hi"'`. Escaped quotes are only supported inside stored command content, not in the change commands.
- **Text-based resume.** The start phase skips msg steps whose text matches the leading user messages of the session, in order, stopping at the first non-matching user message. A message you typed manually with identical text counts as already sent. cmd steps always re-run.
- **One workflow at a time.** `/workflow` refuses to start while another workflow is running. `/workflow-stop` reports when no workflow is running.

## Development

```bash
npm install
npm run typecheck
npm test
```
