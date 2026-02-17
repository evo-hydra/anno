import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock filesystem and os modules before importing the setup command.
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn<(path: string) => boolean>();
const mockMkdir = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockReadFile = vi.fn<() => Promise<string>>();
const mockWriteFile = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockHomedir = vi.fn(() => '/fakehome');

vi.mock('fs', () => ({ existsSync: mockExistsSync }));
vi.mock('fs/promises', () => ({ readFile: mockReadFile, writeFile: mockWriteFile, mkdir: mockMkdir }));
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
      await runSetup('vscode');
      expect(consoleSpy.error).toHaveBeenCalledWith(expect.stringContaining('Unknown platform'));
      expect(consoleSpy.error).toHaveBeenCalledWith(expect.stringContaining('claude-code'));
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('is case-insensitive', async () => {
      // Should not error — should proceed to filesystem ops
      mockExistsSync.mockReturnValue(false);
      await runSetup('Claude-Code');
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('claude-code setup', () => {
    const configDir = '/fakehome/.claude';
    const configPath = '/fakehome/.claude/.mcp.json';

    it('creates ~/.claude/ directory when it does not exist', async () => {
      mockExistsSync.mockReturnValue(false); // neither dir nor file exist

      await runSetup('claude-code');

      expect(mockMkdir).toHaveBeenCalledWith(configDir, { recursive: true });
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Created'));
    });

    it('writes new config when no config file exists', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)   // configDir exists
        .mockReturnValueOnce(false); // configPath does not exist

      await runSetup('claude-code');

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

      await runSetup('claude-code');

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

      await runSetup('claude-code');

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

      await runSetup('claude-code');

      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Added'));
    });

    it('handles config with missing mcpServers key', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify({ someOtherKey: true }));

      await runSetup('claude-code');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      const written = JSON.parse(content);
      expect(written.mcpServers.anno.command).toBe('anno-mcp');
    });

    it('backs up and overwrites invalid JSON config', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('not valid json {{{');

      await runSetup('claude-code');

      // Should back up the broken file
      expect(mockWriteFile).toHaveBeenCalledWith(
        `${configPath}.backup`,
        'not valid json {{{',
        'utf-8',
      );
      expect(consoleSpy.warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));

      // Should still write a valid config
      const writeCalls = mockWriteFile.mock.calls;
      const configWrite = writeCalls.find((c) => (c as string[])[0] === configPath);
      expect(configWrite).toBeDefined();
      const written = JSON.parse((configWrite as string[])[1]);
      expect(written.mcpServers.anno.command).toBe('anno-mcp');
    });

    it('handles empty file as invalid JSON gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      // First readFile call is in the try block (JSON.parse fails on empty string)
      // Second readFile call is in the catch block for backup
      mockReadFile
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('');

      await runSetup('claude-code');

      // Empty string should not be backed up (no content)
      const backupWrite = mockWriteFile.mock.calls.find(
        (c) => (c as string[])[0].endsWith('.backup'),
      );
      expect(backupWrite).toBeUndefined();

      // Should still write valid config
      const configWrite = mockWriteFile.mock.calls.find(
        (c) => (c as string[])[0] === configPath,
      );
      expect(configWrite).toBeDefined();
    });

    it('writes pretty-printed JSON with trailing newline', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      await runSetup('claude-code');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      expect(content).toMatch(/\n$/);
      // Verify it's indented (pretty-printed)
      expect(content).toContain('  ');
    });

    it('prints next-steps instructions', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      await runSetup('claude-code');

      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Next steps'));
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('anno start'));
      expect(consoleSpy.log).toHaveBeenCalledWith(expect.stringContaining('Restart Claude Code'));
    });

    it('includes ANNO_BASE_URL in env config', async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      await runSetup('claude-code');

      const [, content] = mockWriteFile.mock.calls[0] as [string, string, string];
      const written = JSON.parse(content);
      expect(written.mcpServers.anno.env.ANNO_BASE_URL).toBe('http://localhost:5213');
    });
  });

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
  });
});
