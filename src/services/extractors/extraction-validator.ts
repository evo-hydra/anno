/**
 * Extraction Validator - OpenAI Production Standards
 *
 * Comprehensive validation framework with detailed diagnostics,
 * confidence scoring, and silent failure detection.
 *
 * @module extraction-validator
 */

import { logger } from '../../utils/logger';
import { MarketplaceListing, MarketplaceType } from './marketplace-adapter';

/**
 * Validation severity levels
 */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * Detailed validation issue
 */
export interface ValidationIssue {
  severity: ValidationSeverity;
  field: string;
  code: string;
  message: string;
  expected?: any;
  actual?: any;
  suggestion?: string;
}

/**
 * Comprehensive validation result
 */
export interface ValidationReport {
  valid: boolean;
  confidence: number; // 0.0 - 1.0
  issues: ValidationIssue[];
  fieldsCaptured: string[];
  fieldsRequested: string[];
  captureRate: number; // % of requested fields captured
  timestamp: string;
  validatorVersion: string;
}

/**
 * Validation rules for a marketplace
 */
export interface ValidationRules {
  required: string[];
  recommended: string[];
  optional: string[];
  minConfidence: number;
  fieldValidators?: Record<string, (value: any) => ValidationIssue | null>;
}

/**
 * Production-grade extraction validator
 */
export class ExtractionValidator {
  private readonly version = '1.0.0';

  /**
   * Validate a marketplace listing with comprehensive diagnostics
   */
  validate(
    listing: MarketplaceListing,
    rules: ValidationRules
  ): ValidationReport {
    const issues: ValidationIssue[] = [];
    const fieldsCaptured: string[] = [];
    const fieldsRequested = [...rules.required, ...rules.recommended];

    // Check required fields
    for (const field of rules.required) {
      if (this.hasValue(listing, field)) {
        fieldsCaptured.push(field);
      } else {
        issues.push({
          severity: 'error',
          field,
          code: 'MISSING_REQUIRED_FIELD',
          message: `Required field '${field}' is missing or empty`,
          expected: 'non-empty value',
          actual: this.getValue(listing, field),
          suggestion: `Check extraction selectors for ${field}`,
        });
      }
    }

    // Check recommended fields
    for (const field of rules.recommended) {
      if (this.hasValue(listing, field)) {
        fieldsCaptured.push(field);
      } else {
        issues.push({
          severity: 'warning',
          field,
          code: 'MISSING_RECOMMENDED_FIELD',
          message: `Recommended field '${field}' is missing`,
          expected: 'non-empty value',
          actual: this.getValue(listing, field),
          suggestion: `Consider adding selectors for ${field} to improve data quality`,
        });
      }
    }

    // Check optional fields for info
    for (const field of rules.optional) {
      if (this.hasValue(listing, field)) {
        fieldsCaptured.push(field);
      }
    }

    // Run custom field validators
    if (rules.fieldValidators) {
      for (const [field, validator] of Object.entries(rules.fieldValidators)) {
        const value = this.getValue(listing, field);
        const issue = validator(value);
        if (issue) {
          issues.push(issue);
        }
      }
    }

    // Validate data types and formats
    this.validateDataTypes(listing, issues);

    // Check confidence score
    if (listing.confidence < rules.minConfidence) {
      issues.push({
        severity: 'error',
        field: 'confidence',
        code: 'LOW_CONFIDENCE',
        message: `Confidence score ${listing.confidence.toFixed(2)} below minimum ${rules.minConfidence}`,
        expected: `>= ${rules.minConfidence}`,
        actual: listing.confidence,
        suggestion: 'Review extraction quality and add more robust selectors',
      });
    }

    // Calculate capture rate
    const captureRate = fieldsRequested.length > 0
      ? fieldsCaptured.length / fieldsRequested.length
      : 1.0;

    // Determine overall validity
    const hasErrors = issues.some(i => i.severity === 'error');
    const valid = !hasErrors && captureRate >= 0.7;

    // Adjust confidence based on issues
    let adjustedConfidence = listing.confidence;
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    adjustedConfidence -= errorCount * 0.15;
    adjustedConfidence -= warningCount * 0.05;
    adjustedConfidence = Math.max(0, Math.min(1, adjustedConfidence));

    const report: ValidationReport = {
      valid,
      confidence: adjustedConfidence,
      issues,
      fieldsCaptured,
      fieldsRequested,
      captureRate,
      timestamp: new Date().toISOString(),
      validatorVersion: this.version,
    };

    // Log validation result
    if (!valid) {
      logger.warn('Validation failed', {
        marketplace: listing.marketplace,
        url: listing.url,
        issueCount: issues.length,
        captureRate,
        confidence: adjustedConfidence,
      });
    }

    return report;
  }

  /**
   * Check if listing has a non-empty value for field
   */
  private hasValue(listing: any, field: string): boolean {
    const value = this.getValue(listing, field);
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' && value.trim() === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }

  /**
   * Get field value from listing (supports nested paths)
   */
  private getValue(listing: any, field: string): any {
    const parts = field.split('.');
    let value = listing;
    for (const part of parts) {
      if (value === null || value === undefined) return null;
      value = value[part];
    }
    return value;
  }

  /**
   * Validate data types and formats
   */
  private validateDataTypes(listing: MarketplaceListing, issues: ValidationIssue[]): void {
    // Validate price
    if (listing.price) {
      if (typeof listing.price.amount !== 'number' || listing.price.amount < 0) {
        issues.push({
          severity: 'error',
          field: 'price.amount',
          code: 'INVALID_PRICE',
          message: 'Price amount must be a positive number',
          expected: 'positive number',
          actual: listing.price.amount,
        });
      }

      if (!listing.price.currency || listing.price.currency.length !== 3) {
        issues.push({
          severity: 'warning',
          field: 'price.currency',
          code: 'INVALID_CURRENCY',
          message: 'Currency should be a 3-letter ISO 4217 code',
          expected: '3-letter code (e.g., USD, GBP)',
          actual: listing.price.currency,
        });
      }
    }

    // Validate confidence
    if (listing.confidence < 0 || listing.confidence > 1) {
      issues.push({
        severity: 'error',
        field: 'confidence',
        code: 'INVALID_CONFIDENCE',
        message: 'Confidence must be between 0 and 1',
        expected: '0.0 - 1.0',
        actual: listing.confidence,
      });
    }

    // Validate URL
    if (listing.url) {
      try {
        new URL(listing.url);
      } catch {
        issues.push({
          severity: 'error',
          field: 'url',
          code: 'INVALID_URL',
          message: 'URL is not valid',
          actual: listing.url,
        });
      }
    }

    // Validate images
    if (listing.images && Array.isArray(listing.images)) {
      for (let i = 0; i < listing.images.length; i++) {
        try {
          new URL(listing.images[i]);
        } catch {
          issues.push({
            severity: 'warning',
            field: `images[${i}]`,
            code: 'INVALID_IMAGE_URL',
            message: `Image URL at index ${i} is not valid`,
            actual: listing.images[i],
          });
        }
      }
    }

    // Validate timestamps
    if (listing.extractedAt) {
      const timestamp = new Date(listing.extractedAt);
      if (isNaN(timestamp.getTime())) {
        issues.push({
          severity: 'error',
          field: 'extractedAt',
          code: 'INVALID_TIMESTAMP',
          message: 'extractedAt is not a valid ISO 8601 timestamp',
          actual: listing.extractedAt,
        });
      }
    }
  }
}

/**
 * Default validation rules by marketplace
 */
export const MARKETPLACE_VALIDATION_RULES: Record<MarketplaceType, ValidationRules> = {
  ebay: {
    required: ['id', 'title', 'url', 'marketplace'],
    recommended: ['price', 'condition', 'seller.name', 'itemNumber'],
    optional: ['soldDate', 'shippingCost', 'images'],
    minConfidence: 0.7,
    fieldValidators: {
      title: (value) => {
        if (value && value.toLowerCase() === 'unknown item') {
          return {
            severity: 'error',
            field: 'title',
            code: 'GENERIC_TITLE',
            message: 'Title is generic placeholder value',
            actual: value,
            suggestion: 'Check title extraction selectors',
          };
        }
        return null;
      },
    },
  },
  amazon: {
    required: ['id', 'title', 'url', 'marketplace', 'availability'],
    recommended: ['price', 'itemNumber', 'seller.name'],
    optional: ['condition', 'category', 'images'],
    minConfidence: 0.75,
    fieldValidators: {
      title: (value) => {
        if (value && value.toLowerCase().includes('unknown')) {
          return {
            severity: 'error',
            field: 'title',
            code: 'GENERIC_TITLE',
            message: 'Title contains generic placeholder',
            actual: value,
          };
        }
        return null;
      },
    },
  },
  walmart: {
    required: ['id', 'title', 'url', 'marketplace'],
    recommended: ['price', 'availability', 'itemNumber'],
    optional: ['condition', 'seller.name', 'images'],
    minConfidence: 0.7,
  },
  etsy: {
    required: ['id', 'title', 'url', 'marketplace'],
    recommended: ['price', 'seller.name'],
    optional: ['condition', 'images'],
    minConfidence: 0.7,
  },
  custom: {
    required: ['id', 'title', 'url', 'marketplace'],
    recommended: ['price'],
    optional: [],
    minConfidence: 0.6,
  },
};

/**
 * Global validator instance
 */
export const extractionValidator = new ExtractionValidator();
