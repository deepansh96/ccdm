Generate or update a comprehensive `project-context.md` document for the current project.

## Steps

1. **Explore the entire project** — Go through everything: all code files, config files, docs, tests, scripts, and anything else that constitutes this project. Understand what it does, how it's structured, and how it works.

2. **Check for existing document** — If `project-context.md` already exists at the project root, read it thoroughly. Compare it against the current state of the project and identify what's outdated, missing, or needs updating. If it doesn't exist, create it from scratch.

3. **Write or update `project-context.md`** at the project root. This file is the entrypoint for any AI coding agent or human engineer starting work on this project. It should be true to the project and include both technical and non-technical context:

   - **Project overview** — What is the project, what is its purpose, who is it for
   - **User flow** — How does a user interact with it, what are the key workflows
   - **Project structure** — Directory layout, what each folder/file does or is supposed to do
   - **Key code files** — What they do, important code snippets, core logic
   - **Technical infrastructure** — Languages, frameworks, libraries, databases, APIs, third-party services
   - **Local development** — How to set up and run the project locally
   - **Environment variables** — What env vars are needed, what they do
   - **Testing setup** — How to run tests, what testing frameworks are used, test structure
   - **Deployment details** — How it's deployed, CI/CD, hosting, build process
   - **Architecture decisions** — Key design decisions and why they were made

   This should be comprehensive but readable. No change history — just the latest state of the project. Include reasoning behind key decisions where relevant.

4. **Update CLAUDE.md** (if it exists or if the project uses Claude Code) — Add an instruction near the top that the model must read `project-context.md` when starting work on this project. Also add an instruction that `project-context.md` must be updated regularly — after features are built, bugs are fixed, or significant changes are made. Updates should reflect the final state, not a changelog, but may note why decisions were taken.

5. **Update AGENTS.md** (if it exists or if the project uses Codex) — Add the same instructions: read `project-context.md` on start, and keep it updated after significant changes.
