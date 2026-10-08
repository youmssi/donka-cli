import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32 } from 'node:zlib';

/**
 * Studio's rules-sync API (youmssi/donka, docs/rules-sync.md) over one project
 * with two releases, 1.0.0 live on staging and nothing on production, so every
 * answer the CLI handles can be reached.
 */
export const TOKEN = 'dnk_ci_test-secret-value';
export const PROJECT = { id: 'p-1', key: 'credit-pme' };
export const RELEASES = [
  { id: 'r-1', version: '1.0.0' },
  { id: 'r-2', version: '1.1.0' },
];
export const STAGING = { deployment: 'd-1', release: 'r-1' };

/** A stored (uncompressed) zip, enough for the CLI's reader. */
export const zip = (files: Record<string, string>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const artifact = (release: string, environment?: string): Buffer =>
  zip({
    'loan.json': JSON.stringify({ release }),
    '.config/project.json': JSON.stringify({ key: PROJECT.key, environment: environment ?? null }),
  });

interface Deployment {
  project?: string;
  target?: string;
  alias?: string;
  current?: { commitId?: string | null };
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

const resolve = (deployment: Deployment, tamper: boolean): object => {
  const target = deployment.target ?? 'main';
  const base = { target, alias: deployment.alias };
  if (deployment.project !== PROJECT.key && deployment.project !== PROJECT.id) {
    return { ...base, project: null, action: 'no_access' };
  }
  const project = PROJECT;
  const error = (code: string) => ({ ...base, project, action: 'error', code });
  const [kind, value = ''] = target === 'main' ? ['main'] : target.split(/:(.*)/s);

  let release: (typeof RELEASES)[number] | undefined;
  let environment: string | undefined;
  switch (kind) {
    case 'main':
      release = RELEASES.at(-1);
      break;
    case 'commit':
      release = RELEASES.find((item) => item.id === value);
      if (!release) return error('RELEASE_NOT_FOUND');
      break;
    case 'release':
      release = RELEASES.find((item) => item.version === value.replace(/^v/, ''));
      if (!release) return error('RELEASE_NOT_FOUND');
      break;
    case 'env':
      if (value === 'production') return { ...base, project, action: 'no_release' };
      if (value !== 'staging') return error('INVALID_TARGET');
      release = RELEASES.find((item) => item.id === STAGING.release);
      environment = 'staging';
      break;
    case 'branch':
      return error('UNSUPPORTED_TARGET');
    default:
      return error('INVALID_TARGET');
  }
  if (!release) return { ...base, project, action: 'no_release' };

  const commit = environment ? STAGING.deployment : release.id;
  const answer = {
    ...base,
    project,
    commit: { id: commit, branchId: null, branchName: null },
    release: { id: release.id, name: null, version: release.version, semanticVersion: release.version },
    environment: environment ? { id: 'e-1', key: environment, name: 'Staging' } : undefined,
  };
  if (deployment.current?.commitId === commit) {
    return { ...answer, action: 'no_change' };
  }
  const url = environment
    ? `/rules-sync/artifacts/${project.id}/deployments/${commit}`
    : `/rules-sync/artifacts/${project.id}/releases/${release.id}`;
  const digest = tamper ? '0'.repeat(64) : sha256(artifact(release.id, environment));
  return { ...answer, action: 'load', artifact: { url, sha256: digest } };
};

const body = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};

export interface FakeStudio {
  url: string;
  /** Every request path, to check what the CLI called. */
  calls: string[];
  /** Answers with a checksum the download does not match. */
  tamper: boolean;
  close: () => Promise<void>;
}

export const startFakeStudio = async (port = 0): Promise<FakeStudio> => {
  const state = { calls: [] as string[], tamper: false };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? '';
      state.calls.push(`${request.method ?? ''} ${path}`);
      const json = (status: number, value: object) => {
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      };
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        json(401, { code: 'INVALID_TOKEN', message: 'Invalid token' });
        return;
      }
      if (request.method === 'POST' && path === '/api/v1/rules-sync') {
        const { deployments } = JSON.parse(await body(request)) as { deployments: Deployment[] };
        json(200, { nextPollAt: null, deployments: deployments.map((item) => resolve(item, state.tamper)) });
        return;
      }
      const download = /^\/api\/v1\/rules-sync\/artifacts\/p-1\/(releases|deployments)\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && download) {
        const [, kind, id] = download;
        const release = kind === 'deployments' ? (id === STAGING.deployment ? STAGING.release : undefined) : id;
        if (release && RELEASES.some((item) => item.id === release)) {
          response
            .writeHead(200, { 'content-type': 'application/zip' })
            .end(artifact(release, kind === 'deployments' ? 'staging' : undefined));
          return;
        }
      }
      json(404, { code: 'RELEASE_NOT_FOUND', message: 'Not found' });
    })();
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    get calls() {
      return state.calls;
    },
    get tamper() {
      return state.tamper;
    },
    set tamper(value: boolean) {
      state.tamper = value;
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
};

/** Runs a command without blocking the fake Studio, which shares this process. */
export const spawnAsync = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      done({ code, stdout, stderr });
    });
  });
