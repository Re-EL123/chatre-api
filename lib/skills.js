'use strict';

/**
 * Auto-select skills from the user prompt + short guides for prompts.
 * Long playbooks: ./skill-playbooks.js · brand tokens: ./web-designs.js
 */

const { resolveFromText, catalogBrief, formatTemplate, getDesign } = require('./web-designs');
const { getPlaybook } = require('./skill-playbooks');

function detectSkills(text) {
  const t = String(text || '').toLowerCase();
  const skills = new Set();

  if (
    /\b(build|code|implement|scaffold|app|website|script|function|api|refactor|fix|game|html|css|javascript|\.js\b|\.html\b|\.css\b|canvas|react|vue|svelte|typescript|\.ts\b|frontend|webpage|web page)\b/.test(
      t,
    )
  ) {
    skills.add('coding');
  }
  if (
    /\b(document|readme|markdown|docs|write.?up|spec|pdf|report|guide|manual|essay|book|proposal|slide)\b/.test(
      t,
    )
  ) {
    skills.add('documents');
  }
  if (
    /\b(design|ui|ux|visual|layout|brand(ing)?|theme|aesthetic|typography|palette|style.?guide|mockup|wireframe|landing.?page|hero|look.?and.?feel|frontend|stylesheet|tailwind|css\b)\b/.test(
      t,
    )
  ) {
    skills.add('design');
  }
  if (
    /\b(design\.md|designmd|design tokens|token spec|dtcg|wcag.*(palette|contrast)|tailwind theme)\b/.test(
      t,
    )
  ) {
    skills.add('design_system');
  }
  if (
    resolveFromText(t) ||
    /\b(like (stripe|linear|vercel|notion|apple|framer|supabase|airbnb|spotify|resend|mintlify|raycast|figma|ibm|spacex)|popular web design|design system catalog)\b/.test(
      t,
    )
  ) {
    skills.add('web_designs');
    skills.add('design');
  }
  if (
    /\b(architecture diagram|system diagram|infra diagram|svg diagram|service map|cloud diagram)\b/.test(
      t,
    )
  ) {
    skills.add('architecture_diagram');
  }
  if (
    /\b(dogfood|exploratory qa|qa (the |this )?site|bug report|find bugs|usability test)\b/.test(
      t,
    )
  ) {
    skills.add('dogfood');
  }
  if (
    /\b(cite sources|grounded|with citations|fact.?check|verifiable sources|sources?:)\b/.test(
      t,
    )
  ) {
    skills.add('grounded_citations');
  }
  if (
    /\b(inspect (the )?codebase|codebase size|lines of code|\bloc\b|language breakdown|map the (repo|codebase))\b/.test(
      t,
    )
  ) {
    skills.add('codebase_inspection');
  }
  if (
    /\b(spike|throwaway|proof of concept|\bpoc\b|feasibility|quick prototype|see if .+ works)\b/.test(
      t,
    )
  ) {
    skills.add('spike');
  }
  if (
    /\b(simplify|clean up (my |the )?code|reduce complexity|dedupe|dead code)\b/.test(t)
  ) {
    skills.add('simplify_code');
  }
  if (
    /\b(tdd|test.?driven|red.?green.?refactor|write (the )?tests? first)\b/.test(t)
  ) {
    skills.add('tdd');
  }
  if (/\b(git|commit|push|repo|repository|version control)\b/.test(t)) {
    skills.add('git');
  }
  if (/\b(debug|error|bug|failing|stack.?trace|root cause)\b/.test(t)) {
    skills.add('debugging');
  }
  if (/\b(explore|inspect|search|find files|research)\b/.test(t)) {
    skills.add('research');
  }
  if (
    /\b(browser|navigate|click|website|web page|url|screenshot|fill form|login page)\b/.test(
      t,
    ) ||
    /https?:\/\//.test(t)
  ) {
    skills.add('browser');
  }
  if (
    /\b(computer|desktop|shell|terminal|http request|curl|download|os|system)\b/.test(
      t,
    )
  ) {
    skills.add('computer');
  }
  if (
    /\b(byok|api key|openrouter|anthropic|openai|gemini|bring your own)\b/.test(t)
  ) {
    skills.add('byok_setup');
  }
  if (
    /\b(connect (github|vercel|supabase|firebase)|link (github|vercel)|github (pat|token|account)|deploy to vercel|supabase (key|project)|firebase (project|service account)|integrations?)\b/.test(
      t,
    )
  ) {
    skills.add('connectors_setup');
  }
  if (
    /\b(web research|research the web|cite sources|summarize articles|fetch.?url)\b/.test(
      t,
    )
  ) {
    skills.add('web_research');
  }
  if (
    /\b(login|sign in|2fa|captcha|fill (the )?form|checkout|submit form)\b/.test(t)
  ) {
    skills.add('form_workflow');
  }
  if (/\b(pull request|pr\b|code review|patch|commit message)\b/.test(t)) {
    skills.add('code_pr');
  }
  if (/\b(csv|spreadsheet|table data|cleanup data|data clean)\b/.test(t)) {
    skills.add('data_cleanup');
  }
  if (
    /\b(network error|console error|ops debug|site broken|har\b|failed request)\b/.test(
      t,
    )
  ) {
    skills.add('ops_debug');
  }
  if (
    /\b(password|secret|credential|api token|never share|account safe)\b/.test(t)
  ) {
    skills.add('account_safe');
  }
  if (/\b(remember|memory|note that|remind me|schedule)\b/.test(t)) {
    skills.add('memory_schedule');
  }
  if (
    /\b(shell|terminal|npm (test|run|install)|pytest|make |cargo |go test|debug (the )?build|exit code)\b/.test(
      t,
    )
  ) {
    skills.add('shell_debug');
  }
  if (
    skills.has('coding') &&
    /\b(website|web.?app|landing|homepage|html|css|react|vue|svelte|ui|interface|dashboard|page|component|frontend)\b/.test(
      t,
    )
  ) {
    skills.add('design');
  }
  if (
    skills.has('documents') &&
    /\b(slide|deck|presentation|brochure|poster|newsletter|polished|beautiful|pretty|styled|visual|layout)\b/.test(
      t,
    )
  ) {
    skills.add('design');
  }
  if (skills.has('web_research') || skills.has('research')) {
    if (/\b(report|brief|comparison|news|current state)\b/.test(t)) {
      skills.add('grounded_citations');
    }
  }
  if (skills.has('coding') && (skills.has('documents') || skills.has('git'))) {
    skills.add('project');
  }
  if (!skills.size && /\b(create|make|write|plan)\b/.test(t)) {
    skills.add('coding');
  }
  return [...skills];
}

const SKILL_GUIDES = {
  coding:
    'Skill coding: MUST call write_file (or patch_file) for every source file under /home/user/projects/<slug>/ — never paste Python open()/zipfile or dump code only in chat. Explore briefly → todos → write complete files → list_directory to confirm → short answer with real paths. Files panel = downloadable; never invent Download URLs.',
  documents:
    'Skill documents: for PDF requests call create_pdf(title, content) with the FULL body text under /home/user/documents/; for markdown use create_document. Never invent download links or dump Python/fpdf. Only claim a file exists after the tool returns ok with a path.',
  design:
    'Skill design: name ONE surface (Monitor/Operate/Compare/Configure/Decide-Learn/Explore/Command) before tokens; brand-first heroes; one composition per viewport; CSS variables; purposeful type; atmospheric bg; full-bleed heroes without overlays; default no cards; avoid AI-slop themes; a11y+responsive. Pair web_designs for brand looks; design_system for DESIGN.md. Deliver real HTML/CSS files.',
  web_designs:
    'Skill web_designs: pick a catalog id (stripe, linear, vercel, notion, apple, framer, supabase, …); apply fonts+CSS tokens; write complete HTML. use_skill name=web_designs style=<id> for full tokens. Visual language only — no fake logos.',
  design_system:
    'Skill design_system: write DESIGN.md with YAML tokens (name, colors, typography, components as siblings) + markdown rationale; optional theme.css export; quote hex; WCAG contrast ~4.5:1.',
  architecture_diagram:
    'Skill architecture_diagram: write standalone dark HTML+SVG diagram under projects/ or documents/; labeled nodes/edges; no external libs.',
  dogfood:
    'Skill dogfood: plan → browser explore (navigate/read_page/screenshot/browser_console) → collect evidence → severity-ranked report via create_document.',
  grounded_citations:
    'Skill grounded_citations: register facts only from tool results; cite [web:N]/[screenshot:N] inline; Sources from tool URLs only; [unverified] for unsourced high-stakes claims.',
  codebase_inspection:
    'Skill codebase_inspection: view_tree → find_files → read manifests → search_code → summarize layout/languages/risks (read-only unless asked to edit).',
  spike:
    'Skill spike: smallest throwaway prototype in *-spike/ to answer one unknown → written verdict → do not polish or merge unless promoted.',
  simplify_code:
    'Skill simplify_code: review recent changes for reuse/quality/efficiency/altitude → surgical patch_file → re-verify. Not a bug hunt.',
  tdd: 'Skill tdd: write failing test first → confirm RED → minimal code → GREEN → refactor. Bugs get a failing repro test before the fix.',
  git: 'Skill git: git_clone/repo_open for remotes (or git_init) → search_code → patch → run_tests → git_add → git_commit → git_status/git_log → git_push when asked.',
  debugging:
    'Skill debugging (systematic): tight red loop first → root cause before any fix → one hypothesis at a time → failing test then fix → stop after 3 failed fixes and question architecture.',
  research:
    'Skill research: view_tree → list_directory → find_files/search_code → read_file before any edits.',
  project:
    'Skill project: explore → plan+todos → implement atomically → run_tests when present → preview_project (live localhost) → fix errors → document → git_commit.',
  browser:
    'Skill browser: tabs_create → navigate → read_page/get_page_text/screenshot → computer/form_input with coords or refs → search_web for research. Always pass tab_id. Use browser_network/browser_console when debugging.',
  computer:
    'Skill computer: todo_write for plans; execute_command and files for workspace; search_web/http_request/fetch_url for network; browser tools for interactive web; desktop_* (incl. type/hotkey/click) for real OS when companion is online.',
  byok_setup:
    'Skill byok_setup: confirm user is signed in → save provider key in Settings BYOK (or ask them to) → test_connection(provider) → pick provider:model → run a tiny chat. Never echo API keys.',
  connectors_setup:
    'Skill connectors_setup: for GitHub/Vercel/Supabase/Firebase — list_connectors first. If missing, tell user Settings → Integrations to paste a PAT/token (encrypted). Then connector_status(test:true) and connector_request against their real account. Never invent or echo tokens.',
  web_research:
    'Skill web_research: search_web (max 3 queries) → rank results → fetch_url on top sources → synthesize with citations [web:N]. Use browser only if JS/login required.',
  form_workflow:
    'Skill form_workflow: navigate → list_frames/switch_frame if needed → read_page → form_input/computer → await_login on walls → screenshot verify. Do not invent credentials.',
  code_pr:
    'Skill code_pr: git_clone if remote → search_code → patch_file → run_tests → git_status → git_add → git_commit with why-focused message. git_push / create_pull_request only if user asked; get_ci_status before claiming CI fixed; review_pull_request for review requests.',
  data_cleanup:
    'Skill data_cleanup: csv_read → csv_query/filter → csv_write cleaned file → upload_artifact. Prefer CSV tools over ad-hoc Python unless needed.',
  ops_debug:
    'Skill ops_debug: reproduce → browser_network (failed_only) + browser_console → identify failing URL/script → minimal fix or report. Use ocr_image if text is only in screenshots.',
  account_safe:
    'Skill account_safe: never invent or log passwords/API keys; use await_login / ask_user_input; never echo BYOK secrets; prefer memory_set only for non-secret preferences.',
  memory_schedule:
    'Skill memory_schedule: memory_set/get for durable user notes; remind/schedule_create for timed notes; schedule_due to deliver; schedule_list/cancel to manage.',
  shell_debug:
    'Skill shell_debug: reproduce with execute_command (streamed; prefer cwd over cd &&) → read exit/code/duration → on spill_path use read_file/search_code → patch_file minimal fix → re-run. Prefer file tools over cat/grep/find in shell. Prefer workspace mode; sandbox for untrusted; local/desktop_exec only with approved=true. Use shell_open/write/read for interactive installers; execute_command_cancel to stop hangs. On needs_input, pause for the user.',
};

const DESIGN_DOC_HINT =
  'Design: clear hierarchy (H1→H2→body), scannable sections, generous whitespace cues, consistent heading rhythm, short paragraphs, lists where helpful — no wall-of-text, no decorative emoji clutter.';

function skillBrief(names) {
  return names.map((n) => SKILL_GUIDES[n] || n).join('\n');
}

function pickPrimarySkill(skills, taskType) {
  const { pickPrimarySkill: pick } = require('./smart-agent');
  return pick(skills, taskType);
}

function wantsDesign(text, taskType, detected) {
  const list = Array.isArray(detected) ? detected.map(String) : [];
  if (
    list.indexOf('design') >= 0 ||
    list.indexOf('web_designs') >= 0 ||
    list.indexOf('design_system') >= 0
  ) {
    return true;
  }
  const t = String(taskType || '').toLowerCase();
  if (t === 'document') return true;
  const msg = String(text || '').toLowerCase();
  return /\b(html|css|scss|react|vue|svelte|tailwind|frontend|landing|website|ui|ux|layout|hero|component|stylesheet|theme|brand|visual|mockup|wireframe|dashboard|page|design)\b/.test(
    msg,
  );
}

/**
 * Primary delivery skill + companions (design, citations, brand templates).
 */
function composeActiveSkills(detected, taskType, userMessage) {
  const all = Array.isArray(detected) ? detected.map(String) : [];
  const msg = String(userMessage || '').toLowerCase();

  // Strong specialties own the run even if other keywords also matched.
  if (all.indexOf('dogfood') >= 0) return ['dogfood'];
  if (all.indexOf('architecture_diagram') >= 0) {
    return ['architecture_diagram', 'design'];
  }
  if (all.indexOf('design_system') >= 0 && !all.some((x) => x === 'coding')) {
    return ['design_system', 'design'];
  }

  for (const s of ['spike', 'tdd', 'simplify_code', 'codebase_inspection']) {
    if (
      all.indexOf(s) >= 0 &&
      !all.some((x) => /^(coding|documents|debugging)$/.test(x))
    ) {
      return [s];
    }
  }
  // tdd alongside coding → coding primary + tdd companion
  // simplify alongside coding → simplify primary when "simplify" is the ask
  if (all.indexOf('simplify_code') >= 0 && /\bsimplify\b/.test(msg)) {
    return ['simplify_code'];
  }
  if (all.indexOf('codebase_inspection') >= 0 && /\b(inspect|loc|breakdown|map the)\b/.test(msg)) {
    return ['codebase_inspection'];
  }

  const delivery = all.filter(
    (s) => s !== 'design' && s !== 'web_designs' && s !== 'grounded_citations',
  );
  const designOnly =
    (all.indexOf('design') >= 0 || all.indexOf('web_designs') >= 0) &&
    !delivery.some((s) =>
      /^(coding|documents|project|code_pr|debugging|git|dogfood|spike|tdd)$/.test(
        s,
      ),
    );

  if (designOnly) {
    return all.indexOf('web_designs') >= 0 ? ['web_designs', 'design'] : ['design'];
  }

  const primary = pickPrimarySkill(delivery.length ? delivery : all, taskType);
  const active = primary.slice();

  if (wantsDesign(userMessage, taskType, all) && active.indexOf('design') < 0) {
    active.push('design');
  }
  if (all.indexOf('web_designs') >= 0 && active.indexOf('web_designs') < 0) {
    active.push('web_designs');
  }
  if (all.indexOf('design_system') >= 0 && active.indexOf('design_system') < 0) {
    active.push('design_system');
  }
  if (
    all.indexOf('grounded_citations') >= 0 &&
    active.indexOf('grounded_citations') < 0
  ) {
    active.push('grounded_citations');
  }
  if (all.indexOf('tdd') >= 0 && active.indexOf('tdd') < 0) {
    active.push('tdd');
  }

  return active;
}

/** Extra prompt block: brand template tokens when relevant. */
function designTemplateBlock(userMessage) {
  const tpl = resolveFromText(userMessage);
  if (!tpl) return '';
  return '\n\n# Matched web design system\n' + formatTemplate(tpl);
}

function expandSkillGuide(name, params) {
  const key = String(name || '')
    .toLowerCase()
    .trim();
  const playbook = getPlaybook(key);
  const short = SKILL_GUIDES[key];
  if (!short && !playbook) return null;

  let text = playbook || short;
  if (key === 'web_designs') {
    const style = params && (params.style || params.template || params.id);
    const tpl = style ? getDesign(style) : null;
    text =
      (playbook || short) +
      '\n\n' +
      catalogBrief() +
      (tpl ? '\n\n' + formatTemplate(tpl) : '');
  }
  return { name: key, guide: short || key, text, playbook: !!playbook };
}

module.exports = {
  detectSkills,
  skillBrief,
  SKILL_GUIDES,
  DESIGN_DOC_HINT,
  pickPrimarySkill,
  wantsDesign,
  composeActiveSkills,
  designTemplateBlock,
  expandSkillGuide,
};
