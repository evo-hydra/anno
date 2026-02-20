import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock filesystem and os modules before importing the setup command.
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn<(path: string) => boolean>();
const mockMkdir = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockReadFile = vi.fn<() => Promise<string>>();
const mockWriteFile = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockCopyFile = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockHomedir = vi.fn(() => '/fakehome');

vi.mock('fs', () => ({ existsSync: mockExistsSync }));
vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  copyFile: mockCopyFile,
}));
vi.mock('os', () => ({ homedir: mockHomedir }));

// Must import after mocks are set up
const { setupCommand } = await import('../cli/commands/setup');

// Suppress console output during tests
const consoleSpy = {
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
};

// Prevent process.exit from killing the test runner
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

beforeEach(() => {
  vi.clearAllMocks();
  consoleSpy.log.mockImplementation(() => {});
  consoleSpy.warn.mockImplementation(() => {});
  consoleSpy.error.mockImplementation(() => {});
  mockExit.mockImplementation(() => undefined as never);
});

// Helper to invoke the command action
async function runSetup(platform: string): Promise<void> {
  // Commander stores the action handler; invoke it directly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actionHandler = (setupCommand as any)._actionHandler;
  await actionHandler([platform], setupCommand);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setup command', () => {
  describe('platform validation', () => {
    it('rejects unknown platform', async () => {
      await runSetup('unknown-platform');
      expect(consoleSpy.error).toHaveBeenCalledWith(expect.stringContaining('Unknown platform'));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('lists all supported platforms on error', async () => {
      await runSetup('nonexistent');
      const allErrors = consoleSpy.error.mock.calls.map((c) => c.join(' ')).join(' ');
      expect(allErrors).toContain('claude-code');
      expect(allErrors).toContain('cursor');
      expect(allErrors).toContain('windsurf');
      expect(allErrors).toContain('vscode');
      expect(allErrors).toContain('openclaw');
      expect(allErrors).toContain('chatgpt');
      expect(allErrors).toContain('gemini');
      expect(allErrors).toContain('grok');
      expect(allErrors).toContain('kimi');
      expect(allErrors).toContain('ollama');
    });

    it('groups platforms by type in error message', async () => {
      await runSetup('nonexistent');
      const allErrors = consoleSpy.error.mock.calls.map((c) => c.join(' ')).join(' ');
      expect(allErrors).toContain('MCP');
      expect(allErrors).toContain('Skills');
      expect(allErrors).toContain('API');
    });

    it('is case-insensitive', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('Claude-Code');
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // MCP platforms (Claude Code, Cursor, Windsurf, VS Code)
  // -------------------------------------------------------------------------

  describe.each([
    {
      platform: 'claude-code',
      label: 'Claude Code',
      configDir: '/fakehome/.claude',
      configPath: '/fakehome/.claude/.mcp.json',
    },
    {
      platform: 'cursor',
      label: 'Cursor',
      configDir: '/fakehome/.cursor',
      configPath: '/fakehome/.cursor/mcp.json',
    },
    {
      platform: 'windsurf',
      label: 'Windsurf',
      configDir: '/fakehome/.codeium/windsurf',
      configPath: '/fakehome/.codeium/windsurf/mcp_config.json',
    },
    {
      platform: 'vscode',
      label: 'VS Code',
      configDir: '/fakehome/.vscode',
      configPath: '/fakehome/.vscode/mcp.json',
    },
  ])('$platform setup (MCP)', ({ platform, label, configDir, configPath }) => {
    it('creates config directory when it does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup(platform);

      expect(mockMkdir).toHaveBeenCalledWith(configDir, { recursive: true });
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Created'));
    });

    it('writes new config when no config file exists', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)   // configDir exists
        .mockReturnValueOnce(false); // configPath does not exist

      await runSetup(platform);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [path, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(path).toBe(configPath);

      const written = JSON.parse(content);
      expect(written.mcpServers.anno).toEqual({
        command: 'anno-mcp',
        args: [],
        env: { ANNO_BASE_URL: 'http://localhost:5213' },
      });
    });

    it('preserves existing servers in config', async () => {
      const existing = {
        mcpServers: {
          sentinel: { command: 'sentinel-mcp', args: [] },
        },
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(existing));

      await runSetup(platform);

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      const written = JSON.parse(content);
      expect(written.mcpServers.sentinel).toEqual(existing.mcpServers.sentinel);
      expect(written.mcpServers.anno.command).toBe('anno-mcp');
    });

    it('updates existing anno entry', async () => {
      const existing = {
        mcpServers: {
          anno: { command: 'old-command', args: ['--old'] },
          other: { command: 'other-mcp', args: [] },
        },
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(existing));

      await runSetup(platform);

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      const written = JSON.parse(content);
      expect(written.mcpServers.anno.command).toBe('anno-mcp');
      expect(written.mcpServers.anno.args).toEqual([]);
      expect(written.mcpServers.other).toEqual(existing.mcpServers.other);
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Updated'));
    });

    it('prints "Added" for fresh install', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)   // dir exists
        .mockReturnValueOnce(false); // file does not exist

      await runSetup(platform);
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Added'));
    });

    it('handles config with missing mcpServers key', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify({ someOtherKey: true }));

      await runSetup(platform);

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      const written = JSON.parse(content);
      expect(written.mcpServers.anno.command).toBe('anno-mcp');
    });

    it('backs up and overwrites invalid JSON config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('not valid json {{{');

      await runSetup(platform);

      expect(mockWriteFile).toHaveBeenCalledWith(
        `${configPath}.backup`,
        'not valid json {{{',
        'utf-8',
      );
      expect(consoleSpy.warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));

      const configWrite = mockWriteFile.mock.calls.find((c) => (c as string[])[0] === configPath);
      expect(configWrite).toBeDefined();
      const written = JSON.parse((configWrite as string[])[1]);
      expect(written.mcpServers.anno.command).toBe('anno-mcp');
    });

    it('handles empty file as invalid JSON gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('');

      await runSetup(platform);

      const backupWrite = mockWriteFile.mock.calls.find(
        (c) => (c as string[])[0].endsWith('.backup'),
      );
      expect(backupWrite).toBeUndefined();

      const configWrite = mockWriteFile.mock.calls.find(
        (c) => (c as string[])[0] === configPath,
      );
      expect(configWrite).toBeDefined();
    });

    it('writes pretty-printed JSON with trailing newline', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      await runSetup(platform);

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toMatch(/\n$/);
      expect(content).toContain('  ');
    });

    it('prints platform-specific restart hint', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      await runSetup(platform);

      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining(label));
    });

    it('includes ANNO_BASE_URL in env config', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      await runSetup(platform);

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      const written = JSON.parse(content);
      expect(written.mcpServers.anno.env.ANNO_BASE_URL).toBe('http://localhost:5213');
    });

    it('prints next-steps instructions', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      await runSetup(platform);

      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Next steps'));
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('anno start'));
    });
  });

  // -------------------------------------------------------------------------
  // OpenClaw skill setup
  // -------------------------------------------------------------------------

  describe('openclaw setup (Skill)', () => {
    const skillDir = '/fakehome/.openclaw/skills/anno';
    const skillPath = '/fakehome/.openclaw/skills/anno/SKILL.md';

    it('creates skill directory when it does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      expect(mockMkdir).toHaveBeenCalledWith(skillDir, { recursive: true });
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Created'));
    });

    it('writes SKILL.md to the skill directory', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [path, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(path).toBe(skillPath);
      expect(content).toContain('name: anno');
      expect(content).toContain('Extract clean, structured');
    });

    it('skill content has valid YAML frontmatter', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/\n---\n/);
    });

    it('skill content includes install metadata for auto-install', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toContain('"install"');
      expect(content).toContain('@evointel/anno');
      expect(content).toContain('"bins": ["anno"]');
    });

    it('skill content includes trigger phrases', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toContain('When to use');
      expect(content).toContain('INSTEAD of directly fetching');
      expect(content).toContain('Do NOT use curl to fetch raw HTML');
    });

    it('skill content includes API examples', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toContain('/v1/content/fetch');
      expect(content).toContain('/v1/content/batch-fetch');
      expect(content).toContain('/v1/crawl');
    });

    it('skill content includes token savings table', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toContain('86,399');
      expect(content).toContain('99.1%');
      expect(content).toContain('93% reduction');
    });

    it('prints "Installed" for fresh install', async () => {
      mockExistsSync
        .mockReturnValueOnce(false)  // skillDir doesn't exist
        .mockReturnValueOnce(false); // SKILL.md doesn't exist

      await runSetup('openclaw');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Installed'));
    });

    it('prints "Updated" when skill already exists', async () => {
      mockExistsSync.mockReturnValue(true); // both dir and file exist

      await runSetup('openclaw');
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Updated'));
    });

    it('prints next-steps with OpenClaw restart hint', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('anno start'));
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Restart OpenClaw'));
    });

    it('mentions token savings in output', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('93%'));
    });

    it('skill content includes health check', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toContain('/health');
    });

    it('skill content includes fallback behavior', async () => {
      mockExistsSync.mockReturnValue(false);
      await runSetup('openclaw');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toContain('fall back');
      expect(content).toContain('increased token usage');
    });
  });

  // -------------------------------------------------------------------------
  // API platforms (ChatGPT, Gemini, Grok, Kimi, Ollama)
  // -------------------------------------------------------------------------

  describe.each([
    { platform: 'chatgpt', label: 'ChatGPT', keyContent: 'Custom GPT' },
    { platform: 'gemini', label: 'Gemini', keyContent: 'function declaration' },
    { platform: 'grok', label: 'Grok', keyContent: 'tool definition' },
    { platform: 'kimi', label: 'Kimi', keyContent: 'OpenAI-compatible' },
    { platform: 'ollama', label: 'Ollama', keyContent: '/api/chat' },
  ])('$platform setup (API)', ({ platform, label, keyContent }) => {
    it('prints integration instructions', async () => {
      await runSetup(platform);

      const allLogs = consoleSpy.log.mock.calls.map((c) => c.join(' ')).join(' ');
      expect(allLogs).toContain(label);
      expect(allLogs).toContain(keyContent);
    });

    it('includes Anno API reference', async () => {
      await runSetup(platform);

      const allLogs = consoleSpy.log.mock.calls.map((c) => c.join(' ')).join(' ');
      expect(allLogs).toContain('/v1/content/fetch');
      expect(allLogs).toContain('http://localhost:5213');
    });

    it('includes docs URL', async () => {
      await runSetup(platform);

      const allLogs = consoleSpy.log.mock.calls.map((c) => c.join(' ')).join(' ');
      expect(allLogs).toContain('Docs:');
      expect(allLogs).toContain('http');
    });

    it('does not write any files', async () => {
      await runSetup(platform);
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('does not call process.exit', async () => {
      await runSetup(platform);
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('includes function/tool schema or API action details', async () => {
      await runSetup(platform);

      const allLogs = consoleSpy.log.mock.calls.map((c) => c.join(' ')).join(' ');
      // All API platforms include either a function name or action schema
      expect(allLogs).toMatch(/extract_web_content|Action|OpenAPI/);
    });
  });

  // -------------------------------------------------------------------------
  // Command metadata
  // -------------------------------------------------------------------------

  describe('command metadata', () => {
    it('has correct name', () => {
      expect(setupCommand.name()).toBe('setup');
    });

    it('has a description', () => {
      expect(setupCommand.description()).toBeTruthy();
    });

    it('requires a platform argument', () => {
      const args = setupCommand.registeredArguments;
      expect(args).toHaveLength(1);
      expect(args[0].required).toBe(true);
    });

    it('lists all platforms in the argument description', () => {
      const argDesc = setupCommand.registeredArguments[0].description;
      expect(argDesc).toContain('claude-code');
      expect(argDesc).toContain('openclaw');
      expect(argDesc).toContain('chatgpt');
    });
  });
});
