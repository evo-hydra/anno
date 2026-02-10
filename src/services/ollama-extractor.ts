/**
 * Ollama LLM Content Extractor
 *
 * Uses local LLM (via Ollama) for intelligent content extraction.
 * Falls back to traditional methods if Ollama unavailable.
 *
 * @module ollama-extractor
 */

import { logger } from '../utils/logger';

interface OllamaRequest {
  model: string;
  prompt: string;
  stream: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
  };
}

interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

export interface ExtractionResult {
  title: string;
  content: string;
  summary: string;
  metadata: {
    method: 'ollama' | 'fallback';
    model?: string;
    durationMs?: number;
  };
}

export class OllamaExtractor {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeout: number;
  private isAvailable: boolean | null = null;

  constructor(
    baseUrl = 'http://localhost:11434',
    model = 'llama3.2:3b-instruct-q8_0',
    timeout = 30000
  ) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.timeout = timeout;
  }

  /**
   * Check if Ollama is available
   */
  async checkAvailability(): Promise<boolean> {
    // Check environment flag first
    if (process.env.OLLAMA_ENABLED === 'false') {
      this.isAvailable = false;
      return false;
    }

    if (this.isAvailable !== null) {
      return this.isAvailable;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        const data = await response.json();
        const hasModel = data.models?.some((m: { name: string }) =>
          m.name.includes(this.model.split(':')[0])
        );

        this.isAvailable = hasModel;
        logger.info('Ollama availability check', { available: hasModel, model: this.model });
        return hasModel;
      }

      this.isAvailable = false;
      return false;
    } catch (error) {
      logger.warn('Ollama not available', {
        error: error instanceof Error ? error.message : 'unknown'
      });
      this.isAvailable = false;
      return false;
    }
  }

  /**
   * Extract content using Ollama
   */
  async extract(html: string, url: string): Promise<ExtractionResult | null> {
    const available = await this.checkAvailability();
    if (!available) {
      logger.debug('Ollama unavailable, skipping AI extraction');
      return null;
    }

    const startTime = Date.now();

    // Truncate HTML to avoid token limits (keep first 8000 chars)
    const truncatedHtml = html.length > 8000 ? html.slice(0, 8000) + '...' : html;

    const prompt = `Extract the main content from this webpage.

URL: ${url}

HTML:
${truncatedHtml}

Extract and return ONLY:
1. Title: The main title/headline
2. Content: The main article/page content (cleaned, no ads/navigation)
3. Summary: A 2-3 sentence summary

Format your response EXACTLY as:
TITLE: [title here]
CONTENT: [main content here]
SUMMARY: [summary here]`;

    try {
      const request: OllamaRequest = {
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3, // Lower = more focused
          top_p: 0.9,
          top_k: 40
        }
      };

      logger.debug('Ollama extraction request', { model: this.model, htmlLength: html.length });

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeout)
      });

      if (!response.ok) {
        logger.error('Ollama request failed', { status: response.status });
        return null;
      }

      const data: OllamaResponse = await response.json();
      const durationMs = Date.now() - startTime;

      logger.info('Ollama extraction complete', {
        model: data.model,
        durationMs,
        responseLengthChars: data.response.length
      });

      // Parse response
      const parsed = this.parseResponse(data.response);

      return {
        ...parsed,
        metadata: {
          method: 'ollama',
          model: data.model,
          durationMs
        }
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error('Ollama extraction error', {
        error: error instanceof Error ? error.message : 'unknown',
        durationMs
      });
      return null;
    }
  }

  /**
   * Parse LLM response into structured format
   */
  private parseResponse(response: string): Omit<ExtractionResult, 'metadata'> {
    const titleMatch = response.match(/TITLE:\s*(.+?)(?:\n|CONTENT:|$)/s);
    const contentMatch = response.match(/CONTENT:\s*(.+?)(?:\n|SUMMARY:|$)/s);
    const summaryMatch = response.match(/SUMMARY:\s*(.+?)$/s);

    return {
      title: titleMatch?.[1]?.trim() || 'Untitled',
      content: contentMatch?.[1]?.trim() || response.trim(),
      summary: summaryMatch?.[1]?.trim() || ''
    };
  }

  /**
   * Reset availability cache
   */
  resetAvailability(): void {
    this.isAvailable = null;
  }
}

// Global singleton
export const ollamaExtractor = new OllamaExtractor();
