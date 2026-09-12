'use strict';

/**
 * Condensed popular web design systems for Chatre agents.
 * Inspired by Hermes popular-web-designs (MIT) / VoltAgent awesome-design-md.
 * Tokens are agent-ready CSS starting points — not pixel clones of proprietary UIs.
 */

const CATALOG = [
  { id: 'stripe', name: 'Stripe', vibe: 'Fintech luxury, light canvas, violet accent, light headlines' },
  { id: 'linear', name: 'Linear', vibe: 'Dark precision, indigo accent, ultra-minimal' },
  { id: 'vercel', name: 'Vercel', vibe: 'Gallery white/black, Geist-tight type, shadow-as-border' },
  { id: 'notion', name: 'Notion', vibe: 'Warm minimalism, soft surfaces, calm editorial' },
  { id: 'apple', name: 'Apple', vibe: 'Premium whitespace, cinematic imagery, SF-like type' },
  { id: 'framer', name: 'Framer', vibe: 'Bold black/blue, motion-first marketing' },
  { id: 'supabase', name: 'Supabase', vibe: 'Dark emerald, code-first developer tool' },
  { id: 'airbnb', name: 'Airbnb', vibe: 'Warm coral, photography-driven, rounded UI' },
  { id: 'spotify', name: 'Spotify', vibe: 'Green on dark, bold type, media-first' },
  { id: 'resend', name: 'Resend', vibe: 'Minimal dark, monospace accents' },
  { id: 'mintlify', name: 'Mintlify', vibe: 'Clean docs green, reading-optimized' },
  { id: 'raycast', name: 'Raycast', vibe: 'Dark chrome, vibrant gradients' },
  { id: 'figma', name: 'Figma', vibe: 'Multi-color playful professional' },
  { id: 'ibm', name: 'IBM', vibe: 'Carbon blue, structured enterprise' },
  { id: 'spacex', name: 'SpaceX', vibe: 'Stark B/W, full-bleed futuristic' },
];

const TEMPLATES = {
  stripe: {
    id: 'stripe',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;500;600&family=Source+Code+Pro:wght@400;500;700&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #ffffff; --text: #061b31; --muted: #64748d; --accent: #533afd;
  --accent-hover: #4434d4; --surface: #ffffff; --border: #e5edf5;
  --brand-dark: #1c1e54; --ruby: #ea2261; --radius: 6px;
  --shadow: 0 13px 27px -5px rgba(50,50,93,.25), 0 8px 16px -8px rgba(0,0,0,.1);
  --font: 'Source Sans 3', system-ui, sans-serif;
  --mono: 'Source Code Pro', ui-monospace, monospace;
}
body { margin:0; font-family:var(--font); color:var(--text); background:var(--bg); font-weight:400; }
h1,h2 { font-weight:300; letter-spacing:-0.03em; color:var(--text); }
.btn-primary { background:var(--accent); color:#fff; border:0; border-radius:var(--radius); padding:12px 18px; box-shadow:var(--shadow); }
.btn-primary:hover { background:var(--accent-hover); }
.card { border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow); background:var(--surface); }`,
    notes:
      'Light canvas, navy headings (#061b31), violet CTA (#533afd), weight-300 display type, blue-tinted shadows, 4–8px radius — never pill CTAs.',
  },
  linear: {
    id: 'linear',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #08090a; --panel: #0f1011; --elevated: #191a1b; --text: #f7f8f8;
  --muted: #8a8f98; --accent: #7170ff; --accent-bg: #5e6ad2;
  --border: rgba(255,255,255,.08); --radius: 8px;
  --font: 'Inter', system-ui, sans-serif; --mono: 'JetBrains Mono', monospace;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
h1 { letter-spacing:-0.04em; font-weight:510; }
.btn-primary { background:var(--accent-bg); color:#fff; border:0; border-radius:var(--radius); padding:10px 16px; }
.card { background:var(--elevated); border:1px solid var(--border); border-radius:var(--radius); }`,
    notes:
      'Dark-native #08090a, single indigo accent, hairline white borders, compressed Inter headlines — no marketing rainbow.',
  },
  vercel: {
    id: 'vercel',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #ffffff; --text: #171717; --muted: #666666; --border-shadow: rgba(0,0,0,.08);
  --link: #0072f5; --ship: #ff5b4f; --develop: #0a72ef; --radius: 8px;
  --font: 'Geist', Arial, sans-serif; --mono: 'Geist Mono', ui-monospace, monospace;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
h1 { letter-spacing:-0.05em; font-weight:600; }
.card { background:#fff; border-radius:var(--radius); box-shadow: 0 0 0 1px var(--border-shadow), 0 2px 2px rgba(0,0,0,.04); }
.btn-primary { background:#171717; color:#fff; border:0; border-radius:var(--radius); padding:10px 16px; }`,
    notes:
      'White gallery, #171717 text, Geist tight tracking, shadow-as-border (0 0 0 1px), sparse accents.',
  },
  notion: {
    id: 'notion',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #ffffff; --surface: #f7f6f3; --text: #37352f; --muted: #787774;
  --accent: #2383e2; --border: #e9e9e7; --radius: 6px;
  --font: 'Inter', system-ui, sans-serif; --display: 'Lora', Georgia, serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
h1,h2 { font-family:var(--display); font-weight:600; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); }
.btn-primary { background:var(--accent); color:#fff; border:0; border-radius:4px; padding:8px 14px; }`,
    notes: 'Warm off-white surfaces, serif headings, calm neutrals, blue links — editorial quiet.',
  },
  apple: {
    id: 'apple',
    fontsHtml: '',
    css: `:root {
  --bg: #f5f5f7; --surface: #ffffff; --text: #1d1d1f; --muted: #86868b;
  --accent: #0071e3; --radius: 18px;
  --font: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
h1 { font-size: clamp(2.5rem, 6vw, 4.5rem); letter-spacing:-0.02em; font-weight:600; }
.btn-primary { background:var(--accent); color:#fff; border:0; border-radius:980px; padding:12px 22px; }
.hero { min-height: 85vh; display:grid; place-items:center; text-align:center; }`,
    notes:
      'Huge type, massive whitespace, full-bleed product imagery, pill CTA ok here (Apple pattern), #f5f5f7 canvas.',
  },
  framer: {
    id: 'framer',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #000000; --text: #ffffff; --muted: #a1a1aa; --accent: #0099ff;
  --surface: #111111; --radius: 12px; --font: 'Inter', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
h1 { font-weight:700; letter-spacing:-0.04em; }
.btn-primary { background:var(--accent); color:#fff; border:0; border-radius:var(--radius); padding:12px 20px; }
.card { background:var(--surface); border-radius:var(--radius); }`,
    notes: 'Black canvas, bold blue accent, motion-ready sections, dense marketing energy.',
  },
  supabase: {
    id: 'supabase',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&family=Source+Code+Pro&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #0f0f0f; --surface: #1c1c1c; --text: #f8fafc; --muted: #94a3b8;
  --accent: #3ecf8e; --border: #2e2e2e; --radius: 8px;
  --font: 'Source Sans 3', system-ui, sans-serif; --mono: 'Source Code Pro', monospace;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
.btn-primary { background:var(--accent); color:#0f0f0f; border:0; border-radius:var(--radius); padding:10px 16px; font-weight:600; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); }
code { font-family:var(--mono); color:var(--accent); }`,
    notes: 'Dark emerald developer aesthetic, code snippets as first-class UI.',
  },
  airbnb: {
    id: 'airbnb',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Circular+Std:wght@400;500;700&family=Nunito+Sans:wght@400;600;700&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #ffffff; --text: #222222; --muted: #717171; --accent: #ff385c;
  --surface: #f7f7f7; --radius: 12px; --font: 'Nunito Sans', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
.btn-primary { background:linear-gradient(to right,#e61e4d,#d70466); color:#fff; border:0; border-radius:8px; padding:12px 20px; font-weight:600; }
.card { border-radius:var(--radius); overflow:hidden; }
.card img { aspect-ratio: 20/19; object-fit:cover; width:100%; display:block; }`,
    notes: 'Coral/raspberry accent, photo cards, friendly rounded UI, search-first layouts.',
  },
  spotify: {
    id: 'spotify',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #121212; --surface: #181818; --text: #ffffff; --muted: #b3b3b3;
  --accent: #1db954; --radius: 8px; --font: 'DM Sans', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
h1 { font-weight:700; letter-spacing:-0.02em; }
.btn-primary { background:var(--accent); color:#000; border:0; border-radius:500px; padding:12px 28px; font-weight:700; }
.card { background:var(--surface); border-radius:var(--radius); }`,
    notes: 'Dark media UI, vivid green, bold type, pill primary CTA.',
  },
  resend: {
    id: 'resend',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #000000; --text: #ededed; --muted: #8a8a8a; --accent: #ffffff;
  --border: #262626; --radius: 8px;
  --font: 'Inter', system-ui, sans-serif; --mono: 'JetBrains Mono', monospace;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
.btn-primary { background:#fff; color:#000; border:0; border-radius:var(--radius); padding:10px 16px; }
code { font-family:var(--mono); font-size:.9em; }`,
    notes: 'Stark dark minimal, white CTA, monospace for technical labels.',
  },
  mintlify: {
    id: 'mintlify',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #ffffff; --text: #111827; --muted: #6b7280; --accent: #18b69b;
  --sidebar: #f9fafb; --border: #e5e7eb; --radius: 8px;
  --font: 'Inter', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); line-height:1.7; }
.btn-primary { background:var(--accent); color:#fff; border:0; border-radius:var(--radius); padding:8px 14px; }
nav.side { background:var(--sidebar); border-right:1px solid var(--border); }`,
    notes: 'Docs-first green accent, readable line-height, sidebar nav pattern.',
  },
  raycast: {
    id: 'raycast',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #0d0d0d; --surface: #1a1a1a; --text: #ffffff; --muted: #a0a0a0;
  --accent: #ff6363; --grad: linear-gradient(135deg,#ff6363,#ffb86c,#50fa7b,#8be9fd);
  --radius: 12px; --font: 'Inter', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
.btn-primary { background:var(--accent); color:#fff; border:0; border-radius:var(--radius); padding:10px 16px; }
.grad-text { background:var(--grad); -webkit-background-clip:text; color:transparent; }`,
    notes: 'Dark launcher chrome, coral accent, optional rainbow gradient highlights.',
  },
  figma: {
    id: 'figma',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #ffffff; --text: #000000; --muted: #666666; --purple: #a259ff;
  --green: #0acf83; --red: #f24e1e; --blue: #1abcfe; --radius: 8px;
  --font: 'Inter', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
.btn-primary { background:var(--purple); color:#fff; border:0; border-radius:var(--radius); padding:10px 16px; }
.swatch { display:inline-block; width:12px; height:12px; border-radius:2px; }`,
    notes: 'Multi-color brand marks, playful but crisp product marketing.',
  },
  ibm: {
    id: 'ibm',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #ffffff; --text: #161616; --muted: #525252; --accent: #0f62fe;
  --border: #e0e0e0; --radius: 0; --font: 'IBM Plex Sans', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
.btn-primary { background:var(--accent); color:#fff; border:0; padding:12px 16px; }
.card { border:1px solid var(--border); }`,
    notes: 'Carbon: structured blue, zero radius default, IBM Plex, enterprise clarity.',
  },
  spacex: {
    id: 'spacex',
    fontsHtml:
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">',
    css: `:root {
  --bg: #000000; --text: #ffffff; --muted: #a7a7a7; --accent: #ffffff;
  --font: 'Inter', system-ui, sans-serif;
}
body { margin:0; font-family:var(--font); background:var(--bg); color:var(--text); }
.hero { min-height:100vh; display:grid; align-content:end; padding:4rem; background-size:cover; background-position:center; }
h1 { font-size:clamp(2.5rem,8vw,5rem); font-weight:700; text-transform:uppercase; letter-spacing:.08em; }
.btn-primary { background:transparent; color:#fff; border:2px solid #fff; padding:14px 28px; text-transform:uppercase; letter-spacing:.12em; }`,
    notes: 'Full-bleed dark imagery, uppercase tracking, outline CTAs, stark B/W.',
  },
};

const ALIASES = {
  'linear.app': 'linear',
  'stripe.com': 'stripe',
  'vercel.com': 'vercel',
  'like stripe': 'stripe',
  'like linear': 'linear',
  'like vercel': 'vercel',
  'like notion': 'notion',
  'like apple': 'apple',
  'like framer': 'framer',
  'like supabase': 'supabase',
  'like airbnb': 'airbnb',
  'like spotify': 'spotify',
  'like resend': 'resend',
  'like mintlify': 'mintlify',
  'like raycast': 'raycast',
  'like figma': 'figma',
  'like ibm': 'ibm',
  'like spacex': 'spacex',
  carbon: 'ibm',
};

function listDesigns() {
  return CATALOG.slice();
}

function getDesign(idOrName) {
  const raw = String(idOrName || '')
    .toLowerCase()
    .trim()
    .replace(/\.md$/, '');
  if (!raw) return null;
  if (TEMPLATES[raw]) return TEMPLATES[raw];
  if (ALIASES[raw] && TEMPLATES[ALIASES[raw]]) return TEMPLATES[ALIASES[raw]];
  const hit = CATALOG.find(
    (c) => c.id === raw || c.name.toLowerCase() === raw || raw.indexOf(c.id) >= 0,
  );
  return hit ? TEMPLATES[hit.id] || null : null;
}

function resolveFromText(text) {
  const t = String(text || '').toLowerCase();
  for (const c of CATALOG) {
    if (
      new RegExp(
        '\\b(like|style|styled|looks? like|inspired by|clone)\\s+' + c.id + '\\b',
      ).test(t) ||
      new RegExp('\\b' + c.name.toLowerCase() + '\\s+(style|look|inspired|clone)\\b').test(
        t,
      ) ||
      new RegExp('\\b(like|as)\\s+' + c.name.toLowerCase() + '\\b').test(t)
    ) {
      return TEMPLATES[c.id];
    }
  }
  // bare brand mention with design/landing/ui context
  if (/\b(landing|website|ui|design|page|dashboard|clone)\b/.test(t)) {
    for (const c of CATALOG) {
      if (new RegExp('\\b' + c.id + '\\b').test(t) || new RegExp('\\b' + c.name.toLowerCase() + '\\b').test(t)) {
        return TEMPLATES[c.id];
      }
    }
  }
  return null;
}

function formatTemplate(tpl) {
  if (!tpl) return '';
  return (
    '# Web design system: ' +
    tpl.id +
    '\n' +
    (tpl.notes || '') +
    '\n\n## Fonts (paste in <head>)\n' +
    (tpl.fontsHtml || '(system fonts)') +
    '\n\n## CSS starter\n```css\n' +
    tpl.css +
    '\n```\n\nApply these tokens when writing HTML/CSS. Adapt layout to the brief; do not paste a fake brand logo unless asked.'
  );
}

function catalogBrief() {
  return (
    'Available web design systems (use_skill web_designs with style=<id>):\n' +
    CATALOG.map((c) => '- ' + c.id + ': ' + c.vibe).join('\n')
  );
}

module.exports = {
  CATALOG,
  TEMPLATES,
  listDesigns,
  getDesign,
  resolveFromText,
  formatTemplate,
  catalogBrief,
};
