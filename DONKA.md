# Donka CLI

Command-line tool for [Donka](https://github.com/youmssi/donka): pull release artifacts into
CI/CD pipelines (GitHub Actions, GitLab CI, Azure Pipelines) and bridge the editor to AI tools
over MCP.

This repository is a fork of [gorules/cli](https://github.com/gorules/cli) (MIT). The upstream
history is preserved; the `upstream` remote points at it. The original license and copyright
notice in `LICENSE` stay as they are.

## What Donka changes (DNK-21)

- The command is `donka`, the package `@donka/cli`; settings are `DONKA_URL`, `DONKA_TOKEN`,
  `DONKA_PROJECT` and `DONKA_TARGET` (the `GORULES_*` names are not kept).
- `pull` talks to Studio's `rules-sync` API under `/api/v1` with a project CI token. The request
  and response keep upstream's shape, and the exit codes are unchanged. Targets are `main`,
  `commit:<release id>`, `release:<version>` and `env:<key>`; Donka has no branches.
- The GitHub action and the GitLab and Azure templates use the Donka names. The webhook payload
  (`GRL_PAYLOAD`) is gone: Studio does not start pipelines, so project and target are set in the
  pipeline.
- Nothing is published to npm. Each GitHub release carries `donka-cli-X.Y.Z.tgz`, which the
  templates run with `npx --package`; `cli-package` points them at a mirror instead.
- `pnpm test` runs the built CLI and each template's script against a fake Studio; CI also runs
  the GitHub action itself.
- The MCP bridge carries Donka's name. Studio's editor does not connect to it yet.
