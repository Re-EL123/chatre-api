'use strict';

/**
 * OpenAI-style tool definitions for structured function calling.
 */

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Record a concrete multi-step plan before implementing.',
      parameters: {
        type: 'object',
        properties: { steps: { type: 'string' } },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List available agent skills.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: 'Load a skill playbook by name.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: ['coding', 'documents', 'git', 'debugging', 'research', 'project'],
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description:
        'Run a shell command in the workspace. Prefer simple commands, or bash -lc "..." for compounds.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          command: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with full contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          file: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append content to an existing file (creates if missing).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, file: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List entries in a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory (and parents).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_tree',
      description: 'Show workspace file tree under a path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files whose path contains a pattern.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, query: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search file contents for a text pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          query: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_javascript',
      description: 'Evaluate JavaScript via node -e in the sandbox.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_python',
      description: 'Evaluate Python via python3 -c in the sandbox.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Write a markdown document under /home/user/documents/.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_project',
      description: 'Sanity-check a project directory for files and emptiness.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_init',
      description: 'Initialize a git repo in the workspace.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_add',
      description: 'Stage paths for commit (. expands to all files).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Commit staged changes.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status JSON.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show commit history.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: 'Record a push to a remote in the workspace log.',
      parameters: {
        type: 'object',
        properties: {
          remote: { type: 'string' },
          branch: { type: 'string' },
        },
      },
    },
  },
];

function flattenParams(item) {
  if (!item || typeof item !== 'object') return {};
  if (item.params && typeof item.params === 'object') return { ...item.params };
  if (item.arguments != null) {
    if (typeof item.arguments === 'string') {
      try {
        return JSON.parse(item.arguments || '{}');
      } catch {
        return {};
      }
    }
    if (typeof item.arguments === 'object') return { ...item.arguments };
  }
  // Flat top-level fields (excluding meta keys)
  const skip = new Set([
    'tool',
    'name',
    'id',
    'type',
    'function',
    'params',
    'arguments',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (!skip.has(k)) out[k] = v;
  }
  return out;
}

function normalizeToolCall(item) {
  if (!item) return null;

  if (item.function && item.function.name) {
    let params = {};
    const raw = item.function.arguments;
    let parseFailed = false;
    if (typeof raw === 'string') {
      try {
        params = JSON.parse(raw || '{}');
      } catch {
        parseFailed = true;
        params = {};
      }
    } else if (raw && typeof raw === 'object') {
      params = raw;
    }
    return {
      tool: item.function.name,
      params,
      id: item.id || 'tc_' + Math.random().toString(36).slice(2, 8),
      structured: true,
      parseFailed,
    };
  }

  if (item.tool) {
    return {
      tool: item.tool,
      params: flattenParams(item),
      id: item.id || 'tc_' + Math.random().toString(36).slice(2, 8),
      structured: false,
    };
  }

  if (item.name) {
    return {
      tool: item.name,
      params: flattenParams(item),
      id: item.id || 'tc_' + Math.random().toString(36).slice(2, 8),
      structured: true,
    };
  }
  return null;
}

module.exports = { TOOL_DEFS, normalizeToolCall, flattenParams };
