// Shared prompt strings used by more than one subsystem.
// Keep each entry here if it is referenced from a route AND a skill
// passthrough (or any other two callers) — inline duplicates drift.

const SUMMARIZE_CONVERSATION =
  'Please write a concise but complete summary of this entire conversation — so it can be pasted into a fresh session to resume work seamlessly.'

// (kept as a single exported string; prettier wants the line break style below)

module.exports = { SUMMARIZE_CONVERSATION }
