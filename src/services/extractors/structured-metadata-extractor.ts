/**
 * Structured Metadata Extractor
 *
 * Extracts JSON-LD, Open Graph, Twitter Card, and Microdata from HTML documents.
 * Accepts a JSDOM Document to avoid double-parsing HTML.
 *
 * @module extractors/structured-metadata-extractor
 */

export interface MicrodataItem {
  type: string | null;
  properties: Record<string, string | MicrodataItem>;
}

export interface StructuredMetadata {
  jsonLd: Record<string, unknown>[];
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  microdata: MicrodataItem[];
  confidence: number;
}

export class StructuredMetadataExtractor {
  /**
   * Extract all structured metadata from a DOM Document.
   */
  extract(document: Document): StructuredMetadata {
    const jsonLd = this.extractJsonLd(document);
    const openGraph = this.extractOpenGraph(document);
    const twitterCard = this.extractTwitterCard(document);
    const microdata = this.extractMicrodata(document);
    const confidence = this.computeConfidence(jsonLd, openGraph, microdata);

    return { jsonLd, openGraph, twitterCard, microdata, confidence };
  }

  private extractJsonLd(document: Document): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');

    scripts.forEach((script) => {
      const text = script.textContent?.trim();
      if (!text) return;

      try {
        const parsed = JSON.parse(text);
        this.collectJsonLdItems(parsed, results);
      } catch {
        // Malformed JSON-LD — skip silently
      }
    });

    return results;
  }

  private collectJsonLdItems(parsed: unknown, results: Record<string, unknown>[]): void {
    if (!parsed || typeof parsed !== 'object') return;

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.collectJsonLdItems(item, results);
      }
      return;
    }

    const obj = parsed as Record<string, unknown>;

    // Flatten @graph arrays (used by news sites, Google structured data)
    if (Array.isArray(obj['@graph'])) {
      for (const item of obj['@graph']) {
        this.collectJsonLdItems(item, results);
      }
    }

    // Collect objects with @context or @type
    if ('@context' in obj || '@type' in obj) {
      results.push(obj);
    }
  }

  private extractOpenGraph(document: Document): Record<string, string> {
    const og: Record<string, string> = {};
    const metas = document.querySelectorAll('meta[property^="og:"]');

    metas.forEach((meta) => {
      const property = meta.getAttribute('property');
      const content = meta.getAttribute('content');
      if (property && content) {
        og[property] = content;
      }
    });

    return og;
  }

  private extractTwitterCard(document: Document): Record<string, string> {
    const twitter: Record<string, string> = {};
    const metas = document.querySelectorAll('meta[name^="twitter:"]');

    metas.forEach((meta) => {
      const name = meta.getAttribute('name');
      const content = meta.getAttribute('content');
      if (name && content) {
        twitter[name] = content;
      }
    });

    return twitter;
  }

  private extractMicrodata(document: Document): MicrodataItem[] {
    const items: MicrodataItem[] = [];
    // Only top-level itemscope elements (not nested)
    const topLevel = document.querySelectorAll('[itemscope]:not([itemscope] [itemscope])');

    topLevel.forEach((el) => {
      items.push(this.parseMicrodataItem(el));
    });

    return items;
  }

  private parseMicrodataItem(element: Element): MicrodataItem {
    const type = element.getAttribute('itemtype');
    const properties: Record<string, string | MicrodataItem> = {};

    const propElements = element.querySelectorAll('[itemprop]');
    propElements.forEach((prop) => {
      const name = prop.getAttribute('itemprop');
      if (!name) return;

      // Only collect props that belong directly to this itemscope.
      // A prop belongs to us if its nearest itemscope ancestor is this element.
      const nearestScope = prop.parentElement?.closest('[itemscope]');
      if (nearestScope !== element) {
        return;
      }

      if (prop.hasAttribute('itemscope')) {
        properties[name] = this.parseMicrodataItem(prop);
      } else {
        const value =
          prop.getAttribute('content') ??
          prop.getAttribute('href') ??
          prop.getAttribute('src') ??
          prop.textContent?.trim() ??
          '';
        properties[name] = value;
      }
    });

    return { type, properties };
  }

  private computeConfidence(
    jsonLd: Record<string, unknown>[],
    openGraph: Record<string, string>,
    microdata: MicrodataItem[]
  ): number {
    let confidence = 0;

    // JSON-LD with @type: up to 0.4
    if (jsonLd.length > 0 && jsonLd.some((item) => '@type' in item)) {
      confidence += 0.4;
    }

    // OG with title + description + image: up to 0.3
    const hasOgTitle = 'og:title' in openGraph;
    const hasOgDesc = 'og:description' in openGraph;
    const hasOgImage = 'og:image' in openGraph;
    if (hasOgTitle && hasOgDesc && hasOgImage) {
      confidence += 0.3;
    } else if (hasOgTitle) {
      confidence += 0.1;
    }

    // Microdata with properties: up to 0.3
    const hasRichMicrodata = microdata.some(
      (item) => Object.keys(item.properties).length > 0
    );
    if (hasRichMicrodata) {
      confidence += 0.3;
    }

    return Math.min(confidence, 1);
  }
}

export const structuredMetadataExtractor = new StructuredMetadataExtractor();
