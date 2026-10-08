# CI templates

Three ready-made integrations wrap [`donka pull`](pull.md). Each one pulls the artifact and
hands you the result; publishing it is your next step.

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
