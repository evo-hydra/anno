import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

const PLATFORMS: Record<string, { configPath: string; label: string }> = {
  'claude-code': {
    configPath: join(homedir(), '.claude', '.mcp.json'),
    label: 'Claude Code',
  },
};

function getAnnoMcpEntry(): McpServerEntry {
  return {
    command: 'anno-mcp',
    args: [],
    env: { ANNO_BASE_URL: 'http://localhost:5213' },
  };
}

async function setupClaudeCode(): Promise<void> {
  const { configPath, label } = PLATFORMS['claude-code'];
  const configDir = join(homedir(), '.claude');

  // Ensure ~/.claude/ exists
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
  console.log('  2. Restart Claude Code to pick up the new MCP server');
  console.log('');
}

export const setupCommand = new Command('setup')
  .description('Configure Anno as an MCP server for an AI platform')
  .argument('<platform>', `Platform to configure (${Object.keys(PLATFORMS).join(', ')})`)
  .action(async (platform: string) => {
    const key = platform.toLowerCase();

    if (!(key in PLATFORMS)) {
      console.error(`Unknown platform: "${platform}"`);
      console.error(`Supported platforms: ${Object.keys(PLATFORMS).join(', ')}`);
      process.exit(1);
    }

    if (key === 'claude-code') {
      await setupClaudeCode();
    }
  });
