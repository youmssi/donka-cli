import { defineCommand } from 'citty';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pc from 'picocolors';
import { CliError, resolveApiOptions } from '../api/client';
import { atomicWriteFile, safeJoin } from '../api/extract';
import { EXIT_NO_CHANGE, fetchArtifact } from '../api/release';
import { readZip } from '../api/zip';
import { compare, formFromContract, schemaOf } from '../form/contract';

/** Where Studio writes each decision's contract inside an artifact (DNK-37). */
const CONTRACT_ENTRY = /^\.config\/contracts\/(.+)\/input\.schema\.json$/;
const CONTRACT_FILE = 'input.schema.json';

const readSchema = async (path: string, role: 'contract' | 'form definition'): Promise<Record<string, unknown>> => {
  let text: string;
  try {
    text = await readFile(resolve(process.cwd(), path), 'utf-8');
  } catch {
    throw new CliError(`Cannot read the ${role} "${path}".`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(`The ${role} "${path}" is not valid JSON.`);
  }
  const schema = schemaOf(value);
  if (!schema) {
    throw new CliError(`The ${role} "${path}" is not a JSON Schema for an object (no "properties").`);
  }
  return schema;
};

const formPull = defineCommand({
  meta: {
    name: 'pull',
    description: "Download the input contract of each decision in a target's release",
  },
  args: {
    project: { type: 'string', description: 'Project key or id (env: DONKA_PROJECT)', alias: 'p' },
    target: {
      type: 'string',
      description:
        "Target: 'main' (newest release), 'commit:<release id>', 'release:<version>' or 'env:<staging|production>' (env: DONKA_TARGET)",
      alias: 't',
    },
    out: {
      type: 'string',
      description: `Output directory; each contract is written to <out>/<decision key>/${CONTRACT_FILE}`,
      alias: 'o',
      default: 'contracts',
    },
    decision: { type: 'string', description: 'Only this decision key', alias: 'd' },
    current: {
      type: 'string',
      description:
        "The commit id from a previous pull (release id, or deployment id for 'env:'); exits 3 when unchanged",
    },
    url: { type: 'string', description: 'Donka Studio URL (env: DONKA_URL)', alias: 'u' },
    token: { type: 'string', description: 'CI token from the project settings (env: DONKA_TOKEN)' },
    json: { type: 'boolean', description: 'Print the result as JSON', default: false },
  },
  async run({ args }) {
    const options = resolveApiOptions(args);
    const project = args.project || process.env.DONKA_PROJECT;
    const target = args.target || process.env.DONKA_TARGET || 'main';

    if (!project) {
      throw new CliError('Missing project. Pass --project or set DONKA_PROJECT.', 2);
    }

    const fetched = await fetchArtifact(options, project, target, args.current);

    if (fetched.action === 'no_change') {
      if (args.json) {
        process.stdout.write(JSON.stringify({ action: 'no_change', project, target }) + '\n');
      } else {
        process.stderr.write(pc.dim(`Already up to date (${target}).\n`));
      }
      process.exitCode = EXIT_NO_CHANGE;
      return;
    }

    const { result, buffer, digest, verified } = fetched;
    const contracts = readZip(buffer).flatMap((entry) => {
      const key = CONTRACT_ENTRY.exec(entry.path)?.[1];
      return key && (!args.decision || key === args.decision) ? [{ key, content: entry.content }] : [];
    });

    if (args.decision && contracts.length === 0) {
      throw new CliError(
        `Decision "${args.decision}" has no input contract in "${target}". Check the key, and that its input node declares fields in Studio.`,
      );
    }

    const outDir = resolve(process.cwd(), args.out);
    const files: string[] = [];
    for (const { key, content } of contracts) {
      const file = safeJoin(outDir, `${key}/${CONTRACT_FILE}`);
      await mkdir(dirname(file), { recursive: true });
      await atomicWriteFile(file, content);
      files.push(file);
    }

    const summary = {
      action: 'load' as const,
      project: result.project?.key ?? project,
      target,
      release: result.release?.id,
      version: result.release?.semanticVersion ?? result.release?.version ?? undefined,
      commit: result.commit?.id,
      environment: result.environment?.key ?? undefined,
      sha256: digest,
      verified,
      decisions: contracts.map(({ key }) => key),
      files,
    };

    if (args.json) {
      process.stdout.write(JSON.stringify(summary) + '\n');
      return;
    }

    const label = summary.version ? `${summary.project}@${summary.version}` : `${summary.project} (${target})`;
    if (files.length === 0) {
      process.stderr.write(
        `${pc.yellow('No input contract')} in ${pc.bold(label)}: no decision declares its fields yet.\n`,
      );
    } else {
      process.stderr.write(`${pc.green('Pulled')} ${files.length} contract(s) from ${pc.bold(label)}\n`);
      for (const file of files) {
        process.stderr.write(pc.dim(`  ${file}\n`));
      }
    }
    if (!verified) {
      process.stderr.write(pc.dim('  server sent no checksum; download integrity not verified\n'));
    }
  },
});

const formCheck = defineCommand({
  meta: {
    name: 'check',
    description: 'Check a form definition against an input contract; exits 1 on any difference',
  },
  args: {
    contract: { type: 'string', description: `Input contract, e.g. contracts/<decision>/${CONTRACT_FILE}`, alias: 'c' },
    form: {
      type: 'string',
      description: 'Form definition: a JSON Schema, or an object holding one under "schema"',
      alias: 'f',
    },
    json: { type: 'boolean', description: 'Print the result as JSON', default: false },
  },
  async run({ args }) {
    if (!args.contract || !args.form) {
      throw new CliError('Pass both --contract and --form.', 2);
    }
    const differences = compare(
      await readSchema(args.contract, 'contract'),
      await readSchema(args.form, 'form definition'),
    );

    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: differences.length === 0, differences }) + '\n');
    } else if (differences.length === 0) {
      process.stderr.write(`${pc.green('The form matches the contract.')}\n`);
    } else {
      process.stderr.write(`${pc.red(`${differences.length} difference(s)`)} between the form and the contract:\n`);
      for (const difference of differences) {
        process.stderr.write(`  ${pc.bold(difference.field)}  ${difference.message}\n`);
      }
    }
    if (differences.length > 0) {
      process.exitCode = 1;
    }
  },
});

const formInit = defineCommand({
  meta: {
    name: 'init',
    description: 'Write a starting form definition from an input contract',
  },
  args: {
    contract: { type: 'string', description: `Input contract, e.g. contracts/<decision>/${CONTRACT_FILE}`, alias: 'c' },
    out: { type: 'string', description: 'File to write (default: print to stdout)', alias: 'o' },
    lang: { type: 'string', description: "Language of the labels and help: 'en' or 'fr'", default: 'en' },
  },
  async run({ args }) {
    if (!args.contract) {
      throw new CliError('Pass --contract.', 2);
    }
    if (args.lang !== 'en' && args.lang !== 'fr') {
      throw new CliError(`Unknown language "${args.lang}". Use 'en' or 'fr'.`, 2);
    }
    const form =
      JSON.stringify(formFromContract(await readSchema(args.contract, 'contract'), args.lang), null, 2) + '\n';

    if (!args.out) {
      process.stdout.write(form);
      return;
    }
    const file = resolve(process.cwd(), args.out);
    await mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, Buffer.from(form));
    process.stderr.write(`${pc.green('Wrote')} ${file}\n`);
  },
});

export const form = defineCommand({
  meta: {
    name: 'form',
    description: "Pull decisions' input contracts and check forms against them",
  },
  subCommands: {
    pull: formPull,
    check: formCheck,
    init: formInit,
  },
});
