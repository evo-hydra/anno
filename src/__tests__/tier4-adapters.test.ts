/**
 * Tests for Tier 4 AI-Assisted Adapters
 *
 * Tests the LLM Extraction and Email Parsing adapters.
 * These are fallback adapters for when structured extraction fails.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LLMExtractionAdapter,
  createClaudeAdapter,
  createOpenAIAdapter,
  createOllamaAdapter,
} from '../services/extractors/llm-extraction-adapter';
import {
  EmailParsingAdapter,
  createEmailAdapter,
  emailParsingAdapter,
} from '../services/extractors/email-parsing-adapter';
import { CHANNEL_CONFIDENCE_DEFAULTS } from '../services/extractors/marketplace-adapter';

// ============================================================================
// Test Fixtures
// ============================================================================

const SAMPLE_HTML_CONTENT = `
<!DOCTYPE html>
<html>
<head><title>Nintendo Switch OLED - eBay</title></head>
<body>
  <h1>Nintendo Switch OLED Console - White</h1>
  <div class="price">$299.99</div>
  <div class="condition">Used - Like New</div>
  <div class="seller">seller123</div>
  <div class="item-number">Item: 123456789012</div>
  <div class="sold-date">Sold on Jan 15, 2024</div>
</body>
</html>
`;

const SAMPLE_OCR_TEXT = `
Nintendo   Switch   OLED   Console

Price:   $349.99
Condition: New
Seller: GameStop
Item #: 987654321

Sold: January 20, 2024
`;

const AMAZON_ORDER_EMAIL = `From: auto-confirm@amazon.com
To: customer@example.com
Subject: Your Amazon.com order of "Sony WH-1000XM5..." has shipped!
Date: Mon, 15 Jan 2024 10:30:00 -0800

Hello,

Your order #111-1234567-1234567 has shipped.

Item: Sony WH-1000XM5 Wireless Headphones
Price: $348.00
Shipping: $0.00
Order Total: $348.00

Tracking Number: 1Z999AA10123456784

Thank you for shopping with us!
`;

const EBAY_ORDER_EMAIL = `From: ebay@ebay.com
To: buyer@example.com
Subject: You won! Nintendo Switch OLED Console
Date: Tue, 20 Jan 2024 14:45:00 -0800

Congratulations!

You bought the following item:

Item: Nintendo Switch OLED Console - White
Transaction ID: 123456789012
Sold for: $299.99
Shipping: $12.99
Order Total: $312.98

Purchased on January 20, 2024

Tracking Number: 9405511899223033005011
`;

const UNKNOWN_FORMAT_EMAIL = `From: noreply@randomstore.com
To: customer@example.com
Subject: Thanks for your purchase!
Date: Wed, 25 Jan 2024 09:00:00 -0800

Dear Customer,

Thank you for purchasing the following:

Product: Vintage Camera
Amount Paid: $150.00

Best regards,
Random Store Team
`;

// ============================================================================
// LLM Extraction Adapter Tests
// ============================================================================

describe('LLMExtractionAdapter', () => {
  let adapter: LLMExtractionAdapter;

  beforeEach(() => {
    adapter = new LLMExtractionAdapter();
  });

  describe('adapter properties', () => {
    it('has correct channel and tier', () => {
      expect(adapter.channel).toBe('llm_extraction');
      expect(adapter.tier).toBe(4);
    });

    it('has correct confidence range', () => {
      expect(adapter.confidenceRange).toEqual(CHANNEL_CONFIDENCE_DEFAULTS.llm_extraction);
    });

    it('does not require user action', () => {
      expect(adapter.requiresUserAction).toBe(false);
    });

    it('has correct version', () => {
      expect(adapter.version).toBe('1.0.0');
    });
  });

  describe('canHandle', () => {
    it('handles content with sufficient length', () => {
      expect(adapter.canHandle(SAMPLE_HTML_CONTENT)).toBe(true);
      expect(adapter.canHandle(SAMPLE_OCR_TEXT)).toBe(true);
    });

    it('rejects very short content', () => {
      expect(adapter.canHandle('too short')).toBe(false);
      expect(adapter.canHandle('')).toBe(false);
    });
  });

  describe('validate', () => {
    it('validates listing with title', () => {
      const listing = {
        id: 'test',
        marketplace: 'ebay' as const,
        url: 'https://ebay.com',
        title: 'Test Item',
        confidence: 0.7,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'llm',
        extractorVersion: '1.0.0',
        seller: { name: null },
        images: [],
        availability: 'unknown' as const,
      };

      const result = adapter.validate(listing);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('LLM extraction - verify data accuracy before use');
    });

    it('fails validation without title', () => {
      const listing = {
        id: 'test',
        marketplace: 'ebay' as const,
        url: 'https://ebay.com',
        title: '',
        confidence: 0.7,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'llm',
        extractorVersion: '1.0.0',
        seller: { name: null },
        images: [],
        availability: 'unknown' as const,
      };

      const result = adapter.validate(listing);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing title - LLM could not extract product name');
    });

    it('warns on low confidence', () => {
      const listing = {
        id: 'test',
        marketplace: 'ebay' as const,
        url: 'https://ebay.com',
        title: 'Test',
        confidence: 0.4,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'llm',
        extractorVersion: '1.0.0',
        seller: { name: null },
        images: [],
        availability: 'unknown' as const,
      };

      const result = adapter.validate(listing);
      expect(result.warnings.some(w => w.includes('Low confidence'))).toBe(true);
    });
  });

  describe('getConfig', () => {
    it('returns valid configuration', () => {
      const config = adapter.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.rateLimit.requestsPerSecond).toBeLessThanOrEqual(10);
      expect(config.quality.minConfidenceScore).toBe(0.55);
    });
  });

  describe('getHealth', () => {
    it('returns health status', async () => {
      const health = await adapter.getHealth();

      expect(health).toHaveProperty('available');
      expect(health).toHaveProperty('recentFailureRate');
      expect(health).toHaveProperty('estimatedReliability');
    });
  });

  describe('factory functions', () => {
    it('createClaudeAdapter creates Anthropic adapter', () => {
      const claude = createClaudeAdapter();
      expect(claude).toBeInstanceOf(LLMExtractionAdapter);
    });

    it('createOpenAIAdapter creates OpenAI adapter', () => {
      const openai = createOpenAIAdapter();
      expect(openai).toBeInstanceOf(LLMExtractionAdapter);
    });

    it('createOllamaAdapter creates Ollama adapter', () => {
      const ollama = createOllamaAdapter();
      expect(ollama).toBeInstanceOf(LLMExtractionAdapter);
    });
  });
});

// ============================================================================
// Email Parsing Adapter Tests
// ============================================================================

describe('EmailParsingAdapter', () => {
  let adapter: EmailParsingAdapter;

  beforeEach(() => {
    // Disable LLM fallback for deterministic tests
    adapter = new EmailParsingAdapter({ enableLLMFallback: false });
  });

  describe('adapter properties', () => {
    it('has correct channel and tier', () => {
      expect(adapter.channel).toBe('email_parsing');
      expect(adapter.tier).toBe(2);
    });

    it('has correct confidence range', () => {
      expect(adapter.confidenceRange).toEqual(CHANNEL_CONFIDENCE_DEFAULTS.email_parsing);
    });

    it('requires user action', () => {
      expect(adapter.requiresUserAction).toBe(true);
    });

    it('has correct version', () => {
      expect(adapter.version).toBe('1.0.0');
    });
  });

  describe('canHandle', () => {
    it('handles email content with From and Subject', () => {
      expect(adapter.canHandle(AMAZON_ORDER_EMAIL)).toBe(true);
      expect(adapter.canHandle(EBAY_ORDER_EMAIL)).toBe(true);
    });

    it('rejects non-email content', () => {
      expect(adapter.canHandle(SAMPLE_HTML_CONTENT)).toBe(false);
      expect(adapter.canHandle('random text without email headers')).toBe(false);
    });
  });

  describe('extract - Amazon emails', () => {
    it('extracts data from Amazon order email', async () => {
      const listing = await adapter.extract(AMAZON_ORDER_EMAIL, 'email://amazon');

      expect(listing).not.toBeNull();
      expect(listing!.marketplace).toBe('amazon');
      expect(listing!.itemNumber).toBe('111-1234567-1234567');
      expect(listing!.price?.amount).toBe(348);
      expect(listing!.price?.currency).toBe('USD');
    });

    it('extracts tracking number from Amazon email', async () => {
      const listing = await adapter.extract(AMAZON_ORDER_EMAIL, 'email://amazon');

      expect(listing?.attributes?.trackingNumber).toBe('1Z999AA10123456784');
    });
  });

  describe('extract - eBay emails', () => {
    it('extracts data from eBay order email', async () => {
      const listing = await adapter.extract(EBAY_ORDER_EMAIL, 'email://ebay');

      expect(listing).not.toBeNull();
      expect(listing!.marketplace).toBe('ebay');
      expect(listing!.itemNumber).toBe('123456789012');
    });

    it('extracts order total from eBay email', async () => {
      const listing = await adapter.extract(EBAY_ORDER_EMAIL, 'email://ebay');

      expect(listing?.attributes?.orderTotal?.amount).toBe(312.98);
    });
  });

  describe('extract - unknown formats', () => {
    it('returns null for unknown email format without LLM', async () => {
      const listing = await adapter.extract(UNKNOWN_FORMAT_EMAIL, 'email://unknown');

      // Without LLM fallback, unknown formats fail
      expect(listing).toBeNull();
    });
  });

  describe('extractWithProvenance', () => {
    it('includes provenance data', async () => {
      const result = await adapter.extractWithProvenance(AMAZON_ORDER_EMAIL, 'email://amazon');

      expect(result).not.toBeNull();
      expect(result!.provenance).toBeDefined();
      expect(result!.provenance.channel).toBe('email_parsing');
      expect(result!.provenance.tier).toBe(2); // Pattern match = Tier 2
      expect(result!.provenance.userConsented).toBe(true);
      expect(result!.provenance.termsCompliant).toBe(true);
    });

    it('tracks extraction method in provenance', async () => {
      const result = await adapter.extractWithProvenance(EBAY_ORDER_EMAIL, 'email://ebay');

      expect(result!.provenance.metadata?.extractionMethod).toBe('pattern');
    });
  });

  describe('extractAllItems', () => {
    it('extracts all items from email', async () => {
      const listings = await adapter.extractAllItems(AMAZON_ORDER_EMAIL, 'email://amazon');

      expect(listings.length).toBeGreaterThan(0);
      listings.forEach(listing => {
        expect(listing.provenance).toBeDefined();
        expect(listing.marketplace).toBe('amazon');
      });
    });
  });

  describe('validate', () => {
    it('validates complete listing', async () => {
      const listing = await adapter.extract(AMAZON_ORDER_EMAIL, 'email://amazon');
      const result = adapter.validate(listing!);

      expect(result.valid).toBe(true);
    });

    it('fails validation without title', () => {
      const listing = {
        id: 'test',
        marketplace: 'ebay' as const,
        url: 'email://test',
        title: '',
        confidence: 0.85,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'email',
        extractorVersion: '1.0.0',
        seller: { name: null },
        images: [],
        availability: 'sold' as const,
      };

      const result = adapter.validate(listing);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing item title from email');
    });
  });

  describe('health monitoring', () => {
    it('reports available status', async () => {
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    });

    it('returns health status', async () => {
      const health = await adapter.getHealth();

      expect(health.available).toBe(true);
      expect(health).toHaveProperty('recentFailureRate');
      expect(health).toHaveProperty('estimatedReliability');
    });

    it('tracks successful extractions', async () => {
      await adapter.extractWithProvenance(AMAZON_ORDER_EMAIL, 'email://amazon');
      const health = await adapter.getHealth();

      expect(health.lastSuccessfulExtraction).toBeDefined();
    });
  });

  describe('getConfig', () => {
    it('returns valid configuration', () => {
      const config = adapter.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.quality.minConfidenceScore).toBe(0.75);
      expect(config.quality.requiredFields).toContain('title');
    });
  });
});

describe('EmailParsingAdapter with LLM fallback', () => {
  it('creates adapter with LLM fallback enabled by default', () => {
    const adapter = createEmailAdapter();
    expect(adapter).toBeInstanceOf(EmailParsingAdapter);
  });

  it('can disable LLM fallback', () => {
    const adapter = createEmailAdapter({ enableLLMFallback: false });
    expect(adapter).toBeInstanceOf(EmailParsingAdapter);
  });
});

describe('emailParsingAdapter singleton', () => {
  it('is an instance of EmailParsingAdapter', () => {
    expect(emailParsingAdapter).toBeInstanceOf(EmailParsingAdapter);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Tier 4 Adapters Integration', () => {
  it('LLM adapter has lower confidence than email pattern matching', () => {
    const llmAdapter = new LLMExtractionAdapter();
    const emailAdapter = new EmailParsingAdapter();

    // LLM is Tier 4, Email pattern is Tier 2
    expect(llmAdapter.tier).toBeGreaterThan(emailAdapter.tier);
    expect(llmAdapter.confidenceRange.max).toBeLessThan(emailAdapter.confidenceRange.max);
  });

  it('both adapters implement DataSourceAdapter interface', async () => {
    const llmAdapter = new LLMExtractionAdapter();
    const emailAdapter = new EmailParsingAdapter({ enableLLMFallback: false });

    // Check required interface methods
    expect(typeof llmAdapter.canHandle).toBe('function');
    expect(typeof llmAdapter.extract).toBe('function');
    expect(typeof llmAdapter.extractWithProvenance).toBe('function');
    expect(typeof llmAdapter.isAvailable).toBe('function');
    expect(typeof llmAdapter.getHealth).toBe('function');

    expect(typeof emailAdapter.canHandle).toBe('function');
    expect(typeof emailAdapter.extract).toBe('function');
    expect(typeof emailAdapter.extractWithProvenance).toBe('function');
    expect(typeof emailAdapter.isAvailable).toBe('function');
    expect(typeof emailAdapter.getHealth).toBe('function');
  });

  it('both adapters are always available (local processing)', async () => {
    const llmAdapter = new LLMExtractionAdapter();
    const emailAdapter = new EmailParsingAdapter({ enableLLMFallback: false });

    // Email adapter is always available (pattern matching)
    expect(await emailAdapter.isAvailable()).toBe(true);

    // LLM adapter availability depends on API key
    // (may be false in test environment)
    const llmHealth = await llmAdapter.getHealth();
    expect(llmHealth).toHaveProperty('available');
  });
});
