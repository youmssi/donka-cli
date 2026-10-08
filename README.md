# Donka CLI

Command-line tool for [Donka](https://github.com/youmssi/donka), decision management for credit
and risk teams. `donka pull` brings a project's release artifact from Donka Studio into a CI/CD
pipeline, which then publishes it wherever your Donka Runtime reads it from.

## Installation

Each [GitHub release](https://github.com/youmssi/donka-cli/releases) carries the CLI as
`donka-cli-X.Y.Z.tgz`. It needs Node.js 22 or later and has no runtime dependencies.

```bash
VERSION=0.3.3 # x-release-please-version
PACKAGE="https://github.com/youmssi/donka-cli/releases/download/v$VERSION/donka-cli-$VERSION.tgz"

# Run it once, pinned to a version
npx --yes --package "$PACKAGE" donka --help

# Or install it
npm install -g "$PACKAGE"
donka --help
```

Behind a firewall, copy the `.tgz` to an internal mirror and point `npx --package` (or the
templates' `cli-package` setting) at it.

## Pulling a release into a pipeline

`donka pull` asks Studio's rules-sync API which release a target resolves to, downloads its
artifact and checks it against the SHA-256 Studio published.

```bash
export DONKA_URL=https://donka.bank.example
export DONKA_TOKEN=...              # CI token from the project's Settings, read-only

donka pull --project credit-pme --target env:production --out ./dist
aws s3 cp ./dist/ s3://my-bucket/rules/live/ --recursive
```

A project owner issues the CI token in **Settings → CI tokens** in Studio. It reads one project
only and can be revoked there at any time.

### Targets

| Target                      | Resolves to                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `main` (default)            | the project's newest release                                        |
| `commit:<release id>`       | that release, by its id                                             |
| `release:<version>`         | that release, by its semantic version (`1.4.0` or `v1.4.0`)         |
| `env:<staging\|production>` | what is live on that environment, its Runtime token hashes included |

Donka has releases, not branches: `branch:` targets are refused.

A release pulled outside an environment (`main`, `commit:`, `release:`) lists no Runtime token,
so a Runtime given it refuses every request; it is for pipelines that test or embed the rules.
Pull `env:` to deploy what a Runtime serves.

### Options

| Flag            | Env             | Description                                                                                       |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `-p, --project` | `DONKA_PROJECT` | Project key or id                                                                                 |
| `-t, --target`  | `DONKA_TARGET`  | Target to resolve (default `main`)                                                                |
| `-o, --out`     |                 | Output directory (default `.`)                                                                    |
| `--unpack`      |                 | Extract the archive instead of writing it                                                         |
| `--delete`      |                 | With `--unpack`: delete files not in the artifact so the directory mirrors the target exactly     |
| `--name`        |                 | Output file name (zip) or sub-directory name (dir); defaults to the project key with no extension |
| `--current`     |                 | The `commit` id from a previous pull; exits `3` when unchanged                                    |
| `-u, --url`     | `DONKA_URL`     | Studio URL (`https://studio`, `…/api` and `…/api/v1` all work)                                    |
| `--token`       | `DONKA_TOKEN`   | CI token                                                                                          |
| `--json`        |                 | Print the result as JSON on stdout                                                                |

`--current` takes the `commit` field of a previous `--json` result: the release id for `main`,
`commit:` and `release:`, the deployment id for `env:`. A deployment id changes when a release is
deployed or the environment's Runtime tokens change, so a pipeline republishes in both cases.

### Naming the output

The default writes `<project-key>` with **no** `.zip` suffix, because the Runtime's S3, GCS and
Azure Blob providers use the object name verbatim as the project key: upload `credit-pme.zip` and
the Runtime serves a project literally called `credit-pme.zip`.

The Runtime's local `zip` provider is the opposite -- it reads `<root>/<project>.zip` and strips
the suffix itself -- so that destination needs it back:

```bash
donka pull --project credit-pme --name credit-pme.zip --out ./rules
```

With `--unpack`, `--name` is the sub-directory to extract into (default: the project key, which is
the layout the Runtime's `filesystem` provider expects). Pass `--name .` to extract straight into
`--out`, which is what you want when baking rules into a container image.

Extraction behaves like `aws s3 sync`: byte-identical files are left untouched, changed files are
written atomically (temp file + rename, so a concurrent reader never sees a partial write), and
files the artifact does not carry are preserved. Add `--delete` for `s3 sync --delete` semantics:
the directory mirrors the target exactly, so decisions deleted in Studio are deleted on disk too.
As a guard against wiping a directory it does not own, `--delete` refuses a non-empty destination
that has no `.config/project.json` from a previous pull, and deletions only run after every new
file has been written.

### Examples

Object storage that the Runtime watches -- one archive per project, no extension:

```bash
donka pull --project credit-pme --target env:production --out ./dist
aws s3 cp ./dist/ s3://my-bucket/rules/live/ --recursive
```

A volume the Runtime reads with its `filesystem` provider -- unpacked, one directory per project:

```bash
donka pull --project credit-pme --target env:production --out /srv/rules --unpack
# /srv/rules/credit-pme/...
```

Baked into a test image, pinned to an exact release so the build is reproducible:

```bash
donka pull --project credit-pme --target release:1.4.2 --out ./rules --unpack --name .
# ./rules/*.json + ./rules/.config/project.json, ready for COPY
```

Scheduled job that does nothing when production has not moved:

```bash
donka pull --project credit-pme --target env:production --current "$LAST_COMMIT" --out ./dist
case $? in
  0) aws s3 cp ./dist/ s3://my-bucket/rules/live/ --recursive ;;
  3) echo "unchanged" ;;
  *) exit 1 ;;
esac
```

### Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Artifact downloaded                                                    |
| `1`  | Error (refused token, project out of reach, unknown target or release) |
| `2`  | Usage error (missing or invalid arguments)                             |
| `3`  | Nothing to do (`--current` matched what the target resolves to)        |
| `4`  | No release yet, or nothing live on the environment                     |

The token is never printed, in errors included.

## GitHub Actions

The composite action lives under `actions/` in this repository, so the tag you pin is the
template you get; `cli-version` pins the CLI it runs.

```yaml
jobs:
  rules:
    runs-on: ubuntu-latest
    steps:
      - uses: youmssi/donka-cli/actions/pull@v0.3.3 # x-release-please-version
        id: rules
        with:
          url: https://donka.bank.example
          token: ${{ secrets.DONKA_TOKEN }}
          project: credit-pme
          target: env:production
          out: ./dist

      - name: Deploy
        if: steps.rules.outputs.changed == 'true'
        env:
          PROJECT: ${{ steps.rules.outputs.project }}
        run: aws s3 cp "./dist/$PROJECT" "s3://my-bucket/rules/$PROJECT"
```

| Input         | Required | Description                                                     |
| ------------- | -------- | --------------------------------------------------------------- |
| `url`         | yes      | Studio URL                                                      |
| `token`       | yes      | CI token; pass a secret                                         |
| `project`     | yes      | Project key or id                                               |
| `target`      |          | Target to resolve (default `main`)                              |
| `out`         |          | Output directory (default `.`)                                  |
| `name`        |          | Output file or sub-directory name                               |
| `unpack`      |          | `true` to extract the archive                                   |
| `delete`      |          | With `unpack`, mirror the target exactly (delete stale files)   |
| `current`     |          | The `commit` output of a previous run                           |
| `cli-version` |          | Version of the CLI to run, from its GitHub release              |
| `cli-package` |          | Run this package instead, e.g. the `.tgz` on an internal mirror |

| Output                           | Description                                                     |
| -------------------------------- | --------------------------------------------------------------- |
| `project` / `target`             | What was pulled                                                 |
| `changed`                        | `false` when `current` still matched, so nothing was downloaded |
| `release` / `version` / `commit` | What the target resolved to                                     |
| `sha256`                         | Checksum of the downloaded artifact                             |
| `files`                          | JSON array of paths written                                     |

The token is passed to the CLI as an environment variable rather than an argument, and masked in
the log. `changed` exists so a scheduled workflow can skip the upload when production has not
moved.

## GitLab CI

`templates/gitlab-ci-pull.yml` defines a hidden job you extend:

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/youmssi/donka-cli/v0.3.3/templates/gitlab-ci-pull.yml' # x-release-please-version

pull:rules:
  extends: .donka-pull
  variables:
    DONKA_PROJECT: credit-pme
    DONKA_TARGET: env:production

publish:rules:
  needs: ['pull:rules']
  script:
    # dotenv variables are not visible in rules: (evaluated before jobs run) -
    # gate in script when using scheduled pulls with DONKA_CURRENT
    - aws s3 cp "dist/$RULES_PROJECT" "s3://my-bucket/rules/$RULES_PROJECT"
```

`DONKA_URL` and `DONKA_TOKEN` are CI/CD variables; mask and protect the token. GitLab puts them in
the environment automatically, so nothing else is needed to wire them up. Optional job variables:
`DONKA_TARGET` (default `main`), `DONKA_OUT` (default `dist`), `DONKA_NAME`, `DONKA_CURRENT`,
`DONKA_UNPACK` and `DONKA_DELETE` (both `'false'` by default), `DONKA_CLI_VERSION` and
`DONKA_CLI_PACKAGE`.

The job publishes `RULES_CHANGED`, `RULES_PROJECT`, `RULES_TARGET`, `RULES_VERSION`,
`RULES_RELEASE`, `RULES_COMMIT` and `RULES_SHA256` as a dotenv report, so later jobs read them as
ordinary variables — a deploy job can route on the target (e.g. per-environment buckets) without
parsing anything.

## Azure Pipelines

`templates/azure-pipelines-pull.yml` is a steps template: it pulls the artifact and sets result
variables (`rulesChanged`, `rulesProject`, `rulesTarget`, `rulesVersion`, `rulesRelease`,
`rulesCommit`, `rulesSha256`), and you append your own publish step in the same job:

```yaml
resources:
  repositories:
    - repository: donka
      type: github
      name: youmssi/donka-cli
      ref: refs/tags/v0.3.3 # x-release-please-version
      endpoint: <your GitHub service connection>

jobs:
  - job: deploy_rules
    pool:
      vmImage: ubuntu-latest
    steps:
      - template: templates/azure-pipelines-pull.yml@donka
        parameters:
          url: https://donka.bank.example
          project: credit-pme
          target: env:production

      - script: aws s3 cp "$(Build.ArtifactStagingDirectory)/rules/$(rulesProject)" "s3://my-bucket/rules/$(rulesProject)"
        displayName: Deploy
```

`DONKA_TOKEN` must exist as a secret pipeline variable or in a linked variable group. Azure
DevOps does not map secret variables into the environment automatically, which the template
handles by declaring it explicitly under `env:`. Optional parameters: `out`, `name`, `unpack`,
`delete`, `current`, `cliVersion` and `cliPackage`.

## MCP Bridge

The CLI includes an MCP (Model Context Protocol) bridge that connects AI tools to the decision
editor. Studio's editor does not connect to it yet (planned, see Donka's roadmap); the bridge's
REST endpoints work on their own.

```bash
donka mcp start
```

This starts a local server on `localhost:41919` that:

- Exposes an **MCP endpoint** (`/mcp`) for AI tool integration
- Connects to the editor via **WebSocket**
- Provides **REST endpoints** for evaluating decisions and fetching files

### Options

| Flag         | Description           | Default     |
| ------------ | --------------------- | ----------- |
| `-p, --port` | Server port           | `41919`     |
| `-h, --host` | Server host           | `localhost` |
| `-u, --url`  | Donka Studio URL      | —           |
| `--open`     | Open browser on start | `false`     |

### REST Endpoints

**Evaluate a decision graph:**

```bash
curl -X POST http://localhost:41919/evaluate/my-decision \
  -H "Content-Type: application/json" \
  -d '{"context": {"customer": {"tier": "premium"}, "orderTotal": 150}}'
```

**Retrieve a decision file:**

```bash
curl http://localhost:41919/file/my-decision
```

### AI Tool Configuration

```json
{
  "mcpServers": {
    "donka": {
      "command": "donka",
      "args": ["mcp", "start"]
    }
  }
}
```

## Development

```bash
pnpm install
pnpm dev          # Build and run
pnpm build        # Production build
pnpm test         # Build, then test the CLI and the CI templates against a fake Studio
pnpm lint         # Lint
pnpm format:fix   # Format
```

## License

[MIT](LICENSE). Donka CLI is a fork of [gorules/cli](https://github.com/gorules/cli); see
[`DONKA.md`](DONKA.md).
