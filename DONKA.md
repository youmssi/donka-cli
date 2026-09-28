# Donka CLI

Command-line tool for [Donka](https://github.com/youmssi/donka): pull release artifacts into
CI/CD pipelines (GitHub Actions, GitLab CI, Azure Pipelines) and bridge the editor to AI tools
over MCP.

This repository is a fork of [gorules/cli](https://github.com/gorules/cli) (MIT). The upstream
history is preserved; the `upstream` remote points at it. The original license and copyright
notice in `LICENSE` stay as they are.

## Planned Donka changes (see donka/docs/ROADMAP.md, epic F2)

- Rename the command to `donka` and the package to `@donka/cli`
- `DONKA_URL`, `DONKA_TOKEN`, `DONKA_PROJECT`, `DONKA_TARGET` (the old `GORULES_*` names are not kept)
- Point at Studio's `rules-sync` API (same request and response shape, Donka paths)
- Rebrand the CI templates and the MCP bridge
