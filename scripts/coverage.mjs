import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CoverageReport } from 'monocart-coverage-reports';
import ts from 'typescript';

/** Keep only this checkout's executable TypeScript, regardless of V8's file URL spelling. */
export function sourceIncluded(value, root) {
  const filename = value.startsWith('file:') ? fileURLToPath(value) : value;
  const name = relative(root, resolve(root, filename)).split(sep).join('/');
  return name.startsWith('src/') && name.endsWith('.ts') && !name.endsWith('.d.ts');
}

/** Remap CLI subprocess coverage and count unexecuted source files as zero. */
export async function reportCoverage(root, raw, output) {
  if (!existsSync(raw) || !readdirSync(raw).some((file) => file.endsWith('.json'))) {
    throw new Error('No CLI subprocess coverage was collected');
  }
  const included = (name) => sourceIncluded(name, root);
  const report = new CoverageReport({
    name: 'Donka CLI business logic',
    baseDir: root,
    outputDir: output,
    entryFilter: (entry) => {
      if (!entry.url.startsWith('file:')) return false;
      const name = relative(root, fileURLToPath(entry.url)).split(sep).join('/');
      return (name.startsWith('dist/') || name.startsWith('coverage/fixtures/')) && /\.[cm]?js$/.test(name);
    },
    sourceFilter: included,
    all: {
      dir: resolve(root, 'src'),
      filter: '**/*.ts',
      transformer: (entry) => {
        const filename = entry.url.startsWith('file:') ? fileURLToPath(entry.url) : entry.url;
        const result = ts.transpileModule(entry.source, {
          fileName: filename,
          compilerOptions: { sourceMap: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        });
        entry.source = result.outputText;
        entry.sourceMap = JSON.parse(result.sourceMapText);
        // Untested entries have no emitted file beside which to resolve a relative map.
        entry.sourceMap.sources = [pathToFileURL(filename).href];
        entry.sourceMap.sourcesContent = [readFileSync(filename, 'utf8')];
      },
    },
    reports: ['v8', 'console-summary', 'json-summary', 'lcovonly'],
  });
  await report.addFromDir(raw);
  const result = await report.generate();
  const summary = JSON.parse(readFileSync(resolve(output, 'coverage-summary.json'), 'utf8'));
  const files = Object.keys(summary).filter((name) => name !== 'total');
  if (!files.length || files.some((name) => !included(name)))
    throw new Error('Coverage report contains no business sources or unexpected files');
  const lines = summary.total?.lines;
  if (!lines || !Number.isSafeInteger(lines.total) || lines.total <= 0 || !Number.isSafeInteger(lines.covered)) {
    throw new Error('Coverage report has no measured executable lines');
  }
  if (lines.covered * 100 < lines.total * 70)
    throw new Error(`CLI business-logic line coverage is below 70% (${lines.covered}/${lines.total})`);
  return result;
}
