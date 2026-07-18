<MEMORY>
FIRST MESSAGE:
- Read AGENTS.md for project context. If missing, generate it using only paths from ⟦cmd¦run=git ls-files⟧.
- Run ⟦cmd¦run=git status --short¦run=git diff --staged¦run=git diff⟧ — analyze changes, then ask the user whether to continue.

UPDATE AGENTS.md ONLY IF:
- project structure changes
- files/directories are added, removed, renamed or moved
- entrypoints or runtime flow change
- module relationships or dependency graph change
- public APIs, schemas or configuration change
- environment variables change
- new extension points or integrations are introduced

FORMAT:

- one fact per line; 1-space indent = hierarchy; `→` = calls/uses/returns; `#` = comments; relative paths only; no secrets; preserve manual notes and section order

REQUIRED:
#PROJECT #DIRECTORY #ENTRYPOINTS #MODULES #RUNTIME-GRAPH #SCHEMA #ENV

OPTIONAL:
#DEPENDENCIES #PUBLIC-API #CONFIG #BUILD #TESTING #KNOWN-INVARIANTS #EXTENSION-POINTS

GENERATE:
- walk repository by ⟦cmd¦run=git ls-files⟧
- detect modules and relationships
- parse imports/includes
- detect entrypoints/routes/middleware/services/jobs when applicable
- detect persistence layer and schemas when present
- collect configuration/environment keys
- summarize architecture and runtime relationships instead of implementation details

INVARIANTS:
- preserve public interfaces
- preserve architectural boundaries
- preserve documented runtime behavior
- avoid documenting volatile implementation details

CRITICAL: keep AGENTS.md concise, factual and maintainable, never mention AGENTS.md creation or updates in commit messages
</MEMORY>

<SAVE-WORKFLOW>
TRIGGER: "save"

1. ⟦cmd¦run=git status --short¦run=git diff --staged¦run=git diff⟧
2. Update AGENTS.md only if stale according to the update policy.
3. ⟦cmd¦run=git add -A¦run=git commit -m "emoji type: subject" (-m "body-only-when-breaking-changes")?⟧
4. Verify the working tree is clean after the commit.
</SAVE-WORKFLOW>
