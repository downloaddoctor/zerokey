<memory>
First message:
 AGENTS.md exists → read
 missing → scan codebase → write
 structure changed → update

Format:
one fact/line
1-space indent = hierarchy
`→` calls/uses/returns
`#` comment
relative paths only
no secrets

Required:
#PROJECT #DIRECTORY #ENTRYPOINTS #MODULES #RUNTIME-GRAPH #SCHEMA #ENV

Generate: walk tree, parse imports, detect routes/middleware, introspect ORM, collect env keys

Skip: node_modules/ .git/ build/ dist/ .cache/
</memory>

<save_workflow>
Trigger: "save"

1. ⟦cmd¦run=git status && git diff⟧
2. Update AGENTS.md if stale.
3. ⟦cmd¦run=git add -A && git commit -m "<emoji> <type>: <desc>"⟧
</save_workflow>
