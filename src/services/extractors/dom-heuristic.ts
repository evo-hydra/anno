/**
 * DOM Heuristic Content Extractor
 *
 * Fallback extractor using content density analysis.
 * Always succeeds, even if quality is lower than Readability/Ollama.
 *
 * @module extractors/dom-heuristic
 */

import { JSDOM } from 'jsdom';
import { logger } from '../../utils/logger';

interface ScoredElement {
  element: Element;
  score: number;
  textLength: number;
  selector: string;
}

export interface DOMExtractionResult {
  title: string;
  content: string;
  paragraphs: Array<{
    text: string;
    selector: string;
  }>;
  confidence: number;
  method: 'dom-heuristic';
}

export class DOMHeuristicExtractor {
  private readonly minTextLength = 20;
  private readonly minParagraphCount = 3;

  /**
   * Extract content using DOM structure heuristics
   */
  extract(html: string, url: string): DOMExtractionResult {
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // Extract title
    const title = this.extractTitle(document, url);

    // Score all content elements
    const scoredElements = this.scoreElements(document);

    // Filter low-scoring elements
    const goodElements = scoredElements.filter((e) => e.score > 0);

    // Sort by score (highest first)
    goodElements.sort((a, b) => b.score - a.score);

    // Extract paragraphs from top-scoring elements
    const paragraphs = this.extractParagraphs(goodElements);

    // Calculate confidence based on extraction quality
    const confidence = this.calculateConfidence(paragraphs, scoredElements.length);

    // Combine content
    const content = paragraphs.map((p) => p.text).join('\n\n');

    logger.debug('DOM heuristic extraction complete', {
      url,
      paragraphCount: paragraphs.length,
      contentLength: content.length,
      confidence
    });

    return {
      title,
      content,
      paragraphs,
      confidence,
      method: 'dom-heuristic'
    };
  }

  /**
   * Extract title from document
   */
  private extractTitle(document: Document, url: string): string {
    // Try in order: h1, title tag, og:title, URL
    const h1 = document.querySelector('h1');
    if (h1?.textContent?.trim()) {
      return h1.textContent.trim();
    }

    const titleTag = document.querySelector('title');
    if (titleTag?.textContent?.trim()) {
      return titleTag.textContent.trim();
    }

    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle?.getAttribute('content')?.trim()) {
      return ogTitle.getAttribute('content')!.trim();
    }

    // Fall back to URL
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.pathname.split('/').filter(Boolean).pop() || 'Untitled';
    } catch {
      return 'Untitled';
    }
  }

  /**
   * Score elements based on content quality heuristics
   */
  private scoreElements(document: Document): ScoredElement[] {
    const scored: ScoredElement[] = [];

    // Target content-bearing elements
    const contentSelectors = ['article', 'main', '[role="main"]', '.content', '#content', 'section'];
    const containers = document.querySelectorAll(contentSelectors.join(','));

    // If no semantic containers, analyze all divs
    const elementsToScore =
      containers.length > 0
        ? Array.from(containers)
        : Array.from(document.querySelectorAll('div, article, section'));

    elementsToScore.forEach((element, index) => {
      const score = this.scoreElement(element as HTMLElement);
      const textLength = (element.textContent?.length || 0);
      const selector = this.generateSelector(element, index);

      scored.push({
        element,
        score,
        textLength,
        selector
      });
    });

    return scored;
  }

  /**
   * Score a single element based on content heuristics
   */
  private scoreElement(element: HTMLElement): number {
    let score = 0;

    // Text content length (capped at 5000 chars for scoring)
    const textLength = element.textContent?.length || 0;
    score += Math.min(textLength / 1000, 5);

    // Paragraph count
    const paragraphs = element.querySelectorAll('p');
    score += paragraphs.length * 2;

    // Link density (too many links = navigation/ads)
    const links = element.querySelectorAll('a');
    const linkTextLength = Array.from(links).reduce((sum, link) => sum + (link.textContent?.length || 0), 0);
    const linkDensity = textLength > 0 ? linkTextLength / textLength : 0;
    score -= linkDensity * 10; // Penalize high link density

    // Class/ID penalties for non-content
    const className = element.className || '';
    const id = element.id || '';
    const combined = (className + ' ' + id).toLowerCase();

    const badPatterns = ['nav', 'menu', 'sidebar', 'footer', 'header', 'ad', 'comment', 'social', 'share'];
    for (const pattern of badPatterns) {
      if (combined.includes(pattern)) {
        score -= 5;
      }
    }

    // Good patterns
    const goodPatterns = ['article', 'content', 'post', 'story', 'main'];
    for (const pattern of goodPatterns) {
      if (combined.includes(pattern)) {
        score += 3;
      }
    }

    return score;
  }

  /**
   * Generate CSS selector for element
   */
  private generateSelector(element: Element, index: number): string {
    if (element.id) {
      return `#${element.id}`;
    }

    const tagName = element.tagName.toLowerCase();
    const className = element.className ? `.${element.className.split(' ')[0]}` : '';

    return `${tagName}${className}:nth-of-type(${index + 1})`;
  }

  /**
   * Extract paragraphs from scored elements
   */
  private extractParagraphs(
    scoredElements: ScoredElement[]
  ): Array<{ text: string; selector: string }> {
    const paragraphs: Array<{ text: string; selector: string }> = [];

    // Take top-scoring elements (up to 70% of total score)
    const totalScore = scoredElements.reduce((sum, e) => sum + Math.max(0, e.score), 0);
    let cumulativeScore = 0;
    const scoreThreshold = totalScore * 0.7;

    for (const scored of scoredElements) {
      if (scored.score <= 0) continue;

      cumulativeScore += scored.score;

      // Extract p tags from this element
      const pTags = scored.element.querySelectorAll('p');
      pTags.forEach((p, idx) => {
        const text = p.textContent?.trim();
        if (text && text.length >= this.minTextLength) {
          paragraphs.push({
            text,
            selector: `${scored.selector} > p:nth-of-type(${idx + 1})`
          });
        }
      });

      // Stop when we've captured enough high-scoring content
      if (cumulativeScore >= scoreThreshold) {
        break;
      }
    }

    return paragraphs;
  }

  /**
   * Calculate confidence score
   */
  private calculateConfidence(
    paragraphs: Array<{ text: string; selector: string }>,
    totalElements: number
  ): number {
    let confidence = 0;

    // Base confidence from paragraph count
    if (paragraphs.length >= this.minParagraphCount) {
      confidence += 0.4;
    } else {
      confidence += (paragraphs.length / this.minParagraphCount) * 0.4;
    }

    // Content length
    const totalLength = paragraphs.reduce((sum, p) => sum + p.text.length, 0);
    if (totalLength > 1000) {
      confidence += 0.3;
    } else {
      confidence += (totalLength / 1000) * 0.3;
    }

    // Extraction efficiency (fewer elements analyzed = more targeted)
    const efficiency = Math.min(totalElements / 10, 1);
    confidence += (1 - efficiency) * 0.3;

    return Math.min(confidence, 1);
  }
}

// Global singleton
export const domHeuristicExtractor = new DOMHeuristicExtractor();
