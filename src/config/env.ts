export interface AppConfig {
  port: number;
  cache: {
    maxEntries: number;
    ttlMs: number;
    encryptionKey?: string;
  };
  redis: {
    enabled: boolean;
    url: string;
    ttlMs: number;
  };
  fetch: {
    userAgent: string;
    timeoutMs: number;
    respectRobots: boolean;
    overrideRobots: boolean;
  };
  rendering: {
    enabled: boolean;
    timeoutMs: number;
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
    headless: boolean;
    maxPages: number;
    stealth: boolean;
    proxy?: string;
  };
  metrics: {
    allowReset: boolean;
    resetToken?: string;
    enableStageMetrics: boolean;
  };
  ai: {
    embeddingProvider: string;
    llmProvider: string;
    vectorStoreProvider: string;
    summarizer: 'heuristic' | 'llm';
    defaultK: number;
  };
  policies: {
    enabled: boolean;
    dir: string;
    defaultPolicy: string;
    validationEnabled: boolean;
  };
  ssrf: {
    enabled: boolean;
    allowedHosts: string[];
    blockedHosts: string[];
    allowPrivateIPs: boolean;
  };
  domains: {
    configPath: string;
  };
  auth: {
    enabled: boolean;
    apiKeys: string[];
    rateLimitPerKey: number;
    bypassInDev: boolean;
    adminKey?: string;
  };
  quota: {
    enabled: boolean;
    tiers: Record<string, { monthlyLimit: number; burstPerMinute: number }>;
  };
}

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const booleanFromEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }

  if (value.toLowerCase() === 'true') {
    return true;
  }

  if (value.toLowerCase() === 'false') {
    return false;
  }

  return fallback;
};

const waitUntilFromEnv = (value: string | undefined, fallback: 'load' | 'domcontentloaded' | 'networkidle') => {
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'load' || normalized === 'domcontentloaded' || normalized === 'networkidle') {
    return normalized;
  }

  return fallback;
};

export const config: AppConfig = {
  port: numberFromEnv(process.env.PORT, 5213),
  cache: {
    maxEntries: numberFromEnv(process.env.CACHE_MAX_ENTRIES, 128),
    ttlMs: numberFromEnv(process.env.CACHE_TTL_MS, 1000 * 60 * 5),
    encryptionKey: process.env.CACHE_ENCRYPTION_KEY
  },
  redis: {
    enabled: booleanFromEnv(
      process.env.REDIS_ENABLED,
      process.env.NODE_ENV === 'production' // Enable by default in production
    ),
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    ttlMs: numberFromEnv(process.env.REDIS_TTL_MS, 1000 * 60 * 60) // 1 hour default
  },
  fetch: {
    userAgent: process.env.USER_AGENT ?? 'Anno/1.0',
    timeoutMs: numberFromEnv(process.env.FETCH_TIMEOUT_MS, 15000),
    respectRobots: booleanFromEnv(process.env.RESPECT_ROBOTS, true),
    overrideRobots: booleanFromEnv(process.env.OVERRIDE_ROBOTS, false)
  },
  rendering: {
    enabled: booleanFromEnv(
      process.env.RENDERING_ENABLED,
      process.env.NODE_ENV === 'test' ? false : true
    ),
    timeoutMs: numberFromEnv(process.env.RENDER_TIMEOUT_MS, 20000),
    waitUntil: waitUntilFromEnv(process.env.RENDER_WAIT_UNTIL, 'networkidle'),
    headless: booleanFromEnv(process.env.RENDER_HEADLESS, true),
    maxPages: numberFromEnv(process.env.RENDER_MAX_PAGES, 2),
    stealth: booleanFromEnv(process.env.RENDER_STEALTH, true),
    proxy: process.env.PROXY_URL
  },
  metrics: {
    allowReset: booleanFromEnv(process.env.METRICS_RESET_ENABLED, false),
    resetToken: process.env.METRICS_RESET_TOKEN,
    enableStageMetrics: booleanFromEnv(process.env.ENABLE_STAGE_METRICS, true)
  },
  ai: {
    embeddingProvider: process.env.AI_EMBEDDING_PROVIDER ?? 'deterministic',
    llmProvider: process.env.AI_LLM_PROVIDER ?? 'none',
    vectorStoreProvider: process.env.AI_VECTOR_STORE ?? 'memory',
    summarizer: (process.env.AI_SUMMARIZER === 'llm' ? 'llm' : 'heuristic'),
    defaultK: numberFromEnv(process.env.AI_DEFAULT_K, 3)
  },
  policies: {
    enabled: booleanFromEnv(process.env.POLICY_ENABLED, true),
    dir: process.env.POLICY_DIR ?? './policies',
    defaultPolicy: process.env.DEFAULT_POLICY ?? 'default.yaml',
    validationEnabled: booleanFromEnv(process.env.POLICY_VALIDATION_ENABLED, true)
  },
  ssrf: {
    enabled: booleanFromEnv(process.env.SSRF_PROTECTION_ENABLED, true),
    allowedHosts: (process.env.SSRF_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    blockedHosts: (process.env.SSRF_BLOCKED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    allowPrivateIPs: booleanFromEnv(process.env.SSRF_ALLOW_PRIVATE_IPS, false),
  },
  domains: {
    configPath: process.env.DOMAIN_CONFIG_PATH ?? './config/domains.yaml'
  },
  auth: {
    enabled: booleanFromEnv(process.env.ANNO_AUTH_ENABLED, false),
    apiKeys: (process.env.ANNO_API_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    rateLimitPerKey: numberFromEnv(process.env.ANNO_RATE_LIMIT_PER_KEY, 60),
    bypassInDev: booleanFromEnv(process.env.ANNO_AUTH_BYPASS_DEV, true),
    adminKey: process.env.ANNO_ADMIN_KEY || undefined,
  },
  quota: {
    enabled: booleanFromEnv(process.env.ANNO_QUOTA_ENABLED, true),
    tiers: {
      free: {
        monthlyLimit: numberFromEnv(process.env.ANNO_QUOTA_FREE_MONTHLY, 200),
        burstPerMinute: numberFromEnv(process.env.ANNO_BURST_FREE_PER_MIN, 5),
      },
      pro: {
        monthlyLimit: numberFromEnv(process.env.ANNO_QUOTA_PRO_MONTHLY, 10_000),
        burstPerMinute: numberFromEnv(process.env.ANNO_BURST_PRO_PER_MIN, 60),
      },
      business: {
        monthlyLimit: numberFromEnv(process.env.ANNO_QUOTA_BIZ_MONTHLY, 50_000),
        burstPerMinute: numberFromEnv(process.env.ANNO_BURST_BIZ_PER_MIN, 200),
      },
    },
  },
};
