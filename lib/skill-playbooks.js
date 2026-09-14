'use strict';

/**
 * Long-form skill playbooks returned by use_skill.
 * Adapted from Hermes Agent skills (MIT) to Chatre tools.
 */

const PLAYBOOKS = {
  design: `# Skill: Design & visual craft

Act as an expert designer. Deliver real files (HTML/CSS/JS under /home/user/projects, or docs under /home/user/documents).

## Surface-first (anti-slop)
Before colors/type, commit to ONE surface archetype:
1. Monitor — dashboards/status (density, glanceable)
2. Operate — admin/queues/inboxes (actions dominate)
3. Compare — pricing/tables (aligned columns)
4. Configure — settings/forms/wizards (progressive disclosure)
5. Decide/Learn — landing/marketing (hero OK here ONLY)
6. Explore — galleries/catalogs (filters + grids)
7. Command/Inspect — command bars/detail panes

Hero + three feature cards is Decide/Learn only. Naming the surface out loud collapses generic layouts.

## Process
1. Gather context: brand docs, repo theme/tokens, screenshots, constraints. Read real files — tree alone is not enough.
2. Ask short questions only if fidelity is high and brief is thin (audience, output, brand, variations).
3. State surface + visual direction + CSS variables.
4. Build one complete artifact (prefer single self-contained HTML for prototypes/landings).
5. Verify: list_directory/read_file; for UI optionally navigate + screenshot.
6. If user wants a known brand look, also load web_designs. For a formal token file, use design_system.

## Taste rules
Brand-first heroes; one composition per viewport; purposeful fonts (avoid Inter/Roboto/Arial defaults unless matching a template); atmospheric backgrounds; full-bleed heroes without overlay junk; default no cards; one job per section; 2–3 motions max; avoid purple-on-white / cream-terracotta / broadsheet / glow-pill AI slop; accessible contrast + responsive.

## Docs/PDF
Clear H1→H2 hierarchy, scannable sections, whitespace — no wall-of-text.`,

  web_designs: `# Skill: Popular web designs

Use when the user wants a page "like Stripe / Linear / Vercel / …".

1. Resolve style id (stripe, linear, vercel, notion, apple, framer, supabase, airbnb, spotify, resend, mintlify, raycast, figma, ibm, spacex).
2. Call use_skill with name=web_designs and style=<id> (or rely on auto-injected template).
3. Paste fonts + CSS variables into the artifact; adapt layout to the brief.
4. Pair with design skill process (surface archetype first).
5. write_file complete HTML under /home/user/projects/<slug>/ — never invent download URLs.
6. Do not reproduce trademarked logos/wordmarks unless the user owns them; match visual language only.`,

  design_system: `# Skill: DESIGN.md design system

Author Google DESIGN.md-style token specs agents can reuse.

## File shape
YAML front matter (normative tokens) + markdown body (rationale).

Required: name, colors (include primary). Encouraged: typography, spacing, rounded, components.

Component variants are sibling keys (button-primary-hover), never nested .hover.

Canonical sections order: Overview → Colors → Typography → Layout → Elevation → Shapes → Components → Do's and Don'ts.

## Workflow
1. Infer brand tone / accent / type (ask if missing).
2. write_file DESIGN.md at project root (or /home/user/projects/<slug>/DESIGN.md).
3. Use {colors.primary} references in components.
4. Optionally export CSS :root variables beside it (theme.css).
5. Quote hex values; quote negative dimensions like letterSpacing: "-0.02em".
6. Call out WCAG: text vs background should meet ~4.5:1 for body text.`,

  debugging: `# Skill: Systematic debugging

Iron law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.

## Phase 1 — Root cause
- Read full errors/stack traces (read_file, search_code).
- Build a tight feedback loop (failing test / execute_command / curl) that is red on the bug.
- Check recent changes (git_log / git_status).
- Trace data flow to the source of the bad value.
Stop until you can state WHY.

## Phase 2 — Pattern
Compare working vs broken examples; list differences; minimize the repro.

## Phase 3 — Hypothesis
Rank 3–5 falsifiable hypotheses; change one variable; re-run the loop.

## Phase 4 — Fix
Prefer a failing test first (tdd). One root-cause fix. Re-verify. If 3+ fixes fail, stop and question architecture with the user — do not thrash.`,

  dogfood: `# Skill: Dogfood (exploratory QA)

Systematic browser QA → evidence → report.

## Phase 1 Plan
Todos for pages/flows; create /home/user/documents/dogfood/ or projects/<slug>/dogfood-output/.

## Phase 2 Explore
tabs_create → navigate → read_page / screenshot → browser_console after navigations and key interactions.
Test forms (valid + invalid), nav, empty states, long content, keyboard where relevant.

## Phase 3 Evidence
For each issue: URL, steps, expected vs actual, severity (Critical/High/Medium/Low), category (Functional/Visual/A11y/Console/UX/Content), screenshot if possible.

## Phase 4 Categorize
De-dupe; sort by severity.

## Phase 5 Report
create_document or write_file report.md with executive summary + per-issue sections + summary table.
Never claim bugs without observed evidence from tools.`,

  grounded_citations: `# Skill: Grounded citations

Every outside fact gets an inline citation from tool results — never invent ids or URLs.

## Procedure
1. search_web (max 3 focused queries) and/or fetch_url / browser read.
2. Cite immediately after the claim using tool ids: [web:N] or [screenshot:N] exactly as returned.
3. Max 3 citations per sentence; cite per sentence, not a dump at the end.
4. Conflicting sources: present both with their own ids.
5. Model-only claims: no fake citation — mark [unverified] if high-stakes.
6. For documents: append a short Sources section listing the cited [web:N] titles/URLs from tool output only.
7. Skip heavy citation for trivial coding lookups or pure creative writing.`,

  codebase_inspection: `# Skill: Codebase inspection

Map a workspace before big changes.

1. view_tree("/home/user/projects/<slug>") or list_directory.
2. find_files for entrypoints (package.json, pyproject.toml, README, src/).
3. read_file manifests; search_code for main routes/symbols.
4. Optionally execute_command for counts (find | wc, or language tools if present).
5. Summarize: languages, layout, entrypoints, risks, suggested next tools.
Do not edit until the user asks — inspection is read-only unless asked to fix.`,

  spike: `# Skill: Spike (throwaway experiment)

Validate an idea cheaply, then throw the spike away.

Loop: decompose → research → build → verdict → iterate.

1. Decompose: what unknown must be answered?
2. Research: docs/code first if knowable without building.
3. Build the SMALLEST disposable prototype under /home/user/projects/<slug>-spike/ (label it SPIKE in README).
4. Verdict: works / doesn't / unknowns remaining — recommend ship path or abandon.
5. Do not polish; do not merge spike code into production paths unless user explicitly promotes it.`,

  simplify_code: `# Skill: Simplify code

Cleanup pass on working code (not a bug hunt). Four lenses:

1. Reuse — duplication, missed shared helpers
2. Quality — clarity, naming, dead code, nesting
3. Efficiency — needless work, N+1, heavy deps
4. Altitude — over-abstraction vs under-abstraction

Workflow: git_status / diff recent files → read_file → patch_file minimal cleanups → verify_project/execute_command.
Do not rewrite everything; prefer surgical patch_file. Skip drive-by features.`,

  tdd: `# Skill: Test-driven development

Iron law: tests before production code. Watch RED before GREEN.

1. Write a failing test for the behavior (run_javascript / run_python / execute_command test runner).
2. Confirm RED (failure is the right failure).
3. Write minimal implementation to pass.
4. Confirm GREEN.
5. Refactor with tests still green.
6. For bugs: failing repro test first, then fix (pairs with debugging skill).
Skip only for explicit throwaway spikes — and say so.`,

  architecture_diagram: `# Skill: Architecture diagram

Deliver a standalone dark-themed HTML+SVG diagram (no external libs).

1. Clarify components, edges, groups (frontend/backend/data/cloud).
2. write_file under /home/user/projects/<slug>/ or /home/user/documents/ as *-architecture.html.
3. Dark canvas (#0b0f14), grid backdrop, rounded nodes, labeled arrows, legend.
4. Keep text readable; group related services; avoid spaghetti crossings.
5. Confirm path after write; tell user to open the HTML from Files.`,

  consistent_delivery: `# Skill: Consistent delivery

Stay true to the approved intent contract from analysis through the last tool call.

## Contract lock
1. Re-read goal, deliverable_kind, done_when, assumptions, and user_corrections.
2. Do not invent a new brief mid-run. If blocked, ask ONE clarify question.

## Surgical edits
3. Prefer patch_file / minimal write_file. Touch only files required for the goal.
4. Never delete or rewrite unrelated working code to "clean up" unless asked.
5. Match existing structure, naming, and style in the project (or approved PLAN.md).

## Verify before done
6. After each substantive write, re-check acceptance / done_when (preview_project, run_tests, read_file).
7. If verification fails, fix the regression — do not claim done.
8. Final answer: real paths + what changed + how done_when was proven. Ban soft claims ("goal completed", "should work").
`,

};

const VERIFY_CHECKLISTS = {
  consistent_delivery: [
    'Intent contract still matches the work shipped',
    'No unrelated files rewritten or deleted',
    'done_when / acceptance proven with tool evidence',
  ],
  design: [
    'Artifact path exists under projects or documents',
    'Entry HTML/CSS is non-empty',
    'preview_project ok for UI projects',
  ],
  web_designs: [
    'Complete HTML written under /home/user/projects/<slug>/',
    'preview_project returns ok',
  ],
  design_system: [
    'DESIGN.md exists at project root',
    'Tokens include primary color',
  ],
  debugging: [
    'Root cause stated before fix',
    'Failing repro then green verify',
  ],
  tdd: [
    'Failing test observed (RED)',
    'Implementation makes tests GREEN',
  ],
  coding: [
    'All planned files written non-empty',
    'preview_project or tests ok',
  ],
  documents: [
    'create_document/create_pdf/write_file succeeded',
    'File under /home/user/documents',
  ],
  git: [
    'git_commit succeeded',
    'Status clean or staged intentionally',
  ],
  architecture_diagram: [
    'HTML diagram file exists',
    'File opens as standalone HTML',
  ],
};

function getPlaybook(name) {
  const key = String(name || '')
    .toLowerCase()
    .trim();
  const body = PLAYBOOKS[key] || null;
  if (!body) return null;
  const checks = VERIFY_CHECKLISTS[key];
  if (!checks || !checks.length) return body;
  return (
    body +
    '\n\n## Verify checklist (enterprise)\n' +
    checks.map((c) => '- [ ] ' + c).join('\n')
  );
}

function getVerifyChecklist(name) {
  const key = String(name || '')
    .toLowerCase()
    .trim();
  return VERIFY_CHECKLISTS[key] || [];
}

module.exports = { PLAYBOOKS, VERIFY_CHECKLISTS, getPlaybook, getVerifyChecklist };
