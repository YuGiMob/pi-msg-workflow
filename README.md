# pi-workflow

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that combines two numbered stores — **messages** you send to the agent and **commands** the agent performs — with a fully configurable improvement workflow.

## Features

- **`/msg <number>`** — send a predefined message to the agent as a follow-up.
- **`/change-msg <number> "<content>"`** / **`/show-msg [number]`** — create, update and list messages (min 5 chars).
- **`/cmd <number>`** — perform a predefined command (e.g. `git add .` is executed via `pi.exec`).
- **`/change-cmd <number> "<content>"`** / **`/show-cmd [number]`** — create, update and list commands.
- **`/workflow [rounds]`** — runs the configured workflow: a start phase (analysis messages), then review rounds. The whole sequence is defined in `workflow.json`, so you decide which messages or commands happen when.
- **`/workflow-edit`** — opens an interactive editor overlay with three tabs: **[Workflow]** (rounds, start order, loop steps, tree anchor, add/delete/reorder, if-changes toggle), **[Messages]** and **[Commands]** (add, edit and delete store entries). Changes are saved with `s` (per tab) and closing with unsaved changes asks for confirmation.
- **`/tree-jump <number>`** — resets the agent's context to the response of a predefined message (by its index). The workflow loop always begins with a tree step.
- **`/workflow-stop`** — cancels a running workflow after the current step completes.
- **Start-phase resume.** Messages whose text is already present in the session branch are skipped, so an interrupted workflow continues where it left off.
- **Resilient sends.** Follow-ups are polled until they appear in the session branch (up to 3 attempts) before waiting for idle.
- **Config validation.** Invalid `workflow.json` values are reported and fall back to safe defaults.
- **Autocomplete.** Press Tab after `/msg `, `/cmd ` or `/change-msg ` to pick a number.

## Installation

```bash
pi install npm:pi-msg-workflow
```

The package ships with default `messages.json` (`1`–`7`), `commands.json` (`1` = `git add .`) and `workflow.json`, so `/workflow` works out of the box.

## Usage

```bash
/change-msg 1 "Read the entirety of the codebase"
/msg 1
/change-cmd 1 "git add ."
/cmd 1
/workflow
/workflow 3
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
| `a` | add a row (start index, `send <n>` / `cmd <n>` loop step, new message/command) |
| `x` | delete the selected row |
| `J` / `K` | move the selected step up/down (tree step stays first) |
| `t` | toggle `onlyIfChanges` on a send step |
| `[` / `]` | decrease / increase rounds |
| `s` | save the active tab |
| `q` / `Esc` | close (asks for confirmation when there are unsaved changes) |

Saving the Workflow tab refuses indices that reference missing messages or commands, so add those in the Messages/Commands tabs first. Saving the Messages and Commands tabs refuses to delete entries still referenced by the workflow, so drop those references in the Workflow tab first. The tree step is fixed as the first loop step — only its anchor index is editable.

## Configuration

The workflow is defined in `workflow.json` inside the package:

```json
{
  "rounds": 2,
  "start": ["1", "2", "3", "4", "5"],
  "loop": [
    { "tree": "1" },
    { "cmd": "1" },
    { "send": "6" },
    { "send": "7" },
    { "send": "5", "onlyIfChanges": true },
    { "cmd": "1" }
  ]
}
```

### `rounds`

Number of review-loop iterations (default `2`, max `5`). `/workflow <n>` overrides it for a single run.

### `start`

Ordered list of message indices sent once before the loop begins. Messages whose text is already in the session are skipped, so a re-run resumes the phase instead of repeating it.

### `loop`

Ordered list of steps repeated each round. The **first step must be a `tree` step** — the context reset always happens at the beginning of the loop. Supported steps:

| Step | Meaning |
| --- | --- |
| `{ "tree": "1" }` | Reset the agent's context to the response of message `1` (same as `/tree-jump 1`) |
| `{ "send": "6" }` | Send message `6` and wait for the turn to finish |
| `{ "send": "5", "onlyIfChanges": true }` | Send message `5` only when `git status --porcelain` shows changes |
| `{ "cmd": "1" }` | Perform command `1` from the command store (e.g. `git add .`) |

`onlyIfChanges` runs `git status --porcelain` in the project directory, so it requires the project to be a git repository.
Message indices refer to the numbered message store — `/msg 6` and `{ "send": "6" }` address the same message. Command indices refer to the numbered command store — `/cmd 1`, `/change-cmd 1 "git add ."`, and `{ "cmd": "1" }` all address the same command. The default message store is numbered `1`–`7` in workflow order: read, improvements, value check, implement, validate, closer look, fix. The default command store has `1` = `git add .`.

Command content is split on whitespace; single- and double-quoted arguments are supported (e.g. `git commit -m "fix"`), with `\"` and `\\` escapes inside double quotes. Unterminated quotes are rejected.

Invalid config values are reported with a `[pi-workflow]` warning and fall back to the defaults shown above.

## Development

```bash
npm install
npm run typecheck
npm test
```
