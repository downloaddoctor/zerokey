<memory>
<step1>
AGENTS.md exists → read as context
missing → git ls-files; read every file fully, never infer; write AGENTS.md only after full tree read</step1>
<step2>
update only for structure, entrypoint/runtime, module/dependency, API/schema/config/env, integration/extension changes
edit affected sections only; never regenerate</step2>
<format>
1 fact/line
1-space indent = hierarchy
no column padding; single space or ' — ' before value
→ = relationship
# = comment
relative paths; no secrets
preserve hand-edited notes/order verbatim
example:
core/
 db.js — THE write path _writeBill; catalogs; people projection
</format>
<sections>
required: PROJECT DIRECTORY ENTRY-POINTS MODULES ARCHITECTURE SCHEMA ENV
optional: RUNTIME-GRAPH DEPENDENCIES API CONFIG BUILD TESTING INVARIANTS EXTENSIONS
DIRECTORY = folder shape only; MODULES = per-file roles (no overlap)
</sections>
<content>
current architecture only
stable facts > refactor details
deduplicate; cross-reference
replace stale facts; no history
cut obvious/generic/temporary detail
verify facts; never guess
</content>
<rules>
optimize for one-read LLM comprehension
capture only facts that prevent re-exploration
architecture, boundaries, relationships, interfaces — not implementation detail
exact paths/commands when useful
edit affected sections only; never reorder/regenerate unchanged sections
never mention AGENTS.md in commit messages; it rides in an existing commit
</rules>
</memory>

<save_workflow>
TRIGGER: "save"

1. ⟦cmd¦run=git status --short¦run=git diff --staged¦run=git diff⟧
2. Update AGENTS.md only if stale (step2 rules). Else skip.
3. ⟦cmd¦run=git add -A¦run=git commit -m "<emoji> <type>(<scope>): <subject>"⟧
4. Verify the working tree is clean after the commit.
   </save_workflow>
