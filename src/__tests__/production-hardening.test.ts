/**
 * Production Hardening Tests - OpenAI Standards
 *
 * Tests for validation, telemetry, error handling, and reliability.
 * Zero tolerance for silent failures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ExtractionValidator,
  MARKETPLACE_VALIDATION_RULES,
  type ValidationIssue,
} from '../services/extractors/extraction-validator';
import {
  ExtractionSession,
  TelemetryManager,
  telemetryManager,
} from '../services/extractors/extraction-telemetry';
import { MarketplaceDemoRunner } from '../services/extractors/demo-script';
import type { MarketplaceListing } from '../services/extractors/marketplace-adapter';

// ============================================================================
// Validation Tests
// ============================================================================

describe('ExtractionValidator - Production Standards', () => {
  const validator = new ExtractionValidator();

  it('should validate complete ebay listing', () => {
    const listing: MarketplaceListing = {
      id: '123456789',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123456789',
      title: 'Vintage Computer',
      price: { amount: 599.99, currency: 'USD' },
      condition: 'used_very_good',
      availability: 'sold',
      seller: { name: 'TestSeller' },
      images: [],
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.9,
      extractorVersion: '1.0.0',
    };

    const rules = MARKETPLACE_VALIDATION_RULES.ebay;
    const report = validator.validate(listing, rules);

    expect(report.valid).toBe(true);
    expect(report.confidence).toBeGreaterThanOrEqual(0.8);
    expect(report.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('should detect missing required fields', () => {
    const listing: any = {
      id: '123',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      // Missing title (required)
      confidence: 0.9,
      extractedAt: new Date().toISOString(),
      extractorVersion: '1.0.0',
    };

    const rules = MARKETPLACE_VALIDATION_RULES.ebay;
    const report = validator.validate(listing, rules);

    expect(report.valid).toBe(false);
    const titleError = report.issues.find(i => i.field === 'title');
    expect(titleError).toBeDefined();
    expect(titleError?.severity).toBe('error');
    expect(titleError?.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('should provide actionable error suggestions', () => {
    const listing: any = {
      id: '123',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      title: '',
      confidence: 0.5,
      extractedAt: new Date().toISOString(),
      extractorVersion: '1.0.0',
    };

    const rules = MARKETPLACE_VALIDATION_RULES.ebay;
    const report = validator.validate(listing, rules);

    const titleError = report.issues.find(i => i.field === 'title');
    expect(titleError?.suggestion).toBeDefined();
    expect(titleError?.suggestion).toContain('selector');
  });

  it('should calculate capture rate correctly', () => {
    const listing: MarketplaceListing = {
      id: '123',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      title: 'Test Product',
      price: { amount: 99.99, currency: 'USD' },
      availability: 'in_stock',
      seller: { name: 'Seller' },
      images: [],
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.8,
      extractorVersion: '1.0.0',
      // Missing: condition (recommended), soldDate, shippingCost (optional)
    };

    const rules = MARKETPLACE_VALIDATION_RULES.ebay;
    const report = validator.validate(listing, rules);

    // Required + recommended fields
    const expectedFields = [...rules.required, ...rules.recommended].length;
    expect(report.fieldsRequested).toHaveLength(expectedFields);
    expect(report.captureRate).toBeGreaterThan(0);
    expect(report.captureRate).toBeLessThanOrEqual(1);
  });

  it('should validate data types strictly', () => {
    const listing: any = {
      id: '123',
      marketplace: 'ebay',
      url: 'not-a-valid-url',
      title: 'Test',
      price: { amount: -10, currency: 'INVALID' }, // Invalid price and currency
      confidence: 1.5, // Invalid confidence (> 1.0)
      availability: 'in_stock',
      seller: { name: 'Seller' },
      images: ['not-a-url'],
      extractedAt: 'invalid-date',
      extractionMethod: 'test',
      extractorVersion: '1.0.0',
    };

    const rules = MARKETPLACE_VALIDATION_RULES.ebay;
    const report = validator.validate(listing, rules);

    const urlError = report.issues.find(i => i.field === 'url');
    const priceError = report.issues.find(i => i.field === 'price.amount');
    const confidenceError = report.issues.find(i => i.field === 'confidence');

    expect(urlError).toBeDefined();
    expect(priceError).toBeDefined();
    expect(confidenceError).toBeDefined();
  });

  it('should penalize confidence for validation issues', () => {
    const listing: MarketplaceListing = {
      id: '123',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      title: 'Test Product',
      availability: 'in_stock',
      seller: { name: 'Seller' },
      images: [],
      price: null, // Missing price (recommended)
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.9, // Will be penalized
      extractorVersion: '1.0.0',
    };

    const rules = MARKETPLACE_VALIDATION_RULES.ebay;
    const report = validator.validate(listing, rules);

    // Confidence should be reduced due to missing recommended fields
    expect(report.confidence).toBeLessThan(listing.confidence);
  });
});

// ============================================================================
// Telemetry Tests
// ============================================================================

describe('Telemetry System - Zero Silent Failures', () => {
  let testTelemetry: TelemetryManager;

  beforeEach(() => {
    testTelemetry = new TelemetryManager({
      persistEnabled: false, // Don't persist during tests
      maxBufferSize: 100,
    });
  });

  it('should track extraction lifecycle completely', () => {
    const session = new ExtractionSession('ebay', 'https://ebay.com/itm/123');

    expect(session.sessionId).toBeDefined();
    expect(session.marketplace).toBe('ebay');
    expect(session.url).toBe('https://ebay.com/itm/123');

    // Simulate selector usage
    session.recordSelector('h1.title', true);
    session.recordSelector('.price', false); // Failed
    session.recordSelector('.price-alt', true); // Fallback succeeded

    const summary = session.getSummary();
    expect(summary.sessionId).toBe(session.sessionId);
    expect(summary.eventCount).toBeGreaterThan(0);
  });

  it('should record all event types', () => {
    testTelemetry.recordEvent({
      eventId: 'test-1',
      eventType: 'extraction_started',
      timestamp: new Date().toISOString(),
      marketplace: 'ebay',
      url: 'https://test.com',
    });

    testTelemetry.recordEvent({
      eventId: 'test-2',
      eventType: 'rate_limit_hit',
      timestamp: new Date().toISOString(),
      marketplace: 'ebay',
      url: 'https://test.com',
    });

    const metrics = testTelemetry.getMetrics();
    expect(metrics.rateLimitHits).toBe(1);
  });

  it('should calculate metrics correctly', () => {
    // Simulate successful extraction
    testTelemetry.recordEvent({
      eventId: 'test-1',
      eventType: 'extraction_completed',
      timestamp: new Date().toISOString(),
      marketplace: 'ebay',
      url: 'https://test.com',
      success: true,
      duration: 1000,
      confidence: 0.9,
    });

    // Simulate failed extraction
    testTelemetry.recordEvent({
      eventId: 'test-2',
      eventType: 'extraction_failed',
      timestamp: new Date().toISOString(),
      marketplace: 'ebay',
      url: 'https://test2.com',
      success: false,
      duration: 500,
    });

    const metrics = testTelemetry.getMetrics();
    expect(metrics.totalExtractions).toBe(2);
    expect(metrics.successfulExtractions).toBe(1);
    expect(metrics.failedExtractions).toBe(1);
    expect(metrics.successRate).toBe(0.5);
    expect(metrics.avgDuration).toBe(750);
  });

  it('should provide health assessment', () => {
    // Simulate healthy system
    for (let i = 0; i < 10; i++) {
      testTelemetry.recordEvent({
        eventId: `test-${i}`,
        eventType: 'extraction_completed',
        timestamp: new Date().toISOString(),
        marketplace: 'ebay',
        url: `https://test${i}.com`,
        success: true,
        duration: 1000,
        confidence: 0.9,
      });
    }

    const health = testTelemetry.getHealthReport();
    expect(health.status).toBe('healthy');
    expect(health.metrics.successRate).toBe(1.0);
  });

  it('should detect degraded performance', () => {
    // Simulate degraded system (50% success rate)
    for (let i = 0; i < 10; i++) {
      testTelemetry.recordEvent({
        eventId: `test-${i}`,
        eventType: i % 2 === 0 ? 'extraction_completed' : 'extraction_failed',
        timestamp: new Date().toISOString(),
        marketplace: 'ebay',
        url: `https://test${i}.com`,
        success: i % 2 === 0,
        duration: 1000,
      });
    }

    const health = testTelemetry.getHealthReport();
    expect(health.status).not.toBe('healthy');
    expect(health.issues.length).toBeGreaterThan(0);
    expect(health.recommendations.length).toBeGreaterThan(0);
  });

  it('should query events by criteria', () => {
    testTelemetry.recordEvent({
      eventId: 'test-1',
      eventType: 'extraction_completed',
      timestamp: new Date().toISOString(),
      marketplace: 'ebay',
      url: 'https://test.com',
      success: true,
      confidence: 0.9,
    });

    testTelemetry.recordEvent({
      eventId: 'test-2',
      eventType: 'extraction_failed',
      timestamp: new Date().toISOString(),
      marketplace: 'amazon',
      url: 'https://test.com',
      success: false,
    });

    // Query only eBay events
    const ebayEvents = testTelemetry.queryEvents({ marketplace: 'ebay' });
    expect(ebayEvents).toHaveLength(1);
    expect(ebayEvents[0].marketplace).toBe('ebay');

    // Query only successful events
    const successEvents = testTelemetry.queryEvents({ success: true });
    expect(successEvents).toHaveLength(1);
    expect(successEvents[0].success).toBe(true);

    // Query by confidence
    const highConfEvents = testTelemetry.queryEvents({ minConfidence: 0.8 });
    expect(highConfEvents).toHaveLength(1);
  });
});

// ============================================================================
// Demo Script Tests
// ============================================================================

describe('Production Demo - Always Works', () => {
  it('should complete successfully with fixtures', async () => {
    const demo = new MarketplaceDemoRunner({
      useFixtures: true,
      marketplaces: ['ebay'],
      outputReport: false,
      exitOnError: true,
    });

    const result = await demo.run();

    expect(result.success).toBe(true);
    expect(result.extractionsAttempted).toBeGreaterThan(0);
    expect(result.extractionsSuccessful).toBe(result.extractionsAttempted);
    expect(result.extractionsFailed).toBe(0);
    expect(result.errors).toHaveLength(0);
  }, 30000); // 30 second timeout

  it('should provide comprehensive telemetry', async () => {
    const demo = new MarketplaceDemoRunner({
      useFixtures: true,
      marketplaces: ['ebay'],
      outputReport: false,
    });

    const result = await demo.run();

    expect(result.telemetryReport).toBeDefined();
    expect(result.telemetryReport.totalExtractions).toBeGreaterThan(0);
    expect(result.telemetryReport.successRate).toBeGreaterThan(0);
    expect(result.avgConfidence).toBeGreaterThan(0);
  }, 30000);
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling - No Silent Failures', () => {
  it('should catch and report all extraction errors', () => {
    const session = new ExtractionSession('ebay', 'https://test.com');

    const error = new Error('Selector not found');
    session.completeFailure(error, true);

    const summary = session.getSummary();
    expect(summary.success).toBe(false);

    // Check that error was logged to telemetry
    const recentEvents = telemetryManager.getRecentEvents(10);
    const failureEvent = recentEvents.find(e => e.eventType === 'extraction_failed');
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.error).toBeDefined();
    expect(failureEvent?.error?.message).toBe('Selector not found');
  });

  it('should distinguish recoverable vs non-recoverable errors', () => {
    const session = new ExtractionSession('ebay', 'https://test.com');

    const recoverableError = new Error('Rate limited');
    session.completeFailure(recoverableError, true);

    const events = telemetryManager.getRecentEvents(10);
    const event = events.find(e => e.eventType === 'extraction_failed');
    expect(event?.error?.recoverable).toBe(true);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Full System Integration - Production Ready', () => {
  it('should validate, track telemetry, and report health', () => {
    const validator = new ExtractionValidator();
    const session = new ExtractionSession('ebay', 'https://test.com');

    // Create listing
    const listing: MarketplaceListing = {
      id: '123',
      marketplace: 'ebay',
      url: 'https://ebay.com/itm/123',
      title: 'Test Product',
      price: { amount: 99.99, currency: 'USD' },
      availability: 'in_stock',
      seller: { name: 'Seller' },
      images: [],
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.85,
      extractorVersion: '1.0.0',
    };

    // Validate
    const rules = MARKETPLACE_VALIDATION_RULES.ebay;
    const validation = validator.validate(listing, rules);

    // Complete session
    session.completeSuccess(listing, validation);

    // Check telemetry
    const metrics = telemetryManager.getMetrics();
    expect(metrics.totalExtractions).toBeGreaterThan(0);

    // Check health
    const health = telemetryManager.getHealthReport();
    expect(health.metrics).toBeDefined();
  });
});
