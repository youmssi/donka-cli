import { defineCommand } from 'citty';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import pc from 'picocolors';
import { CliError, resolveApiOptions } from '../api/client';
import { atomicWriteFile, extractZipTo } from '../api/extract';
import { EXIT_NO_CHANGE, fetchArtifact } from '../api/release';

export const pull = defineCommand({
  meta: {
    name: 'pull',
    description: "Download a project's release artifact",
  },
  args: {
    project: {
      type: 'string',
      description: 'Project key or id (env: DONKA_PROJECT)',
      alias: 'p',
    },
    target: {
      type: 'string',
      description:
        "Target: 'main' (newest release), 'commit:<release id>', 'release:<version>' or 'env:<staging|production>' (env: DONKA_TARGET)",
      alias: 't',
    },
    out: {
      type: 'string',
      description: 'Output directory',
      alias: 'o',
      default: '.',
    },
    unpack: {
      type: 'boolean',
      description: 'Extract the archive into a directory instead of writing the zip',
      default: false,
    },
    delete: {
      type: 'boolean',
      description:
        'With --unpack: delete files in the destination that are not in the artifact, so the directory mirrors the target exactly. Without it, files the artifact does not carry are preserved',
      default: false,
    },
    name: {
      type: 'string',
      description:
        "Output file name, or sub-directory name with --unpack. Defaults to the project key with no extension, which is what the agent's object storage providers require. Pass '.' with --unpack to extract straight into --out",
    },
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
    if (args.delete && !args.unpack) {
      throw new CliError('--delete only applies when extracting. Add --unpack.', 2);
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

    // Default to the project key with no extension: the agent's object
    // storage providers use the object name verbatim as the project key, so a
    // `.zip` suffix would surface a project literally called "pricing.zip".
    // The agent's local `zip` provider is the opposite and does strip it, so
    // that destination wants an explicit `--name <project>.zip`.
    const projectKey = result.project?.key ?? result.project?.id ?? project;
    const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : projectKey;
    const outDir = resolve(process.cwd(), args.out);
    const written: string[] = [];
    const updated: string[] = [];
    const deleted: string[] = [];

    if (args.unpack) {
      const extracted = await extractZipTo(buffer, resolve(outDir, name), { delete: args.delete });
      written.push(...extracted.written);
      updated.push(...extracted.updated);
      deleted.push(...extracted.deleted);
    } else {
      if (name === '.' || name.endsWith('/')) {
        throw new CliError(`--name "${name}" is not a file name. Use --unpack to extract into a directory.`, 2);
      }
      const file = join(outDir, name);
      await mkdir(dirname(file), { recursive: true });
      await atomicWriteFile(file, buffer);
      written.push(file);
      updated.push(file);
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
      files: written,
      ...(args.unpack && { updated }),
      ...(args.delete && { deleted }),
    };

    if (args.json) {
      process.stdout.write(JSON.stringify(summary) + '\n');
      return;
    }

    const label = summary.version ? `${summary.project}@${summary.version}` : `${summary.project} (${target})`;
    const counts = [
      `${written.length} file(s)`,
      ...(args.unpack ? [`${updated.length} updated`] : []),
      ...(deleted.length > 0 ? [`${deleted.length} removed`] : []),
    ].join(', ');
    process.stderr.write(`${pc.green('Pulled')} ${pc.bold(label)} ${pc.dim(`-> ${counts}`)}\n`);
    if (!summary.verified) {
      process.stderr.write(pc.dim('  server sent no checksum; download integrity not verified\n'));
    }
  },
});
