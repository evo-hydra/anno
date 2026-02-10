import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { createHash } from 'crypto';
import { ollamaExtractor } from './ollama-extractor';
import { domHeuristicExtractor } from './extractors/dom-heuristic';
import { ebayAdapter, type EbaySoldListing } from './extractors/ebay-adapter';
import { ebaySearchAdapter, type EbaySoldSearchExtraction } from './extractors/ebay-search-adapter';
import { extractionEnsemble, type ExtractionCandidate, type ExtractionScore } from '../core/extraction-ensemble';
import { trafilaturaExtract } from './extractors/trafilatura';
import { confidenceScorer, type ConfidenceBreakdown } from '../core/confidence-scorer';
import { logger } from '../utils/logger';
import { policyEngine, type PolicyApplicationResult } from './policy-engine';

export interface SourceSpan {
  url: string;
  timestamp: number;
  contentHash: string; // SHA-256 of raw HTML
  byteStart: number;
  byteEnd: number;
  selector?: string; // CSS selector path
}

export interface DistilledNode {
  id: string;
  order: number;
  type: 'paragraph' | 'heading';
  text: string;
  sourceSpans?: SourceSpan[];
}

export interface DistillationResult {
  title: string;
  byline: string | null;
  excerpt: string | null;
  lang: string | null;
  siteName: string | null;
  contentText: string;
  contentLength: number;
  contentHash?: string; // SHA-256 of original HTML
  nodes: DistilledNode[];
  fallbackUsed: boolean;
  extractionMethod?:
    | 'ollama'
    | 'readability'
    | 'dom-heuristic'
    | 'trafilatura'
    | 'ebay-adapter'
    | 'ebay-search-adapter'
    | 'fallback';
  extractionConfidence?: number;
  ollamaMetadata?: {
    model: string;
    durationMs: number;
  };
  ebayData?: EbaySoldListing;
  ebaySearchData?: EbaySoldSearchExtraction;
  ensembleScore?: ExtractionScore;
  ensembleExplanation?: string;
  confidenceBreakdown?: ConfidenceBreakdown;
  policyMetadata?: {
    policyApplied: string;
    rulesMatched: number;
    fieldsValidated: boolean;
  };
}

const toParagraphNodes = (document: Document): DistilledNode[] => {
  const nodes: DistilledNode[] = [];
  const paragraphElements = document.querySelectorAll<HTMLParagraphElement>('p');

  paragraphElements.forEach((element, index) => {
    const text = element.textContent?.trim();
    if (!text) {
      return;
    }

    nodes.push({
      id: `fallback-paragraph-${index}`,
      order: index,
      type: 'paragraph',
      text
    });
  });

  return nodes;
};

const createFallback = (html: string, baseUrl: string): DistillationResult => {
  const dom = new JSDOM(html, { url: baseUrl });
  const fallbackNodes = toParagraphNodes(dom.window.document);
  const textContent = fallbackNodes.map((node) => node.text).join('\n\n');

  return {
    title: dom.window.document.title ?? baseUrl,
    byline: null,
    excerpt: textContent ? textContent.slice(0, 280) : null,
    lang: dom.window.document.documentElement.getAttribute('lang'),
    siteName: null,
    contentText: textContent,
    contentLength: textContent.length,
    nodes: fallbackNodes,
    fallbackUsed: true,
    extractionMethod: 'fallback',
    extractionConfidence: 0.2
  };
};

const createNodesFromFragment = (fragmentHtml: string): DistilledNode[] => {
  const nodes: DistilledNode[] = [];
  const fragment = JSDOM.fragment(fragmentHtml);
  const blockSelectors = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const elements = fragment.querySelectorAll<HTMLElement>(blockSelectors.join(','));

  const serializeWithLinks = (el: HTMLElement): string => {
    // Preserve anchor text with URL for better recall
    const walker = el.ownerDocument?.createTreeWalker(el, 4 /* SHOW_TEXT */) as any;
    // Fallback simple approach: replace <a> with "text (link: URL)"
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('a[href]')?.forEach((a) => {
      const href = a.getAttribute('href');
      const label = (a.textContent || '').trim();
      a.replaceWith(`${label}${href ? ` (link: ${href})` : ''}`);
    });
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  };

  elements.forEach((element, index) => {
    const text = serializeWithLinks(element);
    if (!text) {
      return;
    }

    const tagName = element.tagName.toLowerCase();

    nodes.push({
      id: `node-${index}`,
      order: index,
      type: tagName.startsWith('h') ? 'heading' : 'paragraph',
      text
    });
  });

  return nodes;
};

/**
 * Compute SHA-256 hash of content for provenance tracking
 */
const computeContentHash = (content: string): string => {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
};

/**
 * Create source span for a text fragment
 */
const createSourceSpan = (
  url: string,
  originalHtml: string,
  text: string,
  contentHash: string
): SourceSpan => {
  const byteStart = originalHtml.indexOf(text);
  const byteEnd = byteStart >= 0 ? byteStart + text.length : -1;

  return {
    url,
    timestamp: Date.now(),
    contentHash,
    byteStart: Math.max(0, byteStart),
    byteEnd: Math.max(0, byteEnd)
  };
};

export const distillContent = async (html: string, baseUrl: string, policyHint?: string): Promise<DistillationResult> => {
  // Compute content hash for provenance
  const contentHash = computeContentHash(html);
  const timestamp = Date.now();

  // Initialize policy engine if not already done
  await policyEngine.init();

  // Apply policy transformations (pre-processing)
  let processedHtml = html;
  let policyResult: PolicyApplicationResult | null = null;

  try {
    policyResult = policyEngine.applyPolicy(html, baseUrl, policyHint);
    processedHtml = policyResult.transformedHtml;
    logger.info('Policy applied to content', {
      url: baseUrl,
      policy: policyResult.policyApplied,
      rulesMatched: policyResult.rulesMatched
    });
  } catch (error) {
    logger.warn('Policy application failed, using unprocessed HTML', {
      url: baseUrl,
      error: error instanceof Error ? error.message : 'unknown'
    });
  }

  // Check if this is an eBay sold search page
  if (ebaySearchAdapter.isSoldSearch(baseUrl)) {
    logger.info('eBay sold search detected, using search adapter', { url: baseUrl });

    const extraction = ebaySearchAdapter.extractLegacy(processedHtml, baseUrl);

    if (extraction.extractedCount > 0) {
      const lines: string[] = [];

      const formatCurrency = (amount: number, currency: string): string => {
        switch (currency) {
          case 'GBP':
            return `£${amount.toFixed(2)}`;
          case 'EUR':
            return `€${amount.toFixed(2)}`;
          default:
            return `$${amount.toFixed(2)}`;
        }
      };

      extraction.items.forEach((item, index) => {
        lines.push(`Title: ${item.title}`);
        lines.push(`Price: ${formatCurrency(item.price ?? 0, item.currency)}`);
        if (item.soldDate) {
          lines.push(`Sold Date: ${item.soldDate}`);
        }
        if (item.condition) {
          lines.push(`Condition: ${item.condition}`);
        }
        if (item.shippingText) {
          lines.push(`Shipping: ${item.shippingText}`);
        } else if (item.shippingCost !== null) {
          const shippingLabel =
            item.shippingCost === 0
              ? 'Free shipping'
              : `Shipping Cost: ${formatCurrency(item.shippingCost, item.currency)}`;
          lines.push(`Shipping: ${shippingLabel}`);
        }
        if (item.url) {
          lines.push(`Listing URL: ${item.url}`);
        }

        if (index < extraction.items.length - 1) {
          lines.push('---');
        }
      });

      const contentText = lines.join('\n');

      const nodes: DistilledNode[] = lines.map((text, index) => ({
        id: `ebay-search-${index}`,
        order: index,
        type: text.startsWith('Title:') ? 'heading' : 'paragraph',
        text
      }));

      return {
        title: `eBay Sold Listings (${extraction.extractedCount} items)`,
        byline: null,
        excerpt: lines.slice(0, 3).join(' | '),
        lang: null,
        siteName: 'eBay',
        contentText,
        contentLength: contentText.length,
        contentHash,
        nodes,
        fallbackUsed: false,
        extractionMethod: 'ebay-search-adapter',
        extractionConfidence: extraction.confidence,
        ebaySearchData: extraction,
        policyMetadata: policyResult
          ? {
              policyApplied: policyResult.policyApplied,
              rulesMatched: policyResult.rulesMatched,
              fieldsValidated: policyResult.fieldsValidated
            }
          : undefined
      };
    }

    logger.warn('eBay search adapter found zero extractable items, falling back to generic extraction', {
      url: baseUrl,
      detectedCount: extraction.detectedCount
    });
  }

  // Check if this is an eBay listing - use specialized adapter
  if (ebayAdapter.isEbayListing(baseUrl)) {
    logger.info('eBay listing detected, using eBay adapter', { url: baseUrl });

    // Use legacy extraction method for backward compatibility
    const ebayData = ebayAdapter.extractLegacy(html, baseUrl);

    // Convert eBay data to DistillationResult format
    const contentLines = [
      `Title: ${ebayData.title}`,
      ebayData.soldPrice !== null ? `Sold Price: ${ebayData.currency} ${ebayData.soldPrice.toFixed(2)}` : 'Sold Price: Not found',
      ebayData.soldDate ? `Sold Date: ${ebayData.soldDate}` : 'Sold Date: Not found',
      ebayData.condition ? `Condition: ${ebayData.condition}` : 'Condition: Not found',
      ebayData.itemNumber ? `Item Number: ${ebayData.itemNumber}` : 'Item Number: Not found',
      ebayData.shippingCost !== null ? `Shipping: ${ebayData.currency} ${ebayData.shippingCost.toFixed(2)}` : 'Shipping: Not found',
      ebayData.seller.name ? `Seller: ${ebayData.seller.name}` : 'Seller: Not found',
      ebayData.seller.rating !== null ? `Seller Rating: ${ebayData.seller.rating}%` : ''
    ].filter(line => line.length > 0);

    const contentText = contentLines.join('\n');

    const nodes: DistilledNode[] = contentLines.map((line, index) => ({
      id: `ebay-field-${index}`,
      order: index,
      type: 'paragraph' as const,
      text: line,
      sourceSpans: [createSourceSpan(baseUrl, html, line, contentHash)]
    }));

    return {
      title: ebayData.title,
      byline: ebayData.seller.name,
      excerpt: contentLines.slice(0, 3).join(' | '),
      lang: null,
      siteName: 'eBay',
      contentText,
      contentLength: contentText.length,
      contentHash,
      nodes,
      fallbackUsed: false,
      extractionMethod: 'ebay-adapter',
      extractionConfidence: ebayData.confidence,
      ebayData,
      policyMetadata: policyResult
        ? {
            policyApplied: policyResult.policyApplied,
            rulesMatched: policyResult.rulesMatched,
            fieldsValidated: policyResult.fieldsValidated
          }
        : undefined
    };
  }

  // Collect extraction candidates (using policy-processed HTML)
  const candidates: ExtractionCandidate[] = [];

  // Try Ollama (AI-powered extraction)
  try {
    const ollamaResult = await ollamaExtractor.extract(processedHtml, baseUrl);
    if (ollamaResult) {
      const paragraphCount = ollamaResult.content.split('\n\n').filter(p => p.trim().length > 0).length;
      candidates.push({
        method: 'ollama',
        title: ollamaResult.title,
        content: ollamaResult.content,
        paragraphCount,
        confidence: 0.8, // Ollama is generally good
        metadata: {
          author: null,
          publishDate: null,
          excerpt: ollamaResult.summary || null
        }
      });
    }
  } catch (error) {
    logger.warn('Ollama extraction failed', {
      error: error instanceof Error ? error.message : 'unknown'
    });
  }

  // Try Readability (using policy-processed HTML)
  const dom = new JSDOM(processedHtml, { url: baseUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article) {
    const nodes = createNodesFromFragment(article.content);
    if (nodes.length > 0) {
      const textContent = article.textContent?.trim() ?? '';
      candidates.push({
        method: 'readability',
        title: article.title?.trim() ?? dom.window.document.title ?? baseUrl,
        content: textContent,
        paragraphCount: nodes.length,
        confidence: 0.9, // Readability is very reliable
        metadata: {
          author: article.byline ?? null,
          publishDate: null,
          excerpt: article.excerpt ?? null
        }
      });
    }
  }

  // Always try DOM heuristic as final option (using policy-processed HTML)
  const domResult = domHeuristicExtractor.extract(processedHtml, baseUrl);
  if (domResult.paragraphs.length > 0) {
    candidates.push({
      method: 'dom-heuristic',
      title: domResult.title,
      content: domResult.content,
      paragraphCount: domResult.paragraphs.length,
      confidence: domResult.confidence,
      metadata: {
        author: null,
        publishDate: null,
        excerpt: domResult.content.substring(0, 280)
      }
    });
  }

  // Try Trafilatura (Python) as an additional candidate
  try {
    const traf = await trafilaturaExtract(processedHtml, baseUrl);
    if (traf && traf.content && traf.content.trim().length > 0) {
      const paragraphCount = traf.content.split('\n\n').filter(p => p.trim().length > 0).length;
      candidates.push({
        method: 'trafilatura' as any,
        title: traf.title,
        content: traf.content,
        paragraphCount,
        confidence: 0.85,
        metadata: {
          author: traf.author ?? null,
          publishDate: traf.publishDate ?? null,
          excerpt: traf.content.substring(0, 280)
        }
      });
    }
  } catch (error) {
    logger.warn('Trafilatura extraction failed', { error: error instanceof Error ? error.message : 'unknown' });
  }

  // If no candidates, use fallback
  if (candidates.length === 0) {
    logger.warn('No extraction candidates available, using fallback DOM distillation', {
      url: baseUrl
    });
    return createFallback(html, baseUrl);
  }

  // Use ensemble to select best candidate
  let selection = extractionEnsemble.selectBest(candidates);
  let best = selection.selected;

  logger.info('Ensemble selected extraction method', {
    url: baseUrl,
    method: best.method,
    score: selection.score.compositeScore,
    explanation: selection.explanation
  });

  // Completeness guard: ensure a minimum content size and structure
  const wordCount = best.content.split(/\s+/).filter(w => w.length > 0).length;
  const isIncomplete = (best.paragraphCount < 3) || (best.content.length < 300) || (wordCount < 80);
  if (isIncomplete && candidates.length > 1) {
    const sortedByCoverage = [...candidates].sort((a, b) => {
      const pa = (a.paragraphCount || 0);
      const pb = (b.paragraphCount || 0);
      const la = a.content.length;
      const lb = b.content.length;
      return (pb - pa) || (lb - la);
    });
    const preferred = sortedByCoverage.find(c => c !== best && (c.paragraphCount >= 3 || c.content.length >= 300));
    if (preferred) {
      best = preferred;
      selection = extractionEnsemble.selectBest([best]);
      logger.info('Completeness guard selected alternate candidate', {
        url: baseUrl,
        method: best.method,
        paragraphCount: best.paragraphCount,
        contentLength: best.content.length
      });
    } else {
      // As a last resort, augment with fallback paragraphs to meet completeness
      const fallback = toParagraphNodes(new JSDOM(processedHtml, { url: baseUrl }).window.document)
        .slice(0, Math.max(0, 5 - (best.paragraphCount || 0)))
        .map(n => n.text);
      if (fallback.length > 0) {
        best = {
          ...best,
          content: `${best.content}\n\n${fallback.join('\n\n')}`,
          paragraphCount: best.paragraphCount + fallback.length
        } as typeof best;
        logger.info('Completeness guard augmented content with fallback paragraphs', {
          url: baseUrl,
          addedParagraphs: fallback.length
        });
      }
    }
  }

  // Convert selected candidate to DistillationResult
  let nodes: DistilledNode[];
  let byline: string | null = null;
  let excerpt: string | null = null;
  let lang: string | null = null;
  let siteName: string | null = null;
  let ollamaMetadata: { model: string; durationMs: number } | undefined;

  switch (best.method) {
    case 'ollama': {
      nodes = best.content
        .split('\n\n')
        .filter((p) => p.trim().length > 0)
        .map((text, index) => ({
          id: `ollama-paragraph-${index}`,
          order: index,
          type: 'paragraph' as const,
          text: text.trim(),
          sourceSpans: [createSourceSpan(baseUrl, html, text.trim(), contentHash)]
        }));
      excerpt = best.metadata?.excerpt || null;
      // Try to get Ollama metadata from the original result
      try {
        const ollamaResult = await ollamaExtractor.extract(html, baseUrl);
        if (ollamaResult?.metadata.model) {
          ollamaMetadata = {
            model: ollamaResult.metadata.model,
            durationMs: ollamaResult.metadata.durationMs || 0
          };
        }
      } catch {}
      break;
    }
    case 'readability': {
      if (article) {
        nodes = createNodesFromFragment(article.content);
        byline = article.byline ?? null;
        excerpt = article.excerpt ?? null;
        lang = article.lang ?? dom.window.document.documentElement.getAttribute('lang');
        siteName = article.siteName ?? null;
      } else {
        nodes = [];
      }
      break;
    }
    case 'dom-heuristic': {
      nodes = domResult.paragraphs.map((p, index) => ({
        id: `dom-heuristic-${index}`,
        order: index,
        type: 'paragraph' as const,
        text: p.text,
        sourceSpans: [createSourceSpan(baseUrl, html, p.text, contentHash)]
      }));
      excerpt = best.metadata?.excerpt || null;
      break;
    }
    default:
      nodes = [];
  }

  // Compute full confidence breakdown
  const confidenceBreakdown = confidenceScorer.computeFull({
    extractorConfidence: best.confidence,
    content: best.content,
    paragraphCount: best.paragraphCount,
    title: best.title,
    author: byline,
    publishDate: null, // Future: extract from metadata
    excerpt,
    url: baseUrl,
    consensusInput: {
      candidates: candidates.map(c => ({
        method: c.method,
        content: c.content,
        title: c.title,
        score: c.confidence ?? 0.5
      }))
    }
  });

  return {
    title: best.title,
    byline,
    excerpt,
    lang,
    siteName,
    contentText: best.content,
    contentLength: best.content.length,
    contentHash,
    nodes,
    fallbackUsed: best.method === 'dom-heuristic' && nodes.length < 3,
    extractionMethod: best.method,
    extractionConfidence: confidenceBreakdown.overall, // Use Bayesian overall confidence
    ollamaMetadata,
    ensembleScore: selection.score,
    ensembleExplanation: selection.explanation,
    confidenceBreakdown,
    policyMetadata: policyResult
      ? {
          policyApplied: policyResult.policyApplied,
          rulesMatched: policyResult.rulesMatched,
          fieldsValidated: policyResult.fieldsValidated
        }
      : undefined
  };
};
