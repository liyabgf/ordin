# Redacted publication repository

This history-free snapshot contains source, tests and general documentation. It excludes local ledgers, incident timelines, machine paths, service tokens, model credentials, databases, work products, user task content and private runtime logs.

Do not commit `.env` files, local state/work directories, SQLite databases or service credentials.

## Repository roles

- `ordin` is the independent source repository used for development and local operations.
- `ordin-public` is the redacted publication repository. Only this repository pushes to `liyabgf/ordin`. The GitHub repository is currently private.
- The two repositories have separate Git directories and histories. Do not copy source Git history or configure the publication remote on the source repository.
- For each update, select a source commit, synchronize tracked files selectively, preserve publication-specific redactions, scan the complete pending diff, and validate in an isolated directory before committing and pushing.
- Local absolute paths and private operational history belong outside this publication repository.
