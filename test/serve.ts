import { startFakeStudio } from './fake-studio.ts';

/** Serves the fake Studio until stopped, for CI to run the GitHub action against. */
const studio = await startFakeStudio(Number(process.argv[2] ?? 4949));
process.stdout.write(`Fake Studio on ${studio.url}\n`);
