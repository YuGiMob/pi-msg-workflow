# pi-msg-workflow

Numbered message and command stores plus configurable improvement workflows for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). `/msg 3` sends a predefined message, `/cmd 1` runs a predefined command, and `/workflow` runs a review loop: a start phase, review rounds with context resets and follow-ups, and a final summary.

## What you get

- `/msg 3` sends message 3 as a follow-up. The store is a plain JSON file, editable with `/change-msg`, `/show-msg`, or the editor.
- `/cmd 1` runs command 1 via `pi.exec`. No shell, just a whitespace split with quoted-argument support.
- `workflow.json` defines any number of numbered workflows (start phase, review loop, finally phase). `/workflow` runs workflow 1, `/workflow 2` runs workflow 2, and `/workflow 2 3` runs three review rounds of workflow 2. `/workflow dry` prints the plan without sending or executing anything.
- `/workflow-edit` opens a three-tab overlay for the workflow, messages, and commands: add, edit, delete, reorder, and undo, with cross-tab reference checks on save.
- An interrupted workflow skips start messages that are already in the session.
- Your copies of the JSON files live in `~/.config/pi-msg-workflow/` and are never overwritten by a package update.

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

The package ships with default messages (`1` to `17`), a default command (`1` = `git add .`), and four workflows.

## Commands

| Command | Description |
| --- | --- |
| `/msg <number>` | Send a predefined message as a follow-up. |
| `/change-msg <number> "<content>"` | Create or update a message (min 5 characters). |
| `/show-msg [number]` | Display a message, or list all messages. |
| `/cmd <number>` | Perform a predefined command. |
| `/change-cmd <number> "<content>"` | Create or update a command (min 5 characters). |
| `/show-cmd [number]` | Display a command, or list all commands. |
| `/workflow [workflow] [rounds]` | Run a workflow (default `1`); `dry` or `--dry-run` prints the resolved plan; `list` lists the configured workflows. |
| `/workflow-edit` | Open the interactive editor. |
| `/workflow-reset` | Reset `workflow.json`, `messages.json`, and `commands.json` to the packaged defaults. |
| `/tree-jump <number>` | Reset the agent's context to the response of message N. |
| `/workflow-stop` | Cancel the running workflow after the current step. |

Commands that take a number offer Tab autocomplete.

## The workflow

`workflow.json` maps workflow numbers to configurations (see [Data location](#data-location)):

```json
{
  "1": {
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
      { "cmd": "1", "onlyIfChanges": true }
    ],
    "finally": [
      { "msg": "8" }
    ]
  },
  "2": {
    "rounds": 2,
    "start": [
      { "msg": "1" },
      { "msg": "9" },
      { "msg": "10" },
      { "msg": "11" }
    ],
    "loop": [
      { "tree": "1" },
      { "cmd": "1" },
      { "msg": "12" },
      { "msg": "13" },
      { "msg": "14", "onlyIfChanges": true },
      { "cmd": "1", "onlyIfChanges": true }
    ],
    "finally": [
      { "msg": "15" }
    ]
  }
}
```

`/workflow` runs the default workflow 3, `/workflow 1` runs workflow 1, and `/workflow 2 3` runs workflow 2 with three review rounds. `dry` or `--dry-run` prints the resolved plan for the selected workflow. `list` prints all configured workflows with their rounds and step counts. A number that is not in `workflow.json` is rejected with `Workflow N does not exist.` Create it with `/workflow-edit` (press `w`).

### The default workflow (3)

Workflow 3 is the default: with `rounds` set to 4, each round starts with a `{ "tree": "0" }` step that starts a new session, runs workflow 4 (online research, adversarial review, implementation, and a commit), starts another new session, and then runs workflow 2 (deduplication, simplification, and bug reduction, which also commits) — so both workflows begin with a fresh read of the codebase and commit after every run (8 commits in a full run).
#### `rounds`

Number of review-loop iterations (default `2`, max `5`). Each loop section repeats `rounds` times. `/workflow <workflow> <n>` overrides it for a single run.

#### `start`
Ordered steps run once before the loop. Each step is `{ "msg": "n" }`, `{ "cmd": "n" }`, or `{ "workflow": "n" }`. msg steps whose text matches the leading user messages of the session are skipped, in order, so a re-run resumes the phase instead of repeating it. The skip stops at the first non-matching user message; cmd and workflow steps always re-run.

#### `loop`

Ordered steps repeated each round. `loop` is the first loop section; additional sections are `loop2`, `loop3`, and so on (up to 5 sections). Sections run sequentially, each repeating `rounds` times. The first step of every section must be a `tree` step; the context reset always happens at the beginning of each section.

| Step | Meaning |
| --- | --- |
| `{ "tree": "1" }` | Reset the agent's context to the response of message 1 (same as `/tree-jump 1`). If the message text is not in the session (e.g. after a compaction), a warning is shown and the context falls back to the response of the first user message. |
| `{ "tree": "0" }` | Start a new session (0 is never a message index): the context resets to the start of the session, so the previous rounds leave the context and the next start phase re-sends its messages (e.g. a fresh read of the codebase). The old rounds stay in the session tree as a branch. Commands and commit steps keep working. |
| `{ "msg": "6" }` | Send message 6 and wait for the turn to finish. |
| `{ "msg": "5", "onlyIfChanges": true }` | Send message 5 only when `git status --porcelain` shows changes. |
| `{ "cmd": "1" }` | Perform command 1 from the command store. |
| `{ "cmd": "1", "onlyIfChanges": true }` | Perform command 1 only when `git status --porcelain` shows changes. |
| `{ "workflow": "2" }` | Run workflow 2 (its start phase, review rounds, and finally phase) and wait for it to finish. |
| `{ "workflow": "2", "onlyIfChanges": true }` | Run workflow 2 only when `git status --porcelain` shows changes. |
| `{ "commit": true }` | Stage all changes and commit them with the agent's last response as the message when one was requested (e.g. by message 17), falling back to a message derived from the changed files. |

`onlyIfChanges` runs `git status --porcelain` in the project directory, so it requires the project to be a git repository. A msg, cmd, or workflow step with `onlyIfChanges` is skipped when there are no changes.
Message indices refer to the numbered message store: `/msg 6` and `{ "msg": "6" }` address the same message. Command indices refer to the numbered command store: `/cmd 1`, `/change-cmd 1 "git add ."`, and `{ "cmd": "1" }` all address the same command. The default message store is numbered `1` to `17`: `1` to `7` serve workflow 1 (read, improvements, value check, implement, validate, closer look, fix), `9` to `15` serve workflow 2 (combined review, value check, implement, closer look, fix, validate, summarize), `16` serves workflow 4 (online research), and `17` requests the commit message in all default workflows.

#### `finally`

Ordered steps run once after the loop finishes, unless a step fails and `finallyOnError` is not enabled. Each step is `{ "msg": "n" }`, `{ "cmd": "n" }`, or `{ "workflow": "n" }`. All default workflows end with the commit-message request (message 17) followed by a commit step that uses the agent's response as the literal commit message.

#### `finallyOnError`

Optional boolean (default `false`). When enabled, the `finally` phase runs even when a step fails, so the summary still goes out after an aborted workflow. A manual stop with `/workflow-stop` never triggers the `finally` phase.
Command content is split on whitespace; single- and double-quoted arguments are supported (e.g. `git commit -m "fix"`), with `\"` and `\\` escapes inside double quotes. Unterminated quotes are rejected.

Config values that fail validation produce a `[pi-msg-workflow]` warning and fall back to the defaults shown above.

### Contained workflows

A `{ "workflow": "n" }` step runs workflow `n` as a sub-workflow: its start phase, its loop sections, and its finally phase, with its own configured `rounds`. The sub-workflow's start phase skips messages that are already in the session, just like the top-level start phase. A failure inside the sub-workflow aborts the parent workflow; the sub-workflow's own `finallyOnError` decides whether its finally phase still runs, and the parent's `finallyOnError` decides whether the parent's finally phase runs. `/workflow-stop` cancels the whole chain after the current step.

Workflows can contain each other to any depth, but circular references are rejected: the editor refuses to save a workflow that would create a cycle, and `/workflow` refuses to run a workflow whose graph contains a cycle. A workflow step that references a workflow that does not exist is rejected like a missing message or command.

### Workflow 2: deduplication, simplification, bug reduction

Workflow 2 is a focused review loop over duplicated logic, unnecessary complexity, and bug risks. It shares the read-the-codebase step (message 1) with workflow 1 and runs the whole review in one message before the value check and implementation:

| Step | Meaning |
| --- | --- |
| `{ "msg": "1" }` | Read the entirety of the codebase (shared with workflow 1; skipped when it already matches the leading user messages of the session). |
| `{ "msg": "9" }` | Find duplicated logic (the same pattern repeated three or more times, or two substantial structurally identical blocks, that should be extracted into shared helpers), unnecessary complexity (over-engineering, dead code, redundant branches), and bug risks (edge cases, missing error handling, off-by-one errors, race conditions, resource leaks) in one pass. |
| `{ "msg": "10" }` | Value check: are the deduplication, simplification, and bug-reduction changes actually worth implementing? |
| `{ "msg": "11" }` | Implement all of the changes worth implementing. |
| `{ "msg": "12" }` | Take a closer look at all of the changes via `git diff --staged`. |
| `{ "msg": "13" }` | If the review found any issues with the staged changes, fix them now. |
| `{ "msg": "14", "onlyIfChanges": true }` | Validate the git status and git diff only when there are changes. |
| `{ "cmd": "1", "onlyIfChanges": true }` | Stage the changes only when there are changes. |
| `{ "msg": "15" }` | Summarize all of the changes since the last commit. |

The tree step resets the context to the response of message 1, the shared read-the-codebase step of this workflow. Its finally phase asks for a commit message (message 17) and commits with the agent's response as the literal message.

### Workflow 3: explore, improve, commit, then review

Workflow 3 runs two contained workflows per round: workflow 4 (online research, adversarial review, implementation, and a commit in its finally phase) followed by workflow 2 (deduplication, simplification, and bug reduction, which also commits in its finally phase). Each round starts with a `{ "tree": "0" }` step that starts a new session, and another `{ "tree": "0" }` step runs between the two workflows — so both workflow 4 and workflow 2 begin with a fresh read of the codebase (message 1 is sent again) and each commits its own changes with a message it wrote itself (message 17).

### Workflow 4: online research and adversarial review

Workflow 4 is the exploration workflow contained in workflow 3. Its start phase reads the codebase, searches the web for similar projects with similar features, checks whether the proposed improvements are worth implementing, and implements them. Its loop is the same review loop as workflow 1 (closer look, fix, validate, stage), and its finally phase asks for a commit message (message 17) and commits with the agent's response as the literal message.

## The editor

`/workflow-edit` opens an overlay with three tabs: `[Workflow]` (workflow number, rounds, start/loop/finally steps, tree anchor, add/delete/reorder, if-changes toggle, finally-on-error toggle, workflow switching and deletion), `[Messages]` and `[Commands]` (add, edit, delete store entries). Changes are saved per tab with `s`; closing with unsaved changes asks for confirmation.

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | switch between Workflow, Messages, and Commands tabs |
| `j` / `k` | move selection |
| `e` | edit the selected row (tree anchor, step index, command index, message/command content) |
| `a` | add a row (`msg <n>` / `cmd <n>` / `wf <n>` / `commit` start, loop, or finally step; new message/command) |
| `x` | delete the selected row (on a loop section's tree row: delete that section) |
| `n` | add a new loop section (up to 5) |
| `t` | toggle `onlyIfChanges` on a msg, cmd, or workflow loop step |
| `[` / `]` | decrease / increase rounds |
| `f` | toggle `finallyOnError` (run the finally phase even when a step fails) |
| `u` | undo the last change to the active tab |
| `w` | switch to another workflow (an unused number creates a new workflow on save) |
| `d` | delete the current workflow (type `y` to confirm) |
| `s` | save the active tab |
| `q` / `Esc` | close (asks for confirmation when there are unsaved changes) |

While editing content, `←` / `→` move the cursor, `Home` / `End` jump to the start / end, `Delete` removes the character under the cursor, and `Backspace` removes the character before it. Input longer than the window wraps onto additional lines, so the full content stays visible while you type or paste.

Pressing `e` on a message or command pre-fills the current content with the cursor at the end, so you can edit it in place instead of retyping it; pressing `Enter` without changing anything leaves the tab clean.

The Workflow tab edits one workflow at a time. `w` switches to another workflow number; switching to a number that does not exist yet starts a new workflow which is created when you press `s`. `d` deletes the current workflow after typing `y` to confirm; a workflow still referenced by another workflow cannot be deleted. The tab bar shows the number of the workflow being edited (e.g. `[Workflow 2]`). Saving the Workflow tab refuses indices that reference missing messages, commands, or workflows, so add and save those in the Messages/Commands tabs first (create missing workflows with `w`). Saving is also refused when the save would create a circular workflow reference; break the cycle in the referenced workflow first. Saving the Messages and Commands tabs refuses to delete entries still referenced by any workflow, so drop and save those references in the Workflow tab first. Entries referenced by any workflow are marked with `*N` (the workflow number) in the Messages and Commands tabs. Each loop section's tree step is fixed as the first step of that section; only its anchor index is editable.

While the editor is open, console diagnostics from the extension (for example failed reads or syncs of the config files) are shown as a temporary popup above the editor instead of being lost behind it. The popup dismisses on any key or after a few seconds; further messages queue up until it closes. When you start entering content (`e`, `a`, `w`, `d`), a popup with the input field appears in the center of the screen; `Enter` confirms and `Esc` cancels, and long input wraps onto additional lines inside the popup so everything stays visible. Successful edits (add, edit, delete, move, if-changes toggle, rounds, undo, save, workflow switch) are acknowledged with a confirmation popup, which does not capture keyboard focus so you can keep typing.

## Data location

`workflow.json` (all numbered workflows), `messages.json`, and `commands.json` live in `~/.config/pi-msg-workflow/`. On first use the packaged defaults are copied there; afterwards all reads and writes use the user copies, so updating the package never overwrites your customizations. If you previously edited these files inside the installed package, back them up before updating; npm replaces the package directory.

Each user copy is tracked against the checksum of the packaged default it was synced with. A file that still matches that checksum is considered unmodified: when a package update ships a new default, the user copy is replaced automatically. Once you edit a file, it no longer matches and is never overwritten. For installs that predate this feature, a user copy that differs from the current default is treated as customized and left alone.

## Limitations

- Command content is split on whitespace (single- and double-quoted arguments supported) and executed directly. Pipes, `&&`, `||`, and redirection are not supported; use one command per step or a script.
- Content with double quotes in `/change-msg` and `/change-cmd` must be wrapped in single quotes, e.g. `/change-msg 3 'say "hi"'`. Escaped quotes are only supported inside stored command content, not in the change commands.
- The start phase skips msg steps whose text matches the leading user messages of the session, in order, stopping at the first non-matching user message. A message you typed manually with identical text counts as already sent. cmd steps always re-run.
- `/workflow` refuses to start while another workflow is running. `/workflow-stop` reports when no workflow is running.

## Troubleshooting

- `"Message N does not exist."` Create it with `/change-msg N "content"`, in the editor's Messages tab, or run `/workflow-reset` to restore the default stores.
- `"Workflow N does not exist."` The number is not in `workflow.json`. `/workflow` runs the default workflow 1; create other workflows in the editor with `w` or add them to `workflow.json` directly.
- The workflow refuses to start. Another workflow is running; use `/workflow-stop` to cancel it after the current step.
- The editor refuses to save. The Workflow tab references messages, commands, or workflows that don't exist yet: add and save them in the Messages/Commands tabs first (create missing workflows with `w`). The save would create a circular workflow reference: break the cycle in the referenced workflow first. The Messages/Commands tabs refuse to delete a message or command still referenced by the workflow: drop those references in the Workflow tab first.
- `"Circular workflow reference: 1 → 2 → 1."` A workflow contains itself, directly or indirectly. Break the cycle in the referenced workflow first, then save or run again.
- `onlyIfChanges` never fires. The project is not a git repository, or `git status --porcelain` reports no changes.
- My config changes are ignored. The files live in `~/.config/pi-msg-workflow/`, not inside the installed package. If you edited the packaged copies, back them up and let the user copies sync.
- I want the default workflows back. `/workflow-reset` restores `workflow.json`, `messages.json`, and `commands.json` to the packaged defaults.
- `/tree-jump` says the message is not in the session. The message text must appear verbatim in the session history; send it first with `/msg N`.

## Development

Requires [Node.js](https://nodejs.org) ≥ 22.19 and npm.

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
