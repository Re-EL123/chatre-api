'use strict';

/**
 * OpenAI-style tool definitions for structured function calling.
 */

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'todo',
      description:
        'Manage the todo list. Actions: set, add, done, list.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'add', 'done', 'list', 'replace', 'complete'],
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
              },
            },
          },
          id: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
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
      description:
        'Load a skill playbook by name. For web_designs pass style (stripe, linear, vercel, …).',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: [
              'coding',
              'documents',
              'design',
              'web_designs',
              'design_system',
              'architecture_diagram',
              'dogfood',
              'grounded_citations',
              'codebase_inspection',
              'spike',
              'simplify_code',
              'tdd',
              'git',
              'debugging',
              'research',
              'project',
              'browser',
              'computer',
              'byok_setup',
              'web_research',
              'form_workflow',
              'code_pr',
              'data_cleanup',
              'ops_debug',
              'account_safe',
              'memory_schedule',
              'shell_debug',
            ],
          },
          style: {
            type: 'string',
            description:
              'For web_designs: brand id (stripe, linear, vercel, notion, apple, …)',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Create/update task list. todos: [{content, status: pending|in_progress|completed, active_form?}].',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string' },
                active_form: { type: 'string' },
                id: { type: 'string' },
              },
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tabs_create',
      description: 'Create a new browser tab. Returns tab_id. Optional starting url.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description:
        'Navigate tab to url, or url=back/forward for history. Always pass tab_id.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer',
      description:
        'Browser interaction: left_click, right_click, double_click, triple_click, type, key, scroll, screenshot. Use coordinate [x,y] from screenshot or ref from read_page/find. Can pass actions[] to batch.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          action: { type: 'string' },
          coordinate: { type: 'array', items: { type: 'number' } },
          ref: { type: 'string' },
          text: { type: 'string' },
          scroll_parameters: { type: 'object' },
          actions: { type: 'array', items: { type: 'object' } },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description:
        'Read page structure / element refs (ref_1…). filter=interactive|all. Use before precise clicks/forms.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          depth: { type: 'number' },
          filter: { type: 'string' },
          ref_id: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find',
      description:
        'Find elements by natural language query. Returns refs and coordinates.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'form_input',
      description: 'Set a form field by ref from read_page (text, checkbox, select).',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          ref: { type: 'string' },
          value: {},
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page_text',
      description: 'Extract plain text from the page (prefer over endless scrolling).',
      parameters: {
        type: 'object',
        properties: { tab_id: { type: 'number' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Search the web with keyword queries (max 3). Prefer this over browsing a search engine.',
      parameters: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: { type: 'string' } },
          query: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_status',
      description:
        'Check if the local desktop companion is online (required for desktop_* tools).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_open',
      description:
        'Open a URL in the user\'s real desktop browser via the local companion.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_screenshot',
      description:
        'Capture the user\'s desktop screenshot via the local companion (not the cloud browser).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_clipboard_get',
      description: 'Read text from the user desktop clipboard via companion.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_clipboard_set',
      description: 'Write text to the user desktop clipboard via companion.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_notify',
      description: 'Show a desktop notification via companion.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'await_login',
      description:
        'Pause the agent so the user can complete login, 2FA, or CAPTCHA in the cloud browser, then resume.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          message: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_frames',
      description: 'List iframes/frames on the current tab for multi-frame sites.',
      parameters: {
        type: 'object',
        properties: { tab_id: { type: 'number' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_frame',
      description:
        'Target an iframe by frame_index, frame_url substring, or frame_selector and read its interactive elements.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          frame_index: { type: 'number' },
          frame_url: { type: 'string' },
          frame_selector: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: 'HTTP GET/POST/etc to a public URL (APIs). Prefer search_web for general search.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: {},
          timeout: { type: 'number' },
        },
        required: ['url'],
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
      name: 'create_pdf',
      description:
        'Create a downloadable PDF under /home/user/documents/. Pass the full body text in content. Latin script only.',
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
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description:
        'Run a shell command (modes: workspace|sandbox|local). Streams output. Prefer simple commands or bash -lc.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          mode: { type: 'string', description: 'workspace | sandbox | local' },
          timeoutMs: { type: 'number' },
          network: { type: 'boolean' },
          pack: { type: 'string' },
          approved: {
            type: 'boolean',
            description: 'Required true for local/companion exec',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command_cancel',
      description: 'Cancel the currently running execute_command in this agent run.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_open',
      description: 'Open an interactive shell session (for REPL/installers). Then shell_write/shell_read.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          shell: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_write',
      description: 'Write a line to an interactive shell session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          data: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_read',
      description: 'Read buffered output from an interactive shell session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          wait_ms: { type: 'number' },
          max: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_close',
      description: 'Close an interactive shell session.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_exec',
      description:
        'Run a command on the user machine via companion (requires approved=true). Prefer workspace mode when possible.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          cwd: { type: 'string' },
          approved: { type: 'boolean' },
          timeoutMs: { type: 'number' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_pty',
      description:
        'Open/write/read/close a local PTY via companion. action=open|write|read|close. Requires approved on open.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          session_id: { type: 'string' },
          data: { type: 'string' },
          cwd: { type: 'string' },
          approved: { type: 'boolean' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch a public URL and return readable text/markdown (prefer over browser for static docs).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'number' },
          timeout: { type: 'number' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description:
        'Download a public file into /home/user/downloads/ (text or base64).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          filename: { type: 'string' },
          dest_dir: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_artifact',
      description:
        'Promote a workspace file to /home/user/artifacts/ for the UI artifact rail.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description:
        'Apply a surgical edit via old_string/new_string (preferred) or a unified diff patch.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
          patch: { type: 'string' },
          diff: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'csv_read',
      description: 'Parse a CSV workspace file into rows/objects.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'number' },
          as_objects: { type: 'boolean' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'csv_write',
      description: 'Write rows or objects to a CSV workspace file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          rows: { type: 'array' },
          headers: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'rows'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'csv_query',
      description: 'Filter rows in a CSV file by column/value or where object.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          column: { type: 'string' },
          value: { type: 'string' },
          contains: { type: 'string' },
          where: { type: 'object' },
          limit: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_get',
      description: 'Read durable per-user memory (all keys or one key).',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_set',
      description: 'Save a durable per-user memory note (cross-thread).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: {},
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: 'Delete a per-user memory key.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_create',
      description:
        'Schedule a reminder (ISO when or "in 30m"). Delivered when schedule_due is checked.',
      parameters: {
        type: 'object',
        properties: {
          when: { type: 'string' },
          message: { type: 'string' },
          cron: { type: 'string' },
        },
        required: ['when', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remind',
      description: 'Alias for schedule_create (one-shot reminder).',
      parameters: {
        type: 'object',
        properties: {
          when: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['when', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_list',
      description: 'List scheduled reminders for the signed-in user.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_cancel',
      description: 'Cancel a scheduled reminder by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_due',
      description: 'Return and mark due reminders as delivered.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_network',
      description:
        'List recent network requests/responses for the current browser tab (status, URL, type).',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          limit: { type: 'number' },
          failed_only: { type: 'boolean' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description: 'List recent console and page-error messages for the tab.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ocr_image',
      description:
        'OCR / read text from a screenshot (base64) or the current browser tab screenshot via vision.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'number' },
          image_base64: { type: 'string' },
          prompt: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'test_connection',
      description:
        'Test a saved BYOK provider key with a tiny chat request (openrouter|anthropic|openai|google).',
      parameters: {
        type: 'object',
        properties: { provider: { type: 'string' } },
        required: ['provider'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_connectors',
      description:
        'List which user app connectors are linked (github, vercel, supabase, firebase). Never returns secrets.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connector_status',
      description:
        'Check one connector (github|vercel|supabase|firebase) and optionally live-test it.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string' },
          test: { type: 'boolean' },
        },
        required: ['provider'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'connector_request',
      description:
        'Call the user\'s linked GitHub/Vercel/Supabase/Firebase account API with their saved token. Use path like /user/repos or full https URL on the allowlisted host. Never invent credentials — if disconnected, tell the user to open Settings → Integrations.',
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['github', 'vercel', 'supabase', 'firebase'],
          },
          method: { type: 'string' },
          path: { type: 'string' },
          url: { type: 'string' },
          body: {},
          headers: { type: 'object' },
        },
        required: ['provider'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_type',
      description: 'Type text into the focused desktop window (companion GUI).',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_hotkey',
      description:
        'Send a desktop hotkey via companion (e.g. ctrl+c, cmd+v, alt+tab).',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'string' },
          key: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_click',
      description: 'Click desktop coordinates via companion (x, y).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clarify',
      description:
        'Ask the user structured multiple-choice questions (2–4 options). Prefer over long prose questions.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          choices: { type: 'array', items: { type: 'string' } },
          recommended: { type: 'integer' },
          allow_free_text: { type: 'boolean' },
          questions: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_code',
      description:
        'Run a code snippet. language: javascript|python|shell.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string' },
          lang: { type: 'string' },
          code: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_extract',
      description:
        'Fetch a URL and extract readable main text (no browser tab).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'integer' },
          timeout: { type: 'integer' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'session_search',
      description: 'Search recent chat threads for a query string.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          q: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_view',
      description:
        'Load a skill playbook by name (or list skills if name omitted).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          style: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_manage',
      description: 'list|view|pin|unpin skills for this run.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          name: { type: 'string' },
          style: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vision_analyze',
      description:
        'Analyze an image with a vision model (BYOK OpenRouter/OpenAI). Pass image_base64 or use latest screenshot.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          prompt: { type: 'string' },
          image_base64: { type: 'string' },
          mime: { type: 'string' },
          model: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'video_analyze',
      description:
        'Analyze a video keyframe (pass frame_base64 / image_base64).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          frame_base64: { type: 'string' },
          image_base64: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_generate',
      description:
        'Generate an image (FAL_KEY or OpenAI/OpenRouter BYOK). Saves PNG under /home/user/documents/.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          filename: { type: 'string' },
          path: { type: 'string' },
          size: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_to_speech',
      description:
        'Synthesize speech (OpenAI BYOK audio). Saves mp3 under /home/user/documents/.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          voice: { type: 'string' },
          path: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'process_manage',
      description:
        'Background processes: action=start|list|status|read|kill|poll.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          command: { type: 'string' },
          cmd: { type: 'string' },
          cwd: { type: 'string' },
          process_id: { type: 'string' },
          id: { type: 'string' },
          clear: { type: 'boolean' },
          notify_on_complete: { type: 'boolean' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a V4A multi-file patch (*** Begin Patch … *** End Patch) to the workspace.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string' },
          diff: { type: 'string' },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_task',
      description:
        'Spawn a short nested agent for a focused subgoal. Keep goals small.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          task: { type: 'string' },
          context: { type: 'string' },
          max_steps: { type: 'integer' },
          model: { type: 'string' },
        },
        required: ['goal'],
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
