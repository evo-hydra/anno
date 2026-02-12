import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config/env', () => ({
  config: {
    policies: {
      enabled: true,
      dir: '/fake/policies',
      validationEnabled: true,
    },
  },
}));

// js-yaml is used by the module — we let it through but we will control
// what readFileSync returns to produce the YAML content we need.
// Since the source does `import * as yaml from 'js-yaml'` and calls yaml.load,
// we mock it to simply parse JSON (our test data will be JSON-compatible objects).
vi.mock('js-yaml', () => ({
  load: vi.fn((content: string) => JSON.parse(content)),
}));

import { existsSync, readFileSync, readdirSync } from 'fs';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);

// ---------------------------------------------------------------------------
// We cannot import the singleton because it runs init-related side effects.
// Instead, we dynamically import the module so our mocks are in place.
// The PolicyEngine class is not exported directly, but the module exports
// `policyEngine` (singleton). We re-import for each test set.
// ---------------------------------------------------------------------------

// Inline helper to get a fresh PolicyEngine instance by re-importing
async function createPolicyEngine() {
  // We need access to the class. Since only the singleton is exported,
  // we will use the module's exported policyEngine but reset it.
  // Better approach: import the module and use the class through the singleton.
  const mod = await import('../services/policy-engine');
  // The PolicyEngine class is used internally. We can construct it via
  // the module's default export patterns. Since it's not exported as a class,
  // we use the singleton's constructor:
  const engine = Object.create(Object.getPrototypeOf(mod.policyEngine));
  // Reset internal state
  (engine as Record<string, unknown>).policies = new Map();
  (engine as Record<string, unknown>).policyFingerprint = null;
  (engine as Record<string, unknown>).initialized = false;
  return engine as typeof mod.policyEngine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PolicyEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // init
  // -----------------------------------------------------------------------

  it('uses default policy when policy dir does not exist', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(false);

    await engine.init();

    const policies = engine.getPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toBe('default');
  });

  it('uses default policy when policy dir has no YAML files', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    await engine.init();

    const policies = engine.getPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toBe('default');
  });

  it('loads YAML policy files from directory', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([
      'news.yaml',
      'docs.yml',
      'readme.txt', // should be ignored
    ] as unknown as ReturnType<typeof readdirSync>);

    const newsPolicy = JSON.stringify({
      name: 'news',
      domain: '*.nytimes.com',
      drop: [{ selector: '.ad' }],
    });
    const docsPolicy = JSON.stringify({
      name: 'docs',
      domain: '*.docs.example.com',
      keep: [{ selector: 'article' }],
    });

    mockedReadFileSync.mockImplementation((filePath: unknown) => {
      const path = String(filePath);
      if (path.includes('news.yaml')) return newsPolicy;
      if (path.includes('docs.yml')) return docsPolicy;
      return '';
    });

    await engine.init();

    const policies = engine.getPolicies();
    expect(policies).toHaveLength(2);
    const names = policies.map((p) => p.name);
    expect(names).toContain('news');
    expect(names).toContain('docs');
  });

  // -----------------------------------------------------------------------
  // selectPolicy
  // -----------------------------------------------------------------------

  it('selectPolicy matches by domain pattern', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['news.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'news',
        domain: '*.nytimes.com',
        drop: [{ selector: '.ad' }],
      })
    );

    await engine.init();

    const policy = engine.selectPolicy('https://www.nytimes.com/article/123');
    expect(policy.name).toBe('news');
  });

  it('selectPolicy falls back to default when no domain matches', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['news.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'news',
        domain: '*.nytimes.com',
        drop: [{ selector: '.ad' }],
      })
    );

    await engine.init();

    const policy = engine.selectPolicy('https://example.com/page');
    // Should fall back to the generated default policy
    expect(policy.name).toBe('default');
  });

  it('selectPolicy uses policy hint when provided', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['news.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'news',
        domain: '*.nytimes.com',
        drop: [{ selector: '.ad' }],
      })
    );

    await engine.init();

    const policy = engine.selectPolicy('https://example.com/page', 'news');
    expect(policy.name).toBe('news');
  });

  // -----------------------------------------------------------------------
  // applyPolicy
  // -----------------------------------------------------------------------

  it('applyPolicy removes elements matching drop selectors', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(false);

    await engine.init();

    // Default policy drops <script>, <style>, <iframe>, .ad, .advertisement
    const html = `<html><body>
      <script>alert("hi")</script>
      <style>.x{}</style>
      <div class="ad">Ad banner</div>
      <p>Real content</p>
    </body></html>`;

    const result = engine.applyPolicy(html, 'https://example.com/page');
    expect(result.policyApplied).toBe('default');
    expect(result.transformedHtml).not.toContain('<script>');
    expect(result.transformedHtml).not.toContain('<style>');
    expect(result.transformedHtml).not.toContain('Ad banner');
    expect(result.transformedHtml).toContain('Real content');
    expect(result.rulesMatched).toBeGreaterThan(0);
  });

  it('applyPolicy keeps only elements matching keep selectors', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['docs.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'docs',
        domain: '*.docs.example.com',
        keep: [{ selector: 'article' }],
        drop: [],
      })
    );

    await engine.init();

    const html = `<html><body>
      <nav>Navigation</nav>
      <article><p>Important docs</p></article>
      <footer>Footer</footer>
    </body></html>`;

    const result = engine.applyPolicy(
      html,
      'https://api.docs.example.com/page'
    );
    expect(result.policyApplied).toBe('docs');
    expect(result.transformedHtml).toContain('Important docs');
    // The nav and footer should not appear since only <article> is kept
    expect(result.transformedHtml).not.toContain('Navigation');
    expect(result.transformedHtml).not.toContain('Footer');
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  it('validates fields and reports missing required fields', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(false);

    await engine.init();

    // Default policy has fields: title(required), main(required, minLength:50)
    const html = `<html><body><p>Short</p></body></html>`;
    const result = engine.applyPolicy(html, 'https://example.com/page');

    // Fields are validated against an empty extractedFields object,
    // so required fields will be flagged as missing
    expect(result.fieldsValidated).toBe(false);
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.validationErrors).toContain("Required field 'title' is missing");
    expect(result.validationErrors).toContain("Required field 'main' is missing");
  });

  it('falls back to default when policy has no name (validation error)', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['bad.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        // name is missing!
        drop: [{ selector: '.ad' }],
      })
    );

    // init catches the validation error and falls back to default
    await engine.init();

    const policies = engine.getPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toBe('default');

    // The error should have been logged
    const { logger } = await import('../utils/logger');
    expect(logger.error).toHaveBeenCalled();
  });

  it('falls back to default when policy rule has neither selector nor regex', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['bad.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'bad-policy',
        drop: [{ action: 'drop' }], // no selector or regex
      })
    );

    // init catches the validation error and falls back to default
    await engine.init();

    const policies = engine.getPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0].name).toBe('default');

    const { logger } = await import('../utils/logger');
    expect(logger.error).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // getFingerprint
  // -----------------------------------------------------------------------

  it('getFingerprint returns null before init', async () => {
    const engine = await createPolicyEngine();
    expect(engine.getFingerprint()).toBeNull();
  });

  it('getFingerprint returns a hash string after loading policies', async () => {
    const engine = await createPolicyEngine();
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(['news.yaml'] as unknown as ReturnType<typeof readdirSync>);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        name: 'news',
        domain: '*.news.com',
        drop: [{ selector: '.ad' }],
      })
    );

    await engine.init();

    const fingerprint = engine.getFingerprint();
    expect(fingerprint).not.toBeNull();
    expect(typeof fingerprint).toBe('string');
    expect(fingerprint!.length).toBe(8); // SHA-256 hex, sliced to 8 chars
  });

  // -----------------------------------------------------------------------
  // selectPolicy throws if not initialized
  // -----------------------------------------------------------------------

  it('selectPolicy throws if engine is not initialized', async () => {
    const engine = await createPolicyEngine();
    expect(() => engine.selectPolicy('https://example.com')).toThrow(
      'Policy engine not initialized'
    );
  });
});
