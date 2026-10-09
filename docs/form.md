# `donka form`

A decision in Donka declares its **input contract**: the fields it expects, their types, which are
required, and their labels and help in English and French. Analysts edit it in Studio under
**Input fields**, and every release carries it
([artifact format](https://github.com/youmssi/donka/blob/develop/docs/artifact-format.md#input-contracts)).
The Runtime refuses a request that breaks it.

`donka form` lets a team that builds the form in front of a decision start from that contract,
and find out in CI, not in production, the day their form stops matching it.

```bash
export DONKA_URL=https://donka.bank.example
export DONKA_TOKEN=...              # CI token from the project's Settings, read-only

donka form pull --project credit-pme --target env:production
donka form init --contract contracts/retail/scorecard/input.schema.json --lang fr --out forms/scorecard.json
donka form check --contract contracts/retail/scorecard/input.schema.json --form forms/scorecard.json
```

## `donka form pull`

Resolves a target exactly like [`donka pull`](pull.md) (same targets, same token, the checksum
verified the same way, the same exit codes), then writes each decision's contract to
`<out>/<decision key>/input.schema.json`. A decision whose input node declares no fields has no
contract and is skipped.

| Flag             | Env             | Description                                                     |
| ---------------- | --------------- | --------------------------------------------------------------- |
| `-p, --project`  | `DONKA_PROJECT` | Project key or id                                               |
| `-t, --target`   | `DONKA_TARGET`  | Target to resolve (default `main`)                              |
| `-o, --out`      |                 | Output directory (default `contracts`)                          |
| `-d, --decision` |                 | Only this decision; fails when it has no contract in the target |
| `--current`      |                 | The `commit` id from a previous pull; exits `3` when unchanged  |
| `-u, --url`      | `DONKA_URL`     | Studio URL                                                      |
| `--token`        | `DONKA_TOKEN`   | CI token                                                        |
| `--json`         |                 | Print the result as JSON on stdout                              |

## The form definition

A form definition is a **JSON Schema** (draft-07) for the data the form submits: the request's
`context`. Most form libraries take one as is (react-jsonschema-form, JSON Forms, …). A file
that wraps it with the library's own keys, `{ "schema": { … }, "uiSchema": { … } }`, is read too:
only `schema` is compared.

`donka form init` writes a starting definition from a contract. It is the contract itself, with
each field's label and help, in `--lang` (`en` by default, or `fr`), set as the standard `title`
and `description` that form libraries display, and fields sorted by the order set in Studio. It
matches its contract, so it passes `donka form check` until either side changes.

| Flag             | Description                                         |
| ---------------- | --------------------------------------------------- |
| `-c, --contract` | The contract to start from                          |
| `-o, --out`      | File to write (default: print to stdout)            |
| `--lang`         | Language of the titles and descriptions: `en`, `fr` |

## `donka form check`

Compares the form definition with the contract, field by field, at every depth. Fields are named
by their dotted path, `applicant.age`, with `[]` for array items (`loans[].amount`).

| Difference | When                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| `missing`  | The contract has the field, the form does not                                 |
| `unknown`  | The form has a field the contract does not                                    |
| `renamed`  | One field is missing and another of the same type sits in its place (a guess) |
| `type`     | The form submits a type the contract refuses                                  |
| `required` | Required on one side only                                                     |

A form may be stricter than its contract: an `integer` field feeds a contract `number`. Limits,
allowed values and formats are not compared; the Runtime still enforces them.

```text
$ donka form check --contract contracts/loan/input.schema.json --form forms/loan.json
3 difference(s) between the form and the contract:
  applicant.age  contract: integer, form: string
  loan.termMonths  in the contract, not in the form
  loan.purpose  in the form, not in the contract
```

`--json` prints `{ "ok": false, "differences": [{ "field", "kind", "message", "form"? }] }`;
`form` is set on `renamed`, with the form's name for the field.

| Exit code | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `0`       | The form matches the contract                                                |
| `1`       | At least one difference, or a file that cannot be read or is not JSON Schema |
| `2`       | `--contract` or `--form` missing                                             |

## In CI

The GitHub action `actions/form-check` and the GitLab CI and Azure Pipelines form-check templates
pull one decision's contract and check a form against it. See
[CI templates](ci-templates.md#form-checks). Point them at `env:production` to guard what is live,
and at `main` to hear about a release before it is deployed.
