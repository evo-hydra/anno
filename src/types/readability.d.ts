declare module '@mozilla/readability' {
  export interface ReadabilityParseResult {
    title?: string;
    byline?: string | null;
    dir?: string | null;
    lang?: string | null;
    content: string;
    textContent?: string;
    length?: number;
    excerpt?: string | null;
    siteName?: string | null;
  }

  export class Readability {
    constructor(document: Document, options?: Record<string, unknown>);
    parse(): ReadabilityParseResult | null;
  }
}
