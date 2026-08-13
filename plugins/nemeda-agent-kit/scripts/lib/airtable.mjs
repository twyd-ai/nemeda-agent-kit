// Zero-dependency Airtable REST helpers shared by the PR-sync, reconcile, and
// session-log hooks. All identifiers come from .nemeda/agent-kit.json; the
// only secret is AIRTABLE_API_KEY from the gitignored .env.local.

const RECORD_ID = "rec[a-zA-Z0-9]{14}";
// Only ids explicitly labelled as a task (or task-table URLs) count, so an
// unrelated rec id in a PR body (e.g. a Knowledge Log id) is never matched.
const LABELLED_ID = new RegExp(`(?:airtable|task)\\s*[:#=-]?\\s*(${RECORD_ID})`, "gi");
const PR_URL = /https:\/\/github\.com\/[^\s"']+\/pull\/\d+/;

export function extractRecordIds(text, tasksTableId) {
  const found = [];
  for (const match of String(text || "").matchAll(LABELLED_ID)) found.push(match[1]);
  if (tasksTableId) {
    const tableUrl = new RegExp(`airtable\\.com/[^\\s"']*${tasksTableId}/(${RECORD_ID})`, "g");
    for (const match of String(text || "").matchAll(tableUrl)) found.push(match[1]);
  }
  return [...new Set(found)];
}

export function extractPrUrl(...texts) {
  for (const text of texts) {
    const match = PR_URL.exec(String(text || ""));
    if (match) return match[0];
  }
  return "";
}

export function formatShortDate(date = new Date()) {
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}

// Returns a notes-field patch that appends noteLine unless its URL is already there.
export function noteWithPr(notesField, existingNotes, noteLine) {
  const existing = existingNotes || "";
  const url = noteLine.split(": ").pop();
  if (existing.includes(noteLine) || (url && existing.includes(url))) return {};
  return { [notesField]: existing ? `${existing}\n${noteLine}`.trim() : noteLine };
}

async function request(apiKey, url, method = "GET", body = undefined) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Airtable ${response.status} on ${method} ${url.split("/v0/")[1] || url}: ${JSON.stringify(payload.error || payload)}`);
  }
  return payload;
}

export function getRecord(apiKey, baseId, tableId, recordId) {
  return request(apiKey, `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`);
}

export function patchRecord(apiKey, baseId, tableId, recordId, fields) {
  return request(apiKey, `https://api.airtable.com/v0/${baseId}/${tableId}/${recordId}`, "PATCH", { fields });
}

export function createRecord(apiKey, baseId, tableId, fields) {
  return request(apiKey, `https://api.airtable.com/v0/${baseId}/${tableId}`, "POST", { fields });
}
