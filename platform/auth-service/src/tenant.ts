/**
 * Tenant Management Service
 * Future-Proof, Modular, Dynamic, and Consistent tenant isolation
 */

export interface Tenant {
  id: string;
  name: string;
  domain: string;
  plan: 'trial' | 'starter' | 'professional' | 'enterprise';
  limits: TenantLimits;
  features: string[];
  status: 'active' | 'suspended' | 'trial' | 'expired';
  createdAt: Date;
  updatedAt: Date;
  trialEndsAt?: Date;
  billingInfo?: BillingInfo;
  compliance: ComplianceSettings;
}

export interface TenantLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
  concurrentRequests: number;
  dataRetentionDays: number;
  maxNodesPerRequest: number;
  maxUrlsPerBatch: number;
  storageQuotaGB: number;
  customFeatures: string[];
}

export interface APIKey {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  keyPrefix: string; // First 8 chars for identification
  permissions: string[];
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  status: 'active' | 'revoked' | 'expired';
  metadata?: Record<string, any>;
}

export interface BillingInfo {
  customerId: string;
  subscriptionId: string;
  paymentMethodId?: string;
  billingCycle: 'monthly' | 'yearly';
  nextBillingDate: Date;
  autoRenew: boolean;
}

export interface ComplianceSettings {
  dataResidency: 'us' | 'eu' | 'global';
  encryptionLevel: 'standard' | 'enhanced' | 'military';
  auditLogging: boolean;
  dataRetention: {
    apiLogs: number; // days
    extractedData: number; // days
    auditLogs: number; // days
  };
  gdprCompliance: boolean;
  soc2Compliance: boolean;
}

export interface CurrentUsage {
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
  concurrentRequests: number;
  storageUsedGB: number;
  lastResetDate: Date;
}

export class TenantService {
  constructor(
    private tenantRepository: TenantRepository,
    private apiKeyRepository: APIKeyRepository,
    private usageRepository: UsageRepository,
    private billingService: BillingService,
    private notificationService: NotificationService
  ) {}

  /**
   * Create a new tenant with proper isolation and default settings
   */
  async createTenant(request: CreateTenantRequest): Promise<Tenant> {
    // 1. Validate company domain and contact information
    await this.validateCompany(request.companyDomain);
    
    // 2. Generate unique tenant ID
    const tenantId = await this.generateTenantId();
    
    // 3. Create tenant record with appropriate plan limits
    const tenant = await this.tenantRepository.create({
      id: tenantId,
      name: request.companyName,
      domain: request.companyDomain,
      plan: 'trial',
      limits: this.getTrialLimits(),
      features: this.getTrialFeatures(),
      status: 'trial',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
      createdAt: new Date(),
      updatedAt: new Date(),
      compliance: this.getDefaultComplianceSettings(request.region)
    });

    // 4. Generate initial API key
    const apiKey = await this.generateAPIKey(tenant.id, 'default', ['read', 'write']);
    
    // 5. Set up tenant-specific resources
    await this.setupTenantResources(tenant);
    
    // 6. Initialize usage tracking
    await this.usageRepository.initialize(tenant.id);
    
    // 7. Set up monitoring and alerting
    await this.setupMonitoring(tenant);
    
    // 8. Send welcome email with credentials
    await this.notificationService.sendWelcomeEmail(tenant, apiKey);
    
    return tenant;
  }

  /**
   * Validate API key and return tenant context
   */
  async validateAPIKey(apiKey: string): Promise<{
    tenant: Tenant;
    key: APIKey;
    permissions: string[];
    usage: CurrentUsage;
  } | null> {
    // 1. Find API key
    const key = await this.apiKeyRepository.findByHash(this.hashAPIKey(apiKey));
    if (!key || key.status !== 'active') {
      return null;
    }

    // 2. Check expiration
    if (key.expiresAt && key.expiresAt < new Date()) {
      await this.revokeAPIKey(key.id, 'expired');
      return null;
    }

    // 3. Get tenant information
    const tenant = await this.tenantRepository.findById(key.tenantId);
    if (!tenant || tenant.status !== 'active') {
      return null;
    }

    // 4. Check trial expiration
    if (tenant.status === 'trial' && tenant.trialEndsAt && tenant.trialEndsAt < new Date()) {
      await this.expireTrial(tenant.id);
      return null;
    }

    // 5. Get current usage
    const usage = await this.usageRepository.getCurrentUsage(tenant.id);

    // 6. Check rate limits
    if (this.exceedsLimits(tenant.limits, usage)) {
      throw new RateLimitExceededError(tenant.limits, usage);
    }

    // 7. Update last used timestamp
    await this.apiKeyRepository.updateLastUsed(key.id);

    return {
      tenant,
      key,
      permissions: key.permissions,
      usage
    };
  }

  /**
   * Upgrade tenant to a higher plan
   */
  async upgradeTenant(tenantId: string, newPlan: string, billingInfo?: any): Promise<void> {
    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }

    const newLimits = this.getPlanLimits(newPlan);
    const newFeatures = this.getPlanFeatures(newPlan);

    // Update tenant
    await this.tenantRepository.update(tenantId, {
      plan: newPlan,
      limits: newLimits,
      features: newFeatures,
      status: 'active', // Ensure active status
      updatedAt: new Date()
    });

    // Update billing if provided
    if (billingInfo) {
      await this.billingService.updateSubscription(tenantId, newPlan, billingInfo);
    }

    // Update monitoring thresholds
    await this.updateMonitoringLimits(tenantId, newLimits);

    // Notify tenant
    await this.notificationService.sendPlanUpgradeNotification(tenantId, newPlan);
  }

  /**
   * Suspend tenant due to policy violations or payment issues
   */
  async suspendTenant(tenantId: string, reason: string, duration?: number): Promise<void> {
    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }

    await this.tenantRepository.update(tenantId, {
      status: 'suspended',
      updatedAt: new Date()
    });

    // Revoke all API keys
    await this.apiKeyRepository.revokeAllForTenant(tenantId);

    // Log suspension
    await this.logTenantAction(tenantId, 'suspended', reason);

    // Notify tenant
    await this.notificationService.sendSuspensionNotification(tenantId, reason, duration);
  }

  /**
   * Generate new API key for tenant
   */
  async generateAPIKey(
    tenantId: string, 
    name: string, 
    permissions: string[],
    expiresAt?: Date
  ): Promise<APIKey> {
    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }

    // Generate secure API key
    const apiKey = this.generateSecureAPIKey();
    const keyHash = this.hashAPIKey(apiKey);
    const keyPrefix = apiKey.substring(0, 8);

    const key = await this.apiKeyRepository.create({
      id: this.generateKeyId(),
      tenantId,
      name,
      keyHash,
      keyPrefix,
      permissions,
      expiresAt,
      createdAt: new Date(),
      status: 'active'
    });

    return { ...key, keyPrefix };
  }

  /**
   * Revoke API key
   */
  async revokeAPIKey(keyId: string, reason: string): Promise<void> {
    await this.apiKeyRepository.update(keyId, {
      status: 'revoked',
      updatedAt: new Date()
    });

    await this.logAPIKeyAction(keyId, 'revoked', reason);
  }

  /**
   * Get tenant usage statistics
   */
  async getTenantUsage(tenantId: string, period: 'day' | 'week' | 'month'): Promise<any> {
    const tenant = await this.tenantRepository.findById(tenantId);
    if (!tenant) {
      throw new TenantNotFoundError(tenantId);
    }

    const usage = await this.usageRepository.getUsageStats(tenantId, period);
    const limits = tenant.limits;

    return {
      usage,
      limits,
      utilization: {
        requests: (usage.requests / limits.requestsPerMonth) * 100,
        storage: (usage.storage / limits.storageQuotaGB) * 100,
        concurrent: (usage.concurrent / limits.concurrentRequests) * 100
      }
    };
  }

  // Private helper methods

  private async generateTenantId(): Promise<string> {
    let tenantId: string;
    do {
      tenantId = `tenant_${this.generateRandomString(16)}`;
    } while (await this.tenantRepository.exists(tenantId));
    return tenantId;
  }

  private async generateKeyId(): Promise<string> {
    return `key_${this.generateRandomString(16)}`;
  }

  private generateSecureAPIKey(): string {
    const prefix = 'anno_';
    const randomBytes = require('crypto').randomBytes(32);
    const suffix = randomBytes.toString('base64').replace(/[+/=]/g, '');
    return `${prefix}${suffix}`;
  }

  private hashAPIKey(apiKey: string): string {
    return require('crypto')
      .createHash('sha256')
      .update(apiKey)
      .digest('hex');
  }

  private generateRandomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  private getTrialLimits(): TenantLimits {
    return {
      requestsPerMinute: 10,
      requestsPerDay: 1000,
      requestsPerMonth: 10000,
      concurrentRequests: 2,
      dataRetentionDays: 7,
      maxNodesPerRequest: 20,
      maxUrlsPerBatch: 5,
      storageQuotaGB: 1,
      customFeatures: []
    };
  }

  private getTrialFeatures(): string[] {
    return ['basic_extraction', 'api_access'];
  }

  private getPlanLimits(plan: string): TenantLimits {
    const plans = {
      trial: this.getTrialLimits(),
      starter: {
        requestsPerMinute: 60,
        requestsPerDay: 10000,
        requestsPerMonth: 100000,
        concurrentRequests: 10,
        dataRetentionDays: 30,
        maxNodesPerRequest: 50,
        maxUrlsPerBatch: 10,
        storageQuotaGB: 10,
        customFeatures: []
      },
      professional: {
        requestsPerMinute: 300,
        requestsPerDay: 100000,
        requestsPerMonth: 1000000,
        concurrentRequests: 50,
        dataRetentionDays: 90,
        maxNodesPerRequest: 100,
        maxUrlsPerBatch: 25,
        storageQuotaGB: 100,
        customFeatures: ['custom_models', 'priority_processing']
      },
      enterprise: {
        requestsPerMinute: 1000,
        requestsPerDay: 1000000,
        requestsPerMonth: -1, // unlimited
        concurrentRequests: 200,
        dataRetentionDays: 365,
        maxNodesPerRequest: 500,
        maxUrlsPerBatch: 100,
        storageQuotaGB: 1000,
        customFeatures: ['all_features', 'custom_deployment', 'dedicated_support']
      }
    };
    return plans[plan] || this.getTrialLimits();
  }

  private getPlanFeatures(plan: string): string[] {
    const features = {
      trial: this.getTrialFeatures(),
      starter: ['basic_extraction', 'api_access', 'batch_processing'],
      professional: ['advanced_extraction', 'custom_models', 'priority_support', 'analytics'],
      enterprise: ['all_features', 'custom_deployment', 'dedicated_support', 'sla_guarantee']
    };
    return features[plan] || this.getTrialFeatures();
  }

  private getDefaultComplianceSettings(region?: string): ComplianceSettings {
    return {
      dataResidency: region === 'eu' ? 'eu' : 'us',
      encryptionLevel: 'standard',
      auditLogging: true,
      dataRetention: {
        apiLogs: 90,
        extractedData: 30,
        auditLogs: 365
      },
      gdprCompliance: region === 'eu',
      soc2Compliance: false
    };
  }

  private exceedsLimits(limits: TenantLimits, usage: CurrentUsage): boolean {
    return usage.requestsPerMinute > limits.requestsPerMinute ||
           usage.requestsPerDay > limits.requestsPerDay ||
           usage.requestsPerMonth > limits.requestsPerMonth ||
           usage.concurrentRequests > limits.concurrentRequests ||
           usage.storageUsedGB > limits.storageQuotaGB;
  }

  private async setupTenantResources(tenant: Tenant): Promise<void> {
    // Create tenant-specific database schema
    await this.databaseService.createTenantSchema(tenant.id);
    
    // Set up tenant-specific cache namespace
    await this.cacheService.createTenantNamespace(tenant.id);
    
    // Initialize tenant-specific storage bucket
    await this.storageService.createTenantBucket(tenant.id);
  }

  private async setupMonitoring(tenant: Tenant): Promise<void> {
    // Set up tenant-specific metrics
    await this.monitoringService.createTenantDashboards(tenant.id);
    
    // Configure alerting rules
    await this.monitoringService.setupTenantAlerts(tenant.id, tenant.limits);
  }

  private async updateMonitoringLimits(tenantId: string, limits: TenantLimits): Promise<void> {
    await this.monitoringService.updateTenantLimits(tenantId, limits);
  }

  private async expireTrial(tenantId: string): Promise<void> {
    await this.tenantRepository.update(tenantId, {
      status: 'expired',
      updatedAt: new Date()
    });

    await this.logTenantAction(tenantId, 'trial_expired', 'Trial period ended');
    await this.notificationService.sendTrialExpirationNotification(tenantId);
  }

  private async logTenantAction(tenantId: string, action: string, reason: string): Promise<void> {
    await this.auditService.log({
      tenantId,
      action,
      reason,
      timestamp: new Date(),
      type: 'tenant_action'
    });
  }

  private async logAPIKeyAction(keyId: string, action: string, reason: string): Promise<void> {
    await this.auditService.log({
      keyId,
      action,
      reason,
      timestamp: new Date(),
      type: 'api_key_action'
    });
  }

  private async validateCompany(domain: string): Promise<void> {
    // Implement domain validation logic
    // This could include checking MX records, WHOIS data, etc.
    const isValid = await this.domainValidator.validate(domain);
    if (!isValid) {
      throw new InvalidCompanyDomainError(domain);
    }
  }
}

// Error classes
export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

export class RateLimitExceededError extends Error {
  constructor(limits: TenantLimits, usage: CurrentUsage) {
    super('Rate limit exceeded');
    this.name = 'RateLimitExceededError';
    this.limits = limits;
    this.usage = usage;
  }
  limits: TenantLimits;
  usage: CurrentUsage;
}

export class InvalidCompanyDomainError extends Error {
  constructor(domain: string) {
    super(`Invalid company domain: ${domain}`);
    this.name = 'InvalidCompanyDomainError';
  }
}

// Request/Response interfaces
export interface CreateTenantRequest {
  companyName: string;
  companyDomain: string;
  contactEmail: string;
  region?: string;
  complianceRequirements?: string[];
}

export interface TenantRepository {
  create(tenant: Omit<Tenant, 'id'>): Promise<Tenant>;
  findById(id: string): Promise<Tenant | null>;
  update(id: string, updates: Partial<Tenant>): Promise<void>;
  exists(id: string): Promise<boolean>;
  findByDomain(domain: string): Promise<Tenant | null>;
}

export interface APIKeyRepository {
  create(key: Omit<APIKey, 'id'>): Promise<APIKey>;
  findByHash(hash: string): Promise<APIKey | null>;
  update(id: string, updates: Partial<APIKey>): Promise<void>;
  updateLastUsed(id: string): Promise<void>;
  revokeAllForTenant(tenantId: string): Promise<void>;
}

export interface UsageRepository {
  initialize(tenantId: string): Promise<void>;
  getCurrentUsage(tenantId: string): Promise<CurrentUsage>;
  getUsageStats(tenantId: string, period: string): Promise<any>;
  incrementUsage(tenantId: string, metrics: Partial<CurrentUsage>): Promise<void>;
}
