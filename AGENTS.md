# Codex instructions

Read and follow [CLAUDE.md](CLAUDE.md) in this worktree before working in this repository. It contains the shared
project, architecture, coding, and testing instructions. Keep those instructions there rather than duplicating them here.

## Worktrees

- Perform all edits, dependency installs, generation, builds, and tests in a dedicated Git worktree, including
  documentation changes. A separate branch in the primary checkout is not sufficient isolation.
- Treat the primary local checkout as read-only. If the session starts there, inspect its state and use
  `git worktree list` to identify existing worktrees, then create or select a worktree dedicated to the task before
  making changes. Run subsequent commands from that worktree.
- Preserve existing changes in the primary checkout and other worktrees. Do not stash, reset, clean, or switch
  their branches to prepare your workspace.
- Use one `codex/<topic>` branch per task or PR, based on `main` or the branch a stacked PR builds on.
  This replaces the `claude/<topic>` prefix in CLAUDE.md for Codex; its other Git conventions still apply.
- Keep build outputs and temporary files inside the task worktree. Give subagents the worktree path and require
  them to follow the same isolation rules.
- Report the worktree path and branch when handing off the work.
