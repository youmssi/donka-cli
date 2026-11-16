# Donka CLI — Claude Code instructions

@AGENTS.md

## Claude-specific

- Start every task by reading `AGENTS.md` and the story. Check dependencies are merged first.
- Prettier and ESLint are the style authority. Prefer `interface` for object shapes and
  `function` declarations; `import type` for type-only imports.
- Commit with the repository owner's identity; never add a tool attribution line, a "generated
  with" footer, or a co-author trailer. If a tool appends a footer to a PR, edit it out.
- When a story has an `[INTERACTIVE STEP]`, stop and present the options.
