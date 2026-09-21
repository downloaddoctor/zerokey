<memory>
<step1>
every first message:
AGENTS.md present -> read, use as context.
AGENTS.md absent -> generate now, always, from version-control file list.
</step1>

<step2>
update AGENTS.md only if:
files/dirs added/removed/moved
entrypoint or runtime flow changed
module/dependency graph changed
public API/schema/config changed
env vars changed
new integration/extension point added
-> edit only affected section(s), never regenerate whole file.
</step2>

<format>
1 fact = 1 line, no run-ons
1-space indent = hierarchy
arrow = calls/uses/returns
hash = comment
relative paths only, no secrets
never reorder/touch manual notes
</format>

<sections>
required: PROJECT, DIRECTORY, ENTRY-POINTS, MODULES, RUNTIME-GRAPH, SCHEMA, ENV
optional: DEPENDENCIES, PUBLIC-API, CONFIG, BUILD, TESTING, KNOWN-INVARIANTS, EXTENSION-POINTS
</sections>

<content_filter>
per line, before writing:
survives routine refactor -> keep
already stated elsewhere -> cross-reference, don't repeat
describes current state -> keep, describes past state -> replace not append
needed to avoid re-exploring repo -> keep, else -> cut
</content_filter>

<rules>
architecture/relationships only, never implementation detail
preserve public interfaces, boundaries, documented behavior
shortest factual form
never mention AGENTS.md in commit messages
</rules>
</memory>

<save_workflow>
TRIGGER: "save"

1. ⟦cmd¦run=git status --short¦run=git diff --staged¦run=git diff⟧
2. Update AGENTS.md only if stale (step2 rules). Else skip.
3. ⟦cmd¦run=git add -A¦run=git commit -m "[conventional_commit]"⟧
4. Verify the working tree is clean after the commit.
</save_workflow>
