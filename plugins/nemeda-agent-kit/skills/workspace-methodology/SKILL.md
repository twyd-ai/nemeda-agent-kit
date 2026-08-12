---
name: workspace-methodology
description: "Apply the shared Nemeda methodology to cross-repository or client-project work: confirm exact target, preserve dirty checkouts, separate reusable behavior from project configuration, protect secrets, validate proportionally, and publish only when explicitly requested."
---

# Shared workspace methodology

Use these rules for project work that spans repositories, clients, tools, or evidence
sources.

1. Confirm the exact repository and product target before editing. A parent workspace
   may contain several independent Git repositories and parallel implementations.
2. Inspect branch, remote, and dirty state in the target repository. Parent workspace
   state does not describe nested repositories.
3. Preserve unrelated user changes. Do not reset, clean, checkout, stage, commit,
   push, publish, or deploy beyond the requested scope.
4. Keep reusable workflows in plugin skills and scripts. Keep project identity,
   profiles, and tool requirements in `.nemeda/agent-kit.json`. Keep durable human
   rules in `AGENTS.md`.
5. Use MCP or authorized connectors for live external data. Do not duplicate secrets
   or customer content into repositories, skills, prompts, or generated artifacts.
6. Validate in proportion to risk and distinguish source inspection, local tests,
   build success, remote acceptance, deployed state, and end-user verification.
7. When creating a PR, link project tracking only when the repository configuration
   requires it and the exact record is confirmed.
