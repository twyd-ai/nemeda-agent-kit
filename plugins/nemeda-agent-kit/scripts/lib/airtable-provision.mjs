// Creates the canonical project base through the Airtable Meta API, so a new
// project starts with the exact tables and field names the kit's hooks and
// skills already speak: Backlog (tasks + PR sync), Team (people), and
// Knowledge Log (/klog and the session logger). One call, no clicking.
//
// Needs a personal access token with `schema.bases:write` (plus data scopes
// for the hooks later) and the target Airtable workspace id (wsp...).

const META_URL = "https://api.airtable.com/v0/meta/bases";

export const CANONICAL_STATUSES = { todo: "Todo", inProgress: "In progress", done: "Done" };

// Field names here are load-bearing: hooks.mjs writes Status/Notes on tasks and
// Entry/Date/Type/AI Tool/AI Model/Status/Summary/Person on the Knowledge Log.
export function canonicalBaseSchema(projectName) {
  return {
    name: projectName,
    tables: [
      {
        name: "Backlog",
        description: "Project plan. PRs link back with an `Airtable: rec...` line in the body.",
        fields: [
          { name: "Name", type: "singleLineText" },
          {
            name: "Status",
            type: "singleSelect",
            options: { choices: [{ name: CANONICAL_STATUSES.todo }, { name: CANONICAL_STATUSES.inProgress }, { name: CANONICAL_STATUSES.done }] }
          },
          { name: "Notes", type: "multilineText" },
          { name: "Priority", type: "singleSelect", options: { choices: [{ name: "High" }, { name: "Medium" }, { name: "Low" }] } },
          { name: "Owner", type: "singleLineText" }
        ]
      },
      {
        name: "Team",
        description: "One row per teammate; the Knowledge Log links here by email.",
        fields: [
          { name: "Name", type: "singleLineText" },
          { name: "Email", type: "email" },
          { name: "Role", type: "singleLineText" }
        ]
      },
      {
        name: "Knowledge Log",
        description: "Shared memory: decisions, findings, and AI session summaries.",
        fields: [
          { name: "Entry", type: "singleLineText" },
          { name: "Date", type: "date", options: { dateFormat: { name: "iso" } } },
          { name: "Type", type: "singleSelect", options: { choices: [{ name: "AI Interaction" }, { name: "Decision" }, { name: "Finding" }, { name: "Meeting" }] } },
          { name: "AI Tool", type: "singleLineText" },
          { name: "AI Model", type: "singleLineText" },
          { name: "Status", type: "singleSelect", options: { choices: [{ name: "Pending" }, { name: "Reviewed" }] } },
          { name: "Summary", type: "multilineText" }
        ]
      }
    ]
  };
}

export async function createCanonicalBase({ apiKey, workspaceId, projectName }) {
  if (!apiKey) throw new Error("AIRTABLE_API_KEY is not set (needs the schema.bases:write scope).");
  if (!/^wsp[a-zA-Z0-9]+$/.test(String(workspaceId || ""))) {
    throw new Error("Pass the Airtable workspace id (wsp...): open airtable.com, the id is in the workspace URL.");
  }
  const schema = canonicalBaseSchema(projectName);
  const response = await fetch(META_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: schema.name, workspaceId, tables: schema.tables })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Airtable ${response.status}: ${JSON.stringify(payload.error || payload)}. A 403 usually means the token lacks schema.bases:write or is not in that workspace.`);
  }
  const tables = Object.fromEntries((payload.tables || []).map((table) => [table.name, table.id]));
  // The session-log hook links entries to people ("Person"). A record link
  // cannot be declared at base creation (it needs the target table id), so it
  // is added as a second call once Team exists.
  const warnings = [];
  if (tables["Knowledge Log"] && tables.Team) {
    const linked = await fetch(`https://api.airtable.com/v0/meta/bases/${payload.id}/tables/${tables["Knowledge Log"]}/fields`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Person", type: "multipleRecordLinks", options: { linkedTableId: tables.Team } })
    });
    if (!linked.ok) {
      const detail = await linked.json().catch(() => ({}));
      warnings.push(`Could not add the Person link field (${linked.status}: ${JSON.stringify(detail.error || detail)}); add it by hand in Airtable.`);
    }
  }
  return { baseId: payload.id, tables, warnings, raw: payload };
}

// The config snippet the caller pastes into .nemeda/agent-kit.json — the CLI
// never edits an existing config itself.
export function airtableConfigSnippet(result) {
  return {
    airtable: {
      baseId: result.baseId,
      tasks: {
        tableId: result.tables.Backlog,
        statusField: "Status",
        notesField: "Notes",
        statusInProgress: CANONICAL_STATUSES.inProgress,
        statusDone: CANONICAL_STATUSES.done
      },
      knowledgeLog: { tableId: result.tables["Knowledge Log"] }
    }
  };
}

// Kept apart from the base so a person row can be added as teammates join.
export async function addTeamMember({ apiKey, baseId, teamTableId, name, email, role }) {
  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${teamTableId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { Name: name, Email: email, ...(role ? { Role: role } : {}) } })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Airtable ${response.status}: ${JSON.stringify(payload.error || payload)}`);
  return { recordId: payload.id };
}
