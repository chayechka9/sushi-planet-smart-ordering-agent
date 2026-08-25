# Sushi Planet — Working Rules for Codex

Read this file, `README.md`, and `PLAN.md` before starting any work in this
repository. Follow the files in this order: `AGENTS.md`, `README.md`, then
`PLAN.md`.

## Scope and safety

- Work only on the task requested for the current session. Do not refactor or
  redesign unrelated parts of the project.
- ChoiceQR remains outside the core architecture unless the user explicitly
  brings it back into scope.
- Do not put secrets, API tokens, customer data, card data, or production
  credentials in tracked files, commit messages, terminal output, or chat.
- `.env` is local only and must never be staged or committed.
- Do not create a real order, charge, payment session, production integration,
  or production Poster action without explicit user approval immediately before
  that external action.

## Required GitHub workflow

For every completed, self-contained change:

1. Check `git status --short --branch` before editing.
2. Implement only the approved scope and run relevant checks (tests,
   typecheck, build, or another suitable verification).
3. Inspect the exact files before staging. Never stage `.env`, `node_modules`,
   `dist`, or unrelated user changes.
4. Stage the verified change, inspect the staged diff, then commit it.
5. Push the commit to the configured GitHub remote.
6. Verify the push by checking status and the current commit against the remote.

Use a concise imperative English commit subject, followed by this body:

```text
Why: <reason for the change>
Result: complete | partial — <what now works and what remains>
Checks: <commands run and their results>
```

At the end of every session, report in Russian:

- what changed;
- why it changed;
- whether the result is complete or partial and what remains;
- checks that passed or failed;
- commit hash and GitHub push status.

If no GitHub remote is configured, authentication is unavailable, checks fail,
or the change is intentionally incomplete, do not pretend it was pushed. State
the precise blocker and leave the repository in a safe state. Never force-push,
change global Git identity, or commit/push when the user explicitly asks for
read-only work or says not to commit.
