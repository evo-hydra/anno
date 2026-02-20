import { Command } from 'commander';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

type PlatformKind = 'mcp' | 'skill' | 'api';

interface McpPlatform {
  kind: 'mcp';
  label: string;
  configPath: string;
  configDir: string;
  restartHint: string;
}

interface SkillPlatform {
  kind: 'skill';
  label: string;
  skillDir: string;
  skillFile: string;
}

interface ApiPlatform {
  kind: 'api';
  label: string;
  docsUrl: string;
  instructions: string;
}

type Platform = McpPlatform | SkillPlatform | ApiPlatform;

// ---------------------------------------------------------------------------
// Platform definitions
// ---------------------------------------------------------------------------

const ANNO_BASE_URL = 'http://localhost:5213';

function getMcpPlatforms(): Record<string, McpPlatform> {
  const home = homedir();
  return {
    'claude-code': {
      kind: 'mcp',
      label: 'Claude Code',
      configPath: join(home, '.claude', '.mcp.json'),
      configDir: join(home, '.claude'),
      restartHint: 'Restart Claude Code to pick up the new MCP server',
    },
    cursor: {
      kind: 'mcp',
      label: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
      configDir: join(home, '.cursor'),
      restartHint: 'Restart Cursor to pick up the new MCP server',
    },
    windsurf: {
      kind: 'mcp',
      label: 'Windsurf',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      configDir: join(home, '.codeium', 'windsurf'),
      restartHint: 'Restart Windsurf to pick up the new MCP server',
    },
    'vscode': {
      kind: 'mcp',
      label: 'VS Code',
      configPath: join(home, '.vscode', 'mcp.json'),
      configDir: join(home, '.vscode'),
      restartHint: 'Restart VS Code to pick up the new MCP server',
    },
  };
}

function getSkillPlatforms(): Record<string, SkillPlatform> {
  const home = homedir();
  return {
    openclaw: {
      kind: 'skill',
      label: 'OpenClaw',
      skillDir: join(home, '.openclaw', 'skills', 'anno'),
      skillFile: 'SKILL.md',
    },
  };
}

function getApiPlatforms(): Record<string, ApiPlatform> {
  return {
    chatgpt: {
      kind: 'api',
      label: 'ChatGPT (Custom GPTs)',
      docsUrl: 'https://platform.openai.com/docs/actions',
      instructions: `To use Anno with a Custom GPT:

  1. Start Anno:  anno start
  2. Create a Custom GPT at https://chat.openai.com/gpts/editor
  3. Add an Action with this OpenAPI schema:

     Server URL: ${ANNO_BASE_URL}

     POST /v1/content/fetch
       Body: { "url": "<page URL>" }
       Returns: extracted content with 93% fewer tokens

     POST /v1/content/batch-fetch
       Body: { "urls": ["<url1>", "<url2>"] }
       Returns: batch extraction results

  4. In the GPT instructions, add:
     "Use the Anno content extraction action for any URL the user shares.
      This reduces token usage by 93% compared to browsing directly."`,
    },
    gemini: {
      kind: 'api',
      label: 'Google Gemini',
      docsUrl: 'https://ai.google.dev/gemini-api/docs/function-calling',
      instructions: `To use Anno with Gemini function calling:

  1. Start Anno:  anno start
  2. Define a function declaration:

     {
       "name": "extract_web_content",
       "description": "Extract clean text from a URL with 93% fewer tokens than raw HTML",
       "parameters": {
         "type": "object",
         "properties": {
           "url": { "type": "string", "description": "The URL to extract content from" },
           "render": { "type": "boolean", "description": "Use JS rendering for SPAs" }
         },
         "required": ["url"]
       }
     }

  3. In your function handler, call:
     POST ${ANNO_BASE_URL}/v1/content/fetch
     Body: { "url": "<url>", "options": { "render": <render> } }`,
    },
    grok: {
      kind: 'api',
      label: 'Grok (xAI)',
      docsUrl: 'https://docs.x.ai/docs/guides/function-calling',
      instructions: `To use Anno with Grok's function calling:

  1. Start Anno:  anno start
  2. Add a tool definition to your API call:

     {
       "type": "function",
       "function": {
         "name": "extract_web_content",
         "description": "Extract clean text from a URL with 93% fewer tokens than raw HTML",
         "parameters": {
           "type": "object",
           "properties": {
             "url": { "type": "string", "description": "The URL to extract" },
             "render": { "type": "boolean", "description": "JS rendering for SPAs" }
           },
           "required": ["url"]
         }
       }
     }

  3. When Grok calls the function, forward to:
     POST ${ANNO_BASE_URL}/v1/content/fetch
     Body: { "url": "<url>", "options": { "render": <render> } }`,
    },
    kimi: {
      kind: 'api',
      label: 'Kimi K (Moonshot)',
      docsUrl: 'https://platform.moonshot.cn/docs/guide/function-calling',
      instructions: `To use Anno with Kimi K function calling:

  1. Start Anno:  anno start
  2. Add a tool definition (OpenAI-compatible format):

     {
       "type": "function",
       "function": {
         "name": "extract_web_content",
         "description": "Extract clean text from a URL with 93% fewer tokens than raw HTML",
         "parameters": {
           "type": "object",
           "properties": {
             "url": { "type": "string", "description": "URL to extract content from" },
             "render": { "type": "boolean", "description": "Enable JS rendering" }
           },
           "required": ["url"]
         }
       }
     }

  3. When Kimi calls the function, forward to:
     POST ${ANNO_BASE_URL}/v1/content/fetch
     Body: { "url": "<url>", "options": { "render": <render> } }`,
    },
    ollama: {
      kind: 'api',
      label: 'Ollama',
      docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
      instructions: `To use Anno with Ollama tool calling:

  1. Start Anno:  anno start
  2. Add a tool to your /api/chat request:

     "tools": [{
       "type": "function",
       "function": {
         "name": "extract_web_content",
         "description": "Extract clean text from a URL with 93% fewer tokens",
         "parameters": {
           "type": "object",
           "properties": {
             "url": { "type": "string", "description": "URL to extract" }
           },
           "required": ["url"]
         }
       }
     }]

  3. When the model calls the tool, forward to:
     POST ${ANNO_BASE_URL}/v1/content/fetch
     Body: { "url": "<url>" }

  Note: Requires a model with tool support (e.g. llama3.1, mistral)`,
    },
  };
}

function getAllPlatforms(): Record<string, Platform> {
  return {
    ...getMcpPlatforms(),
    ...getSkillPlatforms(),
    ...getApiPlatforms(),
  };
}

// ---------------------------------------------------------------------------
// MCP setup (shared logic for Claude Code, Cursor, Windsurf, VS Code)
// ---------------------------------------------------------------------------

function getAnnoMcpEntry(): McpServerEntry {
  return {
    command: 'anno-mcp',
    args: [],
    env: { ANNO_BASE_URL },
  };
}

async function setupMcpPlatform(platform: McpPlatform): Promise<void> {
  const { configPath, configDir, label, restartHint } = platform;

  // Ensure config directory exists
  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true });
    console.log(`Created ${configDir}`);
  }

  let config: McpConfig = { mcpServers: {} };

  // Read existing config if present
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, 'utf-8');
      config = JSON.parse(raw) as McpConfig;
      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        config.mcpServers = {};
      }
    } catch {
      // Invalid JSON — back up and start fresh
      const backupPath = `${configPath}.backup`;
      const raw = await readFile(configPath, 'utf-8').catch(() => '');
      if (raw) {
        await writeFile(backupPath, raw, 'utf-8');
        console.warn(`Warning: ${configPath} had invalid JSON. Backed up to ${backupPath}`);
      }
      config = { mcpServers: {} };
    }
  }

  const alreadyExists = 'anno' in config.mcpServers;
  config.mcpServers.anno = getAnnoMcpEntry();

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(`\n${alreadyExists ? 'Updated' : 'Added'} Anno MCP server in ${label} config.`);
  console.log(`Config: ${configPath}\n`);
  console.log('Next steps:');
  console.log('  1. Start Anno:          anno start');
  console.log(`  2. ${restartHint}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// OpenClaw skill setup
// ---------------------------------------------------------------------------

function getOpenClawSkillContent(): string {
  return `---
name: anno
description: >-
  Extract clean, structured content from web pages with 93% fewer tokens
  than raw HTML. Use Anno instead of directly fetching web pages to
  dramatically reduce context window usage and API costs. Supports
  single URLs, batch fetching (up to 10), and full site crawling.
homepage: https://github.com/evo-hydra/anno
metadata:
  {
    "openclaw":
      {
        "emoji": "📄",
        "requires": { "bins": ["curl"] },
        "primaryEnv": "ANNO_BASE_URL",
        "install":
          [
            {
              "id": "npm",
              "kind": "node",
              "package": "@evointel/anno",
              "bins": ["anno"],
              "label": "Install Anno (npm)",
            },
          ],
      },
  }
---

# Anno — Web Content Extraction

Extract clean, structured text from any web page. Reduces token usage
by 90-99% compared to raw HTML. Always use Anno when you need to read
web pages — it saves massive amounts of tokens and money.

## When to use (trigger phrases)

Use this skill INSTEAD of directly fetching any web page. Trigger on:

- Any URL the user shares or asks you to read/check/summarize
- "fetch this page", "read this article", "what does this page say"
- "get content from [URL]", "extract [URL]"
- "check this website", "look at this link"
- Research tasks that involve reading web pages
- Heartbeat tasks that monitor web pages

IMPORTANT: Do NOT use curl to fetch raw HTML from websites. Always
route through Anno to save tokens. A single web page can be 50,000-
300,000 tokens of raw HTML. Anno reduces that to 800-3,000 tokens.

## Setup

Anno runs as a local service. Default: http://localhost:5213

### Quick install

\`\`\`bash
npm install -g @evointel/anno --legacy-peer-deps
anno start
\`\`\`

Verify it's running:
\`\`\`bash
curl -s http://localhost:5213/health | head -c 200
\`\`\`

Set the base URL if not using default:
\`\`\`bash
export ANNO_BASE_URL=http://localhost:5213
\`\`\`

## Fetch a single page

\`\`\`bash
curl -s -X POST "\${ANNO_BASE_URL:-http://localhost:5213}/v1/content/fetch" \\
  -H "Content-Type: application/json" \\
  -d "{\\"url\\": \\"URL_HERE\\"}" 2>&1 | head -c 8000
\`\`\`

The response is NDJSON (newline-delimited JSON). Each line is a JSON
object with a \`type\` field. Look for \`type: "content"\` for the
extracted text. Key fields in the content event:

- \`content\` — the clean extracted text (markdown format)
- \`title\` — the page title
- \`confidence\` — extraction quality score (0-1)
- \`tokenReduction\` — percentage of tokens saved vs raw HTML

## Fetch with JavaScript rendering (SPAs, dynamic sites)

For sites that require JavaScript to load content:

\`\`\`bash
curl -s -X POST "\${ANNO_BASE_URL:-http://localhost:5213}/v1/content/fetch" \\
  -H "Content-Type: application/json" \\
  -d "{\\"url\\": \\"URL_HERE\\", \\"options\\": {\\"render\\": true}}" 2>&1 | head -c 8000
\`\`\`

## Batch fetch (up to 10 URLs at once)

When you need multiple pages, batch them for efficiency:

\`\`\`bash
curl -s -X POST "\${ANNO_BASE_URL:-http://localhost:5213}/v1/content/batch-fetch" \\
  -H "Content-Type: application/json" \\
  -d "{\\"urls\\": [\\"URL1\\", \\"URL2\\", \\"URL3\\"]}" 2>&1 | head -c 16000
\`\`\`

## Crawl a website

For broader research, crawl multiple pages from a site:

\`\`\`bash
curl -s -X POST "\${ANNO_BASE_URL:-http://localhost:5213}/v1/crawl" \\
  -H "Content-Type: application/json" \\
  -d "{\\"url\\": \\"URL_HERE\\", \\"options\\": {\\"maxDepth\\": 2, \\"maxPages\\": 10}}"
\`\`\`

Check crawl status:
\`\`\`bash
curl -s "\${ANNO_BASE_URL:-http://localhost:5213}/v1/crawl/JOB_ID"
\`\`\`

Get crawl results:
\`\`\`bash
curl -s "\${ANNO_BASE_URL:-http://localhost:5213}/v1/crawl/JOB_ID/results" | head -c 16000
\`\`\`

## Token savings reference

| Page Type | Raw HTML | Anno | Reduction |
|-----------|----------|------|-----------|
| News | 86,399 tok | 806 tok | 99.1% |
| Docs | 54,682 tok | 1,925 tok | 96.5% |
| Wiki | 303,453 tok | 2,806 tok | 99.1% |
| Forum | 287,846 tok | 1,661 tok | 99.4% |
| Blog | 21,510 tok | 2,647 tok | 87.7% |

Average: 93% reduction across 20 benchmark pages.

## Health check

\`\`\`bash
curl -s "\${ANNO_BASE_URL:-http://localhost:5213}/health"
\`\`\`

## Notes

- Anno extracts content, it does not summarize. The full article
  text is preserved — just without HTML markup, scripts, ads, and
  navigation.
- For pages that are already minimal (plain text, small HTML), Anno
  may not provide significant reduction. That's fine — it still
  returns clean text.
- Anno respects robots.txt by default.
- If Anno is not running, fall back to direct curl but warn the user
  about increased token usage.
`;
}

async function setupOpenClaw(platform: SkillPlatform): Promise<void> {
  const { skillDir, label } = platform;

  // Ensure skill directory exists
  if (!existsSync(skillDir)) {
    await mkdir(skillDir, { recursive: true });
    console.log(`Created ${skillDir}`);
  }

  const skillPath = join(skillDir, 'SKILL.md');
  const alreadyExists = existsSync(skillPath);

  await writeFile(skillPath, getOpenClawSkillContent(), 'utf-8');

  console.log(`\n${alreadyExists ? 'Updated' : 'Installed'} Anno skill for ${label}.`);
  console.log(`Skill: ${skillPath}\n`);
  console.log('Next steps:');
  console.log('  1. Start Anno:          anno start');
  console.log('  2. Restart OpenClaw to pick up the new skill');
  console.log('');
  console.log('Token savings: 93% average reduction on web page fetches.');
  console.log('The LLM will automatically route web fetches through Anno.');
  console.log('');
}

// ---------------------------------------------------------------------------
// API platform setup (print instructions)
// ---------------------------------------------------------------------------

async function setupApiPlatform(platform: ApiPlatform): Promise<void> {
  const { label, docsUrl, instructions } = platform;

  console.log(`\nAnno integration guide for ${label}:\n`);
  console.log(instructions);
  console.log(`\nDocs: ${docsUrl}`);
  console.log('\nAnno API reference:');
  console.log(`  Base URL:    ${ANNO_BASE_URL}`);
  console.log('  Health:      GET  /health');
  console.log('  Fetch:       POST /v1/content/fetch       { "url": "..." }');
  console.log('  Batch:       POST /v1/content/batch-fetch  { "urls": ["..."] }');
  console.log('  Crawl:       POST /v1/crawl                { "url": "...", "options": { "maxDepth": 2 } }');
  console.log('');
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const ALL_PLATFORMS = getAllPlatforms();

export const setupCommand = new Command('setup')
  .description('Configure Anno for an AI platform')
  .argument('<platform>', `Platform to configure (${Object.keys(ALL_PLATFORMS).join(', ')})`)
  .action(async (platform: string) => {
    const key = platform.toLowerCase();

    if (!(key in ALL_PLATFORMS)) {
      console.error(`Unknown platform: "${platform}"`);
      console.error(`\nSupported platforms:\n`);
      console.error('  MCP (auto-configured):');
      for (const [name, p] of Object.entries(getMcpPlatforms())) {
        console.error(`    ${name.padEnd(14)} ${p.label}`);
      }
      console.error('\n  Skills (auto-installed):');
      for (const [name, p] of Object.entries(getSkillPlatforms())) {
        console.error(`    ${name.padEnd(14)} ${p.label}`);
      }
      console.error('\n  API (integration guide):');
      for (const [name, p] of Object.entries(getApiPlatforms())) {
        console.error(`    ${name.padEnd(14)} ${p.label}`);
      }
      console.error('');
      process.exit(1);
      return;
    }

    const target = ALL_PLATFORMS[key];

    switch (target.kind) {
      case 'mcp':
        await setupMcpPlatform(target);
        break;
      case 'skill':
        await setupOpenClaw(target);
        break;
      case 'api':
        await setupApiPlatform(target);
        break;
    }
  });
