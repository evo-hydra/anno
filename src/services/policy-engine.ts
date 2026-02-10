/**
 * Policy Engine for Domain-Aware Distillation
 *
 * Applies transformation rules (keep/drop/transform) based on domain-specific policies.
 * Supports presets (news, docs, ecommerce, academic) and per-domain overrides.
 *
 * @module services/policy-engine
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import * as yaml from 'js-yaml';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { JSDOM } from 'jsdom';

// Policy schema types
export interface PolicyRule {
  selector?: string;
  regex?: string;
  action?: 'keep' | 'drop' | 'transform';
}

export interface FieldRequirement {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface Policy {
  name: string;
  version?: string;
  domain?: string; // Glob pattern like "*.nytimes.com"
  preset?: 'news' | 'docs' | 'ecommerce' | 'academic' | 'default';
  keep?: PolicyRule[];
  drop?: PolicyRule[];
  transform?: PolicyRule[];
  fields?: {
    title?: FieldRequirement;
    author?: FieldRequirement;
    main?: FieldRequirement;
    excerpt?: FieldRequirement;
  };
}

export interface PolicyApplicationResult {
  transformedHtml: string;
  policyApplied: string;
  rulesMatched: number;
  fieldsValidated: boolean;
  validationErrors: string[];
}

class PolicyEngine {
  private policies: Map<string, Policy> = new Map();
  private policyFingerprint: string | null = null;
  private initialized = false;

  /**
   * Initialize policy engine - load and validate all policies
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!config.policies.enabled) {
      logger.info('Policy engine: Disabled');
      return;
    }

    const policyDir = config.policies.dir;

    if (!existsSync(policyDir)) {
      logger.warn('Policy engine: Directory not found, creating default', { policyDir });
      // Create default policy if dir doesn't exist
      this.policies.set('default', this.getDefaultPolicy());
      this.initialized = true;
      return;
    }

    try {
      const files = readdirSync(policyDir).filter(
        (file) => extname(file) === '.yaml' || extname(file) === '.yml'
      );

      if (files.length === 0) {
        logger.warn('Policy engine: No policy files found, using default');
        this.policies.set('default', this.getDefaultPolicy());
        this.initialized = true;
        return;
      }

      for (const file of files) {
        const filePath = join(policyDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const policy = yaml.load(content) as Policy;

        // Validate policy
        if (config.policies.validationEnabled) {
          this.validatePolicy(policy, file);
        }

        this.policies.set(policy.name, policy);
        logger.info('Policy engine: Loaded policy', {
          name: policy.name,
          domain: policy.domain,
          preset: policy.preset
        });
      }

      // Compute fingerprint
      const policyData = Array.from(this.policies.values())
        .map((p) => JSON.stringify(p))
        .join('|');
      this.policyFingerprint = createHash('sha256').update(policyData).digest('hex').slice(0, 8);

      logger.info('Policy engine: Initialized', {
        count: this.policies.size,
        fingerprint: this.policyFingerprint
      });

      this.initialized = true;
    } catch (error) {
      logger.error('Policy engine: Initialization failed', {
        error: error instanceof Error ? error.message : 'unknown'
      });
      // Fallback to default policy
      this.policies.set('default', this.getDefaultPolicy());
      this.initialized = true;
    }
  }

  /**
   * Validate policy structure
   */
  private validatePolicy(policy: Policy, filename: string): void {
    if (!policy.name) {
      throw new Error(`Policy ${filename}: Missing 'name' field`);
    }

    // Validate rules
    const allRules = [...(policy.keep || []), ...(policy.drop || []), ...(policy.transform || [])];

    for (const rule of allRules) {
      if (!rule.selector && !rule.regex) {
        throw new Error(`Policy ${policy.name}: Rule must have 'selector' or 'regex'`);
      }
    }

    logger.debug('Policy validated', { name: policy.name, filename });
  }

  /**
   * Get default passthrough policy
   */
  private getDefaultPolicy(): Policy {
    return {
      name: 'default',
      version: '1.0.0',
      preset: 'default',
      keep: [],
      drop: [
        { selector: 'script' },
        { selector: 'style' },
        { selector: 'iframe' },
        { selector: '.ad' },
        { selector: '.advertisement' },
        { regex: 'Advertisement' }
      ],
      fields: {
        title: { required: true },
        main: { required: true, minLength: 50 }
      }
    };
  }

  /**
   * Select appropriate policy for a URL
   */
  selectPolicy(url: string, policyHint?: string): Policy {
    if (!this.initialized) {
      throw new Error('Policy engine not initialized');
    }

    // If hint provided, try to use it
    if (policyHint && this.policies.has(policyHint)) {
      logger.debug('Policy selected by hint', { url, policy: policyHint });
      return this.policies.get(policyHint)!;
    }

    // Try to match by domain
    const urlObj = new URL(url);
    const host = urlObj.hostname;

    for (const policy of this.policies.values()) {
      if (policy.domain && this.matchDomain(host, policy.domain)) {
        logger.debug('Policy selected by domain', { url, policy: policy.name, domain: policy.domain });
        return policy;
      }
    }

    // Fallback to default
    const defaultPolicy = this.policies.get('default') || this.getDefaultPolicy();
    logger.debug('Policy selected: default', { url });
    return defaultPolicy;
  }

  /**
   * Match hostname against glob pattern
   */
  private matchDomain(hostname: string, pattern: string): boolean {
    // Simple glob matching: *.example.com
    const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(hostname);
  }

  /**
   * Apply policy transformations to HTML
   */
  applyPolicy(html: string, url: string, policyHint?: string): PolicyApplicationResult {
    const policy = this.selectPolicy(url, policyHint);
    let rulesMatched = 0;

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Apply drop rules
    if (policy.drop) {
      for (const rule of policy.drop) {
        if (rule.selector) {
          const elements = document.querySelectorAll(rule.selector);
          rulesMatched += elements.length;
          elements.forEach((el) => el.remove());
        }
      }
    }

    // Apply regex-based drops on text content
    if (policy.drop) {
      for (const rule of policy.drop) {
        if (rule.regex) {
          const walker = document.createTreeWalker(
            document.body || document.documentElement,
            4 // NodeFilter.SHOW_TEXT
          );

          const textNodesToRemove: Node[] = [];
          let node;
          while ((node = walker.nextNode())) {
            if (node.textContent && new RegExp(rule.regex).test(node.textContent)) {
              textNodesToRemove.push(node);
              rulesMatched++;
            }
          }

          textNodesToRemove.forEach((n) => n.parentNode?.removeChild(n));
        }
      }
    }

    // Apply keep rules (isolate content)
    if (policy.keep && policy.keep.length > 0) {
      const keptElements: Element[] = [];

      for (const rule of policy.keep) {
        if (rule.selector) {
          const elements = document.querySelectorAll(rule.selector);
          rulesMatched += elements.length;
          elements.forEach((el) => keptElements.push(el));
        }
      }

      if (keptElements.length > 0) {
        // Create new document with only kept elements
        const newBody = document.createElement('body');
        keptElements.forEach((el) => newBody.appendChild(el.cloneNode(true)));
        document.body.replaceWith(newBody);
      }
    }

    const transformedHtml = dom.serialize();

    // Validate fields (this would be done post-distillation in practice)
    const { fieldsValidated, validationErrors } = this.validateFields(policy, {});

    return {
      transformedHtml,
      policyApplied: policy.name,
      rulesMatched,
      fieldsValidated,
      validationErrors
    };
  }

  /**
   * Validate extracted fields against policy requirements
   */
  private validateFields(
    policy: Policy,
    extractedFields: Record<string, string | null>
  ): { fieldsValidated: boolean; validationErrors: string[] } {
    const errors: string[] = [];

    if (!policy.fields) {
      return { fieldsValidated: true, validationErrors: [] };
    }

    for (const [field, requirements] of Object.entries(policy.fields)) {
      const value = extractedFields[field];

      if (requirements.required && !value) {
        errors.push(`Required field '${field}' is missing`);
      }

      if (value && requirements.minLength && value.length < requirements.minLength) {
        errors.push(`Field '${field}' is too short (min: ${requirements.minLength})`);
      }

      if (value && requirements.maxLength && value.length > requirements.maxLength) {
        errors.push(`Field '${field}' is too long (max: ${requirements.maxLength})`);
      }

      if (value && requirements.pattern && !new RegExp(requirements.pattern).test(value)) {
        errors.push(`Field '${field}' does not match pattern`);
      }
    }

    return {
      fieldsValidated: errors.length === 0,
      validationErrors: errors
    };
  }

  /**
   * Get policy version fingerprint
   */
  getFingerprint(): string | null {
    return this.policyFingerprint;
  }

  /**
   * Get all loaded policies
   */
  getPolicies(): Policy[] {
    return Array.from(this.policies.values());
  }
}

// Singleton instance
export const policyEngine = new PolicyEngine();
