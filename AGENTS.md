# Donka CLI — Instructions for coding agents

This file is the single entry point for any coding agent working in this repository. Human
contributors read it too. `CLAUDE.md` imports it and adds what is specific to that tool.

## 1. Read before you write

1. Read this file and `CONTRIBUTING.md`. The full engineering guides live in the Studio repo
   (`youmssi/donka`, `docs/engineering/`); they apply here except where this file says otherwise.
2. Read the story (`DNK-<n>`, in `youmssi/donka` → `docs/backlog/`) in full.
3. Check the story's dependencies are merged. If one is not, **stop and say so**.
4. Search the code for what already exists before you create anything.
5. For a library you are not sure about, read it in `node_modules/<pkg>/`.

## 2. Project overview

- **Product:** Donka is a decision management platform for credit and risk teams. This
  repository is the **Donka CLI**: it pulls release artifacts from Donka Studio into CI/CD
  pipelines and bridges the Studio editor to AI tools over MCP.
- **Origin:** fork of [gorules/cli](https://github.com/gorules/cli) (MIT). The `upstream`
  remote points at it. See `DONKA.md` for what Donka changes (rebrand in DNK-21).
- **Contract:** Studio's `rules-sync` API (DNK-20). Studio merges first when it changes.
- **Stack:** TypeScript, Node 22+, citty, @clack/prompts, rolldown, pnpm. Uses `import type` for
  type-only imports.

## 3. Hard rules

1. **No AI authorship trace, anywhere**, and no `Co-authored-by` line for a tool.
2. **Conventional Commits** with `Refs: DNK-<n>`.
3. **One story, one branch, merged before the next** (`dnk-<n>-<slug>` from `develop`,
   squash-merged). Never commit to `main` or `develop`.
4. **Keep the fork thin** (ADR-006 in Studio): keep upstream's structure; no refactors outside
   the story.
5. **Never print a token.** Tokens come from flags or environment variables and are masked in CI
   templates.
6. **Exit codes are a contract** (`0` ok, `1` error, `2` usage, `3` unchanged, `4` no release).
   Changes are additive.
7. **No dead code**, no commented-out code, no TODO without a ticket.
8. **Stop at an `[INTERACTIVE STEP]`** or any product decision.

## 4. How to work

Small verified steps; prove it works, then say so; report honestly; root-cause failures; build
what the story asks and nothing more.

## 5. Checks before every push

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format
pnpm typecheck
pnpm build
```

CI (`.github/workflows/validate.yml`) runs the same commands and blocks the merge.

## 6. Pull requests

Title = squash commit title. Body follows `.github/pull_request_template.md`. Draft while in
progress; ready when checks are green.

## 7. Releases

`develop` → `main` through a promotion PR merged with a merge commit; release-please's release PR
on `main` then sets the version and `CHANGELOG.md`, tags it, and opens a back-merge PR into
`develop` (merge commit). Nothing is published to npm: the upstream `@gorules/cli` publish job
is removed, and DNK-21 decides how Donka CLI ships.

## 8. Repository map

```
src/main.ts            entry point, command registration (citty)
src/commands/pull.ts   pull a target's artifact (zip or unpacked)
src/commands/mcp.ts    start the MCP bridge
src/api/               HTTP client for rules-sync, artifact download, zip extraction
src/mcp/               MCP server, WebSocket bridge to the editor, logging
actions/pull/          GitHub Action
templates/             GitLab CI and Azure Pipelines templates
DONKA.md               what this fork changes and why
```
