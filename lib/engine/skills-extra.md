<memory>
FIRST MESSAGE:

- AGENTS.md exists → read it for project context, missing → scan codebase → write AGENTS.md, structure changed → update AGENTS.md
- run ⟦cmd¦run=git --no-pager diff; git status --short; git diff --staged⟧ for working context → analyze → offer to continue

FORMAT: one fact/line; 1-space indent = hierarchy; `→` calls/uses/returns; `#` comment; relative paths only; no secrets
REQUIRED: #PROJECT #DIRECTORY #ENTRYPOINTS #MODULES #RUNTIME-GRAPH #SCHEMA #ENV
GENERATE: walk tree, parse imports, detect routes/middleware, introspect ORM, collect env keys
SKIP: node_modules/ .git/ build/ dist/ .cache/
</memory>

<save_workflow>
TRIGGER: "save"

1. ⟦cmd¦run=git --no-pager diff; git status --short; git diff --staged⟧
2. Update AGENTS.md if stale.
3. ⟦cmd¦run=git add -A; git commit -m "emoji type: subject" (-m "body-only-when-breaking-changes")?⟧
</save_workflow>
