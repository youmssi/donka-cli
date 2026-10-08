# `donka pull`

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

## Targets

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

## Options

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

## Naming the output

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

## Examples

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

## Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Artifact downloaded                                                    |
| `1`  | Error (refused token, project out of reach, unknown target or release) |
| `2`  | Usage error (missing or invalid arguments)                             |
| `3`  | Nothing to do (`--current` matched what the target resolves to)        |
| `4`  | No release yet, or nothing live on the environment                     |

The token is never printed, in errors included.

See also: [CI templates](ci-templates.md) · [rules-sync API](https://github.com/youmssi/donka/blob/develop/docs/rules-sync.md)
