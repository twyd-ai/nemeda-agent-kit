// Preloaded before the test run (package.json "test"): points NEMEDA_HOME at
// an empty temporary directory and drops personal overrides, so no test reads
// the developer's own ~/.nemeda — tokens, NEMEDA_MEMORY_AUTHOR, the Slack
// runner registry. A test that needs a personal home still sets NEMEDA_HOME
// itself.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NEMEDA_HOME = mkdtempSync(path.join(tmpdir(), "nemeda-test-home-"));
delete process.env.NEMEDA_MEMORY_AUTHOR;
delete process.env.NEMEDA_MEMORY_TOKEN;
