# Codex grill prompt — templates

Codex `exec` has no `--system` flag. System rules live in the user prompt body and get **re-injected on every `codex exec resume` call** so they survive long sessions.

Templates use `{{PLACEHOLDER}}` syntax — the orchestrator substitutes before sending.

`{{CCPM_CONTEXT_PRIMING}}` substitution: see SKILL.md → "Codex priming". Resolves to a fixed priming block when `.claude/context/*.md` exists in the repo, else empty string. Only the **initial** template carries the placeholder — resume / forcing prompts run inside the same codex session, which has already absorbed the priming.

`{{DOMAIN_GLOSSARY}}` substitution: see SKILL.md → "Domain glossary priming". Resolves to a compact digest of the repo's DDD glossary (`CONTEXT.md` / `CONTEXT-MAP.md` + relevant `docs/adr/`) when those exist, else empty string. Like the priming block, it rides only the **initial** template (the session retains it across resume turns).

## Template: initial grill prompt (Phase 3, first turn)

```
{{CCPM_CONTEXT_PRIMING}}

=== GRILL RULES (NON-NEGOTIABLE, REPEATED EVERY TURN) ===
1. GRILL CONTEXT ONLY. Do NOT write code, plans, PRDs, or implementation
   proposals. Do NOT propose architecture. Do NOT recommend libraries. Your
   ONLY job is to ask discovery questions and, when saturated, emit a
   structured context doc.
2. Output a context doc only after grilling saturates. Sections (in this
   order, all required, even if some say "none"):
     - problem
     - users
     - scope
     - constraints
     - success criteria
     - non-goals
     - open questions
3. Hard cap = 100 questions. If reached without saturation, emit context doc
   immediately with current understanding; mark unresolved areas in the
   open-questions section.
4. When you are done grilling, emit `<<<GRILL-COMPLETE>>>` on its own line,
   followed by the context doc in the format above.
5. The respondent ("stakeholder") is Claude acting on behalf of an absent
   human. Claude marks every answer with one of:
     - `[KNOWN]` — answered from session memory or repo state
     - `[ASSUMPTION]` — Claude's best guess, not verified against ground truth
     - `[DEFERRED-DECISION]` — load-bearing product call Claude can't make
   Accept all three. Carry every `[DEFERRED-DECISION]` answer verbatim into
   the open-questions section of the final doc. Do NOT halt on
   `[DEFERRED-DECISION]`.
6. Ask ONE question per turn. Do not batch.
7. Do not echo or restate the rules block in your responses. Just ask the
   next question, or emit the sentinel + doc when done.
8. USE THE PROJECT'S UBIQUITOUS LANGUAGE from the domain glossary in REPO
   CONTEXT below (if present). When the stakeholder's answer uses a term that
   is fuzzy, overloaded, or conflicts with a glossary definition, sharpen it
   before moving on — ask which canonical term is meant, or name the conflict.
   Ground your questions in the glossary's terms, not invented synonyms.

=== TASK BULLETS ===
{{TASK_BULLETS_VERBATIM}}

=== REPO CONTEXT ===
Repo: {{REPO_NAME}}
Branch: {{CURRENT_BRANCH}}
Stack: {{DETECTED_STACK}}
Notes: {{CLAUDE_MD_HIGHLIGHTS_OR_EMPTY}}
Domain glossary: {{DOMAIN_GLOSSARY}}

=== ROLE ===
You are grilling Claude (acting as the human stakeholder) to build the
context document for the feature(s) described in TASK BULLETS. Ask one
question at a time. After each answer, decide: continue grilling, or
saturation reached.

Begin with your first question.
```

## Template: resume prompt (Phase 3, every subsequent turn)

```
=== GRILL RULES (REPEATED) ===
1. GRILL CONTEXT ONLY. Do NOT write code, plans, PRDs, or implementation
   proposals.
2. Output a context doc only after grilling saturates with sections:
   problem, users, scope, constraints, success criteria, non-goals,
   open questions.
3. Hard cap = 100 questions.
4. When done, emit `<<<GRILL-COMPLETE>>>` on its own line, then the
   context doc.
5. Accept `[KNOWN]` / `[ASSUMPTION]` / `[DEFERRED-DECISION]` markers in
   answers. Carry [DEFERRED-DECISION] into open-questions verbatim.
6. Ask one question per turn.
7. Use the project's ubiquitous language; sharpen fuzzy/conflicting terms
   against the glossary before moving on.

=== STAKEHOLDER ANSWER (turn {{TURN_NUMBER}} / cap 100) ===
{{CLAUDE_ANSWER_WITH_MARKER}}
```

## Template: forcing prompt (when cap is reached)

```
=== GRILL RULES (REPEATED) ===
[same compact rules block as resume]

=== CAP REACHED ===
You have reached the 100-question cap without emitting <<<GRILL-COMPLETE>>>.
Emit the sentinel and context doc NOW with your current understanding.
Mark all unresolved areas in the open-questions section. Do not ask another
question.
```

## How the orchestrator answers

For each Codex question, the orchestrator (this Claude):

1. Reads the question from `<state>/prds/<prd-name>/turn-NNN.md` (the `-o` output file)
2. Strips any rules-block echo (Codex sometimes restates them despite rule 7)
3. Classifies the question into one of three buckets:
   - **Answerable from session memory or repo** → `[KNOWN]`
   - **Best guess from analogous code/precedent** → `[ASSUMPTION]`
   - **Stakeholder product decision (financial, contract, security, data-integrity, or major UX direction)** → `[DEFERRED-DECISION]`
4. For `[DEFERRED-DECISION]` answers, also append to `human-review-needed.md`:
   ```
   ## <prd-name> — Deferred Decision (turn <N>)
   Q: <verbatim question>
   A: <Claude's guess>
   Reasoning: <why this guess; what could go wrong>
   ```
5. Forms the resume prompt with the answer and rules block
6. Calls `scripts/codex-grill-turn.sh <prd-name> resume`

## Sentinel parsing

After every `codex exec resume` returns, the orchestrator:

1. Reads `turn-NNN.md` (the `-o` output)
2. Greps for `<<<GRILL-COMPLETE>>>` on its own line
3. If found:
   - Extracts everything after the sentinel up to EOF
   - Validates it has the 7 required sections (problem, users, scope, constraints, success criteria, non-goals, open questions)
   - If valid, saves to `grill-context.md` and advances to Phase 4
   - If invalid (sections missing), sends one corrective prompt: "Context doc is missing sections: <list>. Re-emit complete doc."
4. If sentinel NOT found:
   - Increment `grill_turn_count`
   - If `grill_turn_count >= 100`, send forcing prompt
   - Otherwise, parse the question and answer it
