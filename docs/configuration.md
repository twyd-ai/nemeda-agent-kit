# Repository configuration

The canonical file is `.nemeda/agent-kit.json`.

## Single repository

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "example-project",
    "name": "Example Project"
  },
  "repository": {
    "id": "example-api",
    "role": "backend",
    "profiles": ["python", "fastapi"]
  },
  "context": {
    "instructions": ["AGENTS.md"],
    "documents": ["docs/architecture.md"]
  },
  "tools": {
    "required": ["git", "github"],
    "optional": ["google-drive", "airtable"]
  },
  "policies": {
    "protectSecrets": true,
    "conversationLanguage": "es",
    "artifactLanguage": "en"
  }
}
```

## Parent workspace

Use `workspace.repositories` when one folder coordinates several independent Git
repositories. Each child should eventually have its own configuration when it needs
more specific rules.

```json
{
  "schemaVersion": 1,
  "project": {
    "id": "example-suite",
    "name": "Example Suite"
  },
  "workspace": {
    "repositories": [
      {
        "id": "example-backend",
        "path": "backend",
        "role": "backend",
        "profiles": ["python", "fastapi"]
      },
      {
        "id": "example-frontend",
        "path": "frontend",
        "role": "frontend",
        "profiles": ["typescript", "nextjs"]
      }
    ]
  },
  "context": {
    "instructions": ["AGENTS.md"],
    "documents": []
  },
  "tools": {
    "required": ["git", "github"],
    "optional": []
  },
  "policies": {
    "protectSecrets": true
  }
}
```

## Rules

- Paths are relative to the directory containing `.nemeda/`.
- Instruction files must resolve inside that directory tree.
- `documents` are discoverable references, not automatically injected context.
- Tool names describe required capabilities; authentication remains personal.
- Configuration may contain non-secret IDs, but never credentials or customer data.
