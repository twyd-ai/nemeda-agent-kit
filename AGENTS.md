# Nemeda Agent Kit contributor instructions

- Keep the portable core compatible with the Agent Plugins specification and use
  thin, host-specific adapters for Codex and Claude Code.
- Put reusable methodology in `plugins/nemeda-agent-kit/skills/`; do not fork the
  same instructions into host-specific directories.
- Keep the workspace MCP server read-only. The CLI may create missing bootstrap
  files, but must never overwrite repository guidance or configuration.
- Treat `.nemeda/agent-kit.json` as non-secret routing data. Never add credentials,
  customer records, or copied private documents to examples, tests, or fixtures.
- Use English for versioned artifacts and Spanish when reporting work to Marc.
- Run `npm test` from `plugins/nemeda-agent-kit`, both plugin validators when
  available, and `git diff --check` before publication.
