'use strict';

/**
 * Named agents registry — OpenCode-inspired build/plan/explore/general
 * plus hidden compaction/title/summary, and user-generated custom agents.
 */

const Permission = require('./permissions');

const PlanArtifact = require('./plan-artifact');

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring workspaces.

Strengths:
- Finding files with find_files / view_tree / list_directory
- Searching contents with search_code
- Reading files when you know the path

Guidelines:
- Adapt thoroughness: quick = few targeted searches; medium = several areas; very thorough = broad coverage across naming conventions
- Return absolute paths in findings
- Do NOT create, edit, delete, or overwrite any files
- Do NOT run mutating shell commands
- Prefer read-only tools
- Be concise; no emojis

Finish with structured JSON (summary, findings[], filesChanged:[], risks[], nextActions[], todos[]).`;

const PROMPT_VERIFY = `You are the verify agent. Your only job is to prove the work works.

Workflow:
1. Locate the project (view_tree / list_directory under /home/user/projects)
2. Call preview_project (preferred) or verify_project
3. If errors: list them precisely; suggest minimal patch_file fixes as nextActions (do not invent large rewrites)
4. Re-preview after fixes only if you are allowed to edit — otherwise return nextActions for build

Never claim success without preview_project/verify_project ok.
For repo mode: also run_tests and require testsOk (static HTML with no test script may rely on preview).
Prefer repo_diagnostics + fixing listed Problems / active file first.
Finish with structured JSON including risks and nextActions.`;

const PROMPT_BUILD = `You are the build orchestrator on Chatre's team pipeline.

Hierarchy (do not confuse):
- Named agent (you) = permissions + mission
- Skills = playbooks when loaded
- Task-type bias = soft hint only
- Team phases = mandatory factory line on the blackboard

Phases: intake → research → strategy → plan → execute ↔ monitor → verify → done

Orchestration:
1. Read STRATEGY.md + approved PLAN.md — do not re-plan after approval
2. If research findings are thin, delegate_task(agent=explore|research) before inventing paths
3. Use the team blackboard (phase, todos with owners, findings, monitor notes, preview errors)
4. If a custom specialist is listed on the blackboard, delegate_task(agent=<specialist>) for implement slices
5. Otherwise implement yourself or delegate_task(agent=general) — one goal per child
6. Parallelize independent explores via delegate_task goals:[{goal,agent:"explore"},…]
7. Never parallelize writes to the same files; one workspace writer at a time
8. Obey MONITOR fix briefs immediately when they appear
9. Hand off proof: preview_project yourself or delegate_task(agent=verify)
10. Fix preview errors; update todos (owner=verify|build); only then claim done

Prefer write_file/patch_file over shell file ops. Prefer cwd over cd &&.

Repo tasks: git_clone/repo_open → search_code → patch_file → run_tests → preview_project → commit only if asked.
Prefer fixing Problems / the active file from IDE context before broad rewrites.
When the user asks for a PR: tests green → create_pull_request; use get_ci_status before claiming CI is fixed.`;

const PROMPT_GENERAL = `You are a focused general-purpose subagent. Complete ONLY the assigned goal with tools, then stop.

Rules:
- Do not spawn further subagents (no delegate_task)
- Do not expand scope beyond the goal
- Touch only files needed for this goal
- Finish with structured JSON (summary, findings, filesChanged, risks, nextActions, todos)`;


const PROMPT_COMPACTION = `You are a context summarization agent. You are given a conversation between a user and an agent. Produce a structured summary so another coding agent can continue.

Follow the exact output structure requested. Keep every section, preserve exact file paths and identifiers, prefer terse bullets.

Do not continue the conversation. Do not answer questions in the transcript. Only output the structured summary. Match the conversation language.`;

const PROMPT_TITLE = `Generate a short thread title (3–7 words) for the user's first message. No quotes, no trailing punctuation, no markdown. Return ONLY the title text.`;

const PROMPT_SUMMARY = `Summarize this agent run for the user in 3–6 short bullets: what was done, key file paths, preview URL if any, and remaining risks. No tool blocks.`;

const PROMPT_GENERATE = `You are an elite AI agent architect. Translate the user's description into a high-performance agent config.

Return ONLY a JSON object with exactly:
{
  "identifier": "lowercase-hyphen-id",
  "whenToUse": "Use this agent when… (include 1 short example of Task tool launch)",
  "systemPrompt": "Full second-person system prompt governing the agent"
}

Rules:
- identifier: 2–4 words, a-z0-9-hyphen only, unique vs existing names
- whenToUse: start with "Use this agent when…"
- systemPrompt: specific methodologies, boundaries, quality checks; no vague filler
- Align with project conventions when AGENTS.md / workspace context is provided
- Do not wrap JSON in markdown fences`;

function baseDefaults() {
  return Permission.defaultRuleset();
}

function nativeAgents() {
  const defaults = baseDefaults();
  return {
    build: {
      name: 'build',
      description:
        'Orchestrator. Plans handoff → explore/general slices → verify/preview before done.',
      mode: 'primary',
      native: true,
      hidden: false,
      color: '#7dffb3',
      steps: 16,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          question: 'allow',
          plan: 'allow',
          edit: { '*': 'allow' },
          task: 'allow',
        }),
      ),
      prompt: PROMPT_BUILD,
      whenToUse: 'Use for implementing features, apps, fixes, and delivery.',
    },
    plan: {
      name: 'plan',
      description: 'Plan mode. Disallows edit tools except plan markdown.',
      mode: 'primary',
      native: true,
      hidden: false,
      color: '#9ad8f0',
      steps: 8,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          edit: {
            '*': 'deny',
            '/home/user/documents/plans/**': 'allow',
            '/home/user/projects/**/PLAN.md': 'allow',
            '/home/user/projects/**/plan.md': 'allow',
            '/home/user/documents/plans/**': 'allow',
            '**/STRATEGY.md': 'allow',
            '**/AGENTS.md': 'deny',
          },
          bash: { '*': 'deny' },
          task: { '*': 'deny' },
          create_pdf: 'deny',
          create_document: 'allow',
          write_file: {
            '*': 'deny',
            '/home/user/documents/plans/**': 'allow',
            '/home/user/projects/**/PLAN.md': 'allow',
            '/home/user/projects/**/plan.md': 'allow',
          },
          patch_file: 'deny',
          apply_patch: 'deny',
          delete_file: 'deny',
          git_commit: 'deny',
          git_push: 'deny',
        }),
      ),
      prompt:
        'You are in Plan mode. Explore and write a clear plan only (markdown under /home/user/documents/plans/ or PLAN.md). Do not implement code, run builds, or mutate the project.\n\n' +
        PlanArtifact.planPromptExtra() +
        '\nWhen the plan is ready, stop and wait for Approve & execute.',
      whenToUse: 'Use when the user wants a plan before any implementation.',
    },
    explore: {
      name: 'explore',
      description:
        'Fast read-only codebase explorer. Use thoroughness: quick|medium|very thorough.',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#ffb347',
      steps: 10,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          '*': 'deny',
          read: 'allow',
          find_files: 'allow',
          search_code: 'allow',
          view_tree: 'allow',
          list_directory: 'allow',
          read_file: 'allow',
          search_web: 'allow',
          fetch_url: 'allow',
          http_request: 'allow',
          webfetch: 'allow',
          bash: 'ask',
          execute_command: 'ask',
          edit: 'deny',
          task: 'deny',
          todowrite: 'deny',
          external_directory: {
            '*': 'ask',
            '/home/user/projects/**': 'allow',
            '/home/user/documents/**': 'allow',
          },
        }),
      ),
      prompt: PROMPT_EXPLORE,
      whenToUse:
        'Use this agent when you need to find files, search code, or answer codebase questions without making changes.',
    },
    general: {
      name: 'general',
      description:
        'General-purpose subagent for research and multi-step tasks (parallel units of work).',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#c4b5fd',
      steps: 8,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          todowrite: 'allow',
          task: 'deny',
          preview_project: 'allow',
          execute_command: 'allow',
        }),
      ),
      prompt: PROMPT_GENERAL,
      whenToUse: 'Use for complex multi-step subgoals that are not pure exploration.',
    },
    verify: {
      name: 'verify',
      description:
        'Preview/debug specialist. Owns preview_project before build claims done.',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#f472b6',
      steps: 6,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          '*': 'deny',
          read: 'allow',
          read_file: 'allow',
          list_directory: 'allow',
          view_tree: 'allow',
          find_files: 'allow',
          search_code: 'allow',
          preview_project: 'allow',
          verify_project: 'allow',
          run_tests: 'allow',
          repo_diagnostics: 'allow',
          git_status: 'allow',
          git_diff: 'allow',
          execute_command: 'ask',
          run_javascript: 'ask',
          run_python: 'ask',
          execute_code: 'ask',
          edit: 'deny',
          task: 'deny',
          todowrite: 'allow',
        }),
      ),
      prompt: PROMPT_VERIFY,
      whenToUse:
        'Use after implementation to run preview_project / verify_project and report failures.',
    },
    research: {
      name: 'research',
      description:
        'Read-only researcher for planners. Workspace + web facts; no edits.',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#fbbf24',
      steps: 8,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          '*': 'deny',
          read: 'allow',
          find_files: 'allow',
          search_code: 'allow',
          view_tree: 'allow',
          list_directory: 'allow',
          read_file: 'allow',
          search_web: 'allow',
          fetch_url: 'allow',
          http_request: 'allow',
          webfetch: 'allow',
          bash: 'ask',
          execute_command: 'ask',
          edit: 'deny',
          task: 'deny',
          todowrite: 'allow',
          external_directory: {
            '*': 'ask',
            '/home/user/projects/**': 'allow',
            '/home/user/documents/**': 'allow',
          },
        }),
      ),
      prompt:
        'You are the research agent. Gather facts for strategy/plan.\n\n' +
        'Rules:\n' +
        '- Read-only: no write_file/patch_file/delete/git mutations\n' +
        '- Prefer view_tree, find_files, search_code, read_file, search_web, fetch_url\n' +
        '- Return absolute paths and concrete findings the plan must use\n' +
        '- Finish with structured JSON (summary, findings[], filesChanged:[], risks[], nextActions[], todos[])',
      whenToUse:
        'Use before planning when the team needs workspace or web facts without making changes.',
    },
    strategy: {
      name: 'strategy',
      description:
        'Strategizer brain. Owns approach, risks, specialist decision; writes STRATEGY.md only.',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#38bdf8',
      steps: 6,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          edit: {
            '*': 'deny',
            '/home/user/documents/plans/**': 'allow',
            '**/STRATEGY.md': 'allow',
            '**-STRATEGY.md': 'allow',
          },
          bash: { '*': 'deny' },
          task: { explore: 'allow', research: 'allow', '*': 'deny' },
          write_file: {
            '*': 'deny',
            '/home/user/documents/plans/**': 'allow',
          },
          create_document: 'allow',
          patch_file: 'deny',
          apply_patch: 'deny',
          delete_file: 'deny',
          read: 'allow',
          read_file: 'allow',
          view_tree: 'allow',
          list_directory: 'allow',
          find_files: 'allow',
          search_code: 'allow',
        }),
      ),
      prompt:
        'You are the strategizer. Think deeply, write STRATEGY.md under /home/user/documents/plans/, decide if a custom specialist is needed, and list skills/tools.\n' +
        'Do not implement product code. Research may be delegated read-only. When strategy is written, stop.',
      whenToUse: 'Use to set approach, risks, and specialist minting before detailed planning.',
    },
    monitor: {
      name: 'monitor',
      description:
        'Course-corrector. Checks plan adherence mid-run; nudges, does not rewrite the world.',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#fb7185',
      steps: 3,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          '*': 'deny',
          read: 'allow',
          read_file: 'allow',
          list_directory: 'allow',
          view_tree: 'allow',
          find_files: 'allow',
          search_code: 'allow',
          todowrite: 'allow',
          edit: 'deny',
          task: 'deny',
        }),
      ),
      prompt:
        'You are the monitor. Compare blackboard + workspace evidence to the approved plan.\n' +
        'Output JSON only: {pass, gaps[], fix_brief, role:"monitor"}.\n' +
        'Do not edit project files. Be strict about locked active project and missing verify.',
      whenToUse: 'Use mid-run or before done to correct drift without taking over implementation.',
    },
    intake: {
      name: 'intake',
      description: 'Hidden intake normalizer (request → contract).',
      mode: 'primary',
      native: true,
      hidden: true,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt:
        'Normalize the user request into goal, done_when, skills, tools, constraints. JSON only.',
      whenToUse: 'Internal only.',
    },
    critic: {
      name: 'critic',
      description: 'Hidden multi-role critic (plan adherence + verify).',
      mode: 'primary',
      native: true,
      hidden: true,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt:
        'You critique whether the team met the approved plan and verification bar. Output JSON only.',
      whenToUse: 'Internal only.',
    },
    compaction: {
      name: 'compaction',
      description: 'Hidden context summarizer.',
      mode: 'primary',
      native: true,
      hidden: true,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt: PROMPT_COMPACTION,
      whenToUse: 'Internal only.',
    },
    title: {
      name: 'title',
      description: 'Hidden thread title generator.',
      mode: 'primary',
      native: true,
      hidden: true,
      temperature: 0.5,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt: PROMPT_TITLE,
      whenToUse: 'Internal only.',
    },
    summary: {
      name: 'summary',
      description: 'Hidden run summarizer.',
      mode: 'primary',
      native: true,
      hidden: true,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt: PROMPT_SUMMARY,
      whenToUse: 'Internal only.',
    },
  };
}

function cloneAgent(a) {
  return JSON.parse(JSON.stringify(a));
}

function listNative(opts) {
  const includeHidden = !!(opts && opts.includeHidden);
  const all = nativeAgents();
  return Object.keys(all)
    .map((k) => cloneAgent(all[k]))
    .filter((a) => includeHidden || !a.hidden)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function getNative(name) {
  const all = nativeAgents();
  const a = all[String(name || '').toLowerCase()];
  return a ? cloneAgent(a) : null;
}

function normalizeCustomAgent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.identifier || raw.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!id) return null;
  const permission = Permission.merge(
    Permission.defaultRuleset(),
    Permission.fromConfig(raw.permission || {}),
  );
  return {
    name: id,
    identifier: id,
    description: String(raw.description || raw.whenToUse || '').slice(0, 400),
    whenToUse: String(raw.whenToUse || raw.description || '').slice(0, 600),
    prompt: String(raw.systemPrompt || raw.prompt || '').slice(0, 8000),
    mode: raw.mode === 'subagent' ? 'subagent' : 'all',
    native: false,
    hidden: false,
    color: raw.color || '#a5b4fc',
    steps: Number(raw.steps) || 10,
    permission,
  };
}

function mergeUserAgents(customList) {
  const map = {};
  listNative({ includeHidden: true }).forEach((a) => {
    map[a.name] = a;
  });
  (customList || []).forEach((c) => {
    const n = normalizeCustomAgent(c);
    if (!n) return;
    if (map[n.name] && map[n.name].native) {
      // don't overwrite native names — suffix
      n.name = n.name + '-custom';
      n.identifier = n.name;
    }
    map[n.name] = n;
  });
  return map;
}

/**
 * Resolve which agent runs for this session.
 */
function resolveAgent({
  agentName,
  composerMode,
  taskType,
  deliverableKind,
  customAgents,
}) {
  const customs = customAgents || [];
  const map = mergeUserAgents(customs);
  const requested = String(agentName || '').toLowerCase().trim();

  if (requested && map[requested]) {
    return map[requested];
  }

  const mode = String(composerMode || '').toLowerCase();
  // Explicit plan/explore modes keep their agents; otherwise route by understanding.
  if (mode === 'plan') return map.plan;
  if (mode === 'explore') return map.explore;
  if (mode === 'research') return map.research || map.explore;

  const t = String(taskType || '').toLowerCase();
  const kind = String(deliverableKind || '').toLowerCase();
  if (t === 'research' || (kind === 'answer' && t === 'question')) {
    return map.research || map.explore || map.build;
  }
  if (t === 'research' && (mode === 'browse' || mode === 'explore')) {
    return map.research || map.explore;
  }

  return map.build;
}

function thoroughnessHint(level) {
  const v = String(level || 'medium').toLowerCase();
  if (v === 'quick' || v === 'fast') {
    return 'Thoroughness: quick — a few targeted searches only.';
  }
  if (v === 'very thorough' || v === 'thorough' || v === 'deep') {
    return 'Thoroughness: very thorough — cover multiple locations and naming conventions.';
  }
  return 'Thoroughness: medium — balanced exploration.';
}

function agentSystemExtra(agent, opts) {
  const o = opts || {};
  if (!agent) return '';
  const parts = [];
  parts.push('# Active agent: ' + agent.name);
  parts.push(
    'Role hierarchy: named agent = permissions + mission; skills = playbooks; task-type bias = soft hint only (never override permissions).',
  );
  if (agent.description) parts.push(agent.description);
  if (agent.prompt) parts.push(agent.prompt);
  if (agent.name === 'explore') {
    parts.push(thoroughnessHint(o.thoroughness));
  }
  if (agent.name === 'plan') {
    parts.push(
      'Hard rule: no project code edits. Only plan markdown is writable.',
    );
  }
  if (agent.name === 'build') {
    parts.push(
      'Orchestrate team phases: research → strategy/plan → execute (specialist) → monitor → verify. Use blackboard + structured delegate_task returns.',
    );
  }
  if (agent.name === 'research' || agent.name === 'explore') {
    parts.push('Read-only. Feed findings to strategy/plan. No project mutations.');
  }
  if (agent.name === 'strategy') {
    parts.push('Write STRATEGY.md only. Decide specialist minting. No product code.');
  }
  if (agent.name === 'monitor') {
    parts.push('Nudge with fix_brief only. Never take over writes.');
  }
  if (agent.name === 'verify') {
    parts.push('Own preview_project. No success claim without ok preview.');
  }
  if (o.taskTypeBias) {
    parts.push('# Soft task-type bias (optional)\n' + o.taskTypeBias);
  }
  return parts.join('\n\n');
}

module.exports = {
  PROMPT_GENERATE,
  PROMPT_EXPLORE,
  PROMPT_VERIFY,
  PROMPT_BUILD,
  PROMPT_GENERAL,
  PROMPT_COMPACTION,
  PROMPT_TITLE,
  PROMPT_SUMMARY,
  nativeAgents,
  listNative,
  getNative,
  normalizeCustomAgent,
  mergeUserAgents,
  resolveAgent,
  thoroughnessHint,
  agentSystemExtra,
  deriveSubagentSessionPermission: Permission.deriveSubagentSessionPermission,
};
