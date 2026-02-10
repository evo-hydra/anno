#!/usr/bin/env tsx

/**
 * LLM-Based Quality Evaluation
 *
 * Uses Ollama to evaluate quality of extracted content
 * Provides objective quality scores for validation
 */

interface QualityEvaluation {
  score: number; // 0-100
  reasoning: string;
  completeness: number; // 0-100
  accuracy: number; // 0-100
  relevance: number; // 0-100
  readability: number; // 0-100
}

interface ComparisonEvaluation {
  winner: 'anno' | 'traditional' | 'tie';
  annoScore: number;
  traditionalScore: number;
  reasoning: string;
  informationLoss: number; // 0-100, lower is better
}

export class LLMQualityEvaluator {
  private ollamaUrl: string;
  private model: string;

  constructor(
    ollamaUrl: string = 'http://localhost:11434',
    model: string = 'llama3.2:3b-instruct-q8_0'
  ) {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
  }

  /**
   * Evaluate single content quality
   */
  async evaluateContent(
    content: string,
    url: string,
    context: string = ''
  ): Promise<QualityEvaluation> {
    const prompt = `You are evaluating web content extraction quality.

URL: ${url}
${context ? `Context: ${context}` : ''}

EXTRACTED CONTENT:
${content.substring(0, 5000)}${content.length > 5000 ? '... [truncated]' : ''}

Evaluate this extracted content on the following criteria:
1. Completeness (0-100): Does it capture the main information?
2. Accuracy (0-100): Is the information correct and well-preserved?
3. Relevance (0-100): Is the content focused on important information?
4. Readability (0-100): Is it well-structured and easy to understand?

Respond ONLY with JSON in this exact format:
{
  "completeness": <number>,
  "accuracy": <number>,
  "relevance": <number>,
  "readability": <number>,
  "reasoning": "<brief explanation>"
}`;

    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: 0.1, // Low temperature for consistent evaluation
            num_predict: 500
          }
        })
      });

      const result = await response.json();
      const llmResponse = result.response || '{}';

      // Extract JSON from response
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const score = (
        (parsed.completeness || 0) +
        (parsed.accuracy || 0) +
        (parsed.relevance || 0) +
        (parsed.readability || 0)
      ) / 4;

      return {
        score,
        reasoning: parsed.reasoning || 'No reasoning provided',
        completeness: parsed.completeness || 0,
        accuracy: parsed.accuracy || 0,
        relevance: parsed.relevance || 0,
        readability: parsed.readability || 0
      };
    } catch (error) {
      console.error('LLM evaluation failed:', error);
      // Return neutral scores on error
      return {
        score: 50,
        reasoning: `Evaluation failed: ${error instanceof Error ? error.message : 'unknown'}`,
        completeness: 50,
        accuracy: 50,
        relevance: 50,
        readability: 50
      };
    }
  }

  /**
   * Compare Anno vs Traditional extraction
   */
  async compareExtractions(
    url: string,
    traditionalHtml: string,
    annoContent: string
  ): Promise<ComparisonEvaluation> {
    const prompt = `You are comparing two web content extraction methods.

URL: ${url}

METHOD A (Traditional - Raw HTML):
${traditionalHtml.substring(0, 2000)}${traditionalHtml.length > 2000 ? '... [truncated]' : ''}

METHOD B (Anno - Distilled):
${annoContent.substring(0, 2000)}${annoContent.length > 2000 ? '... [truncated]' : ''}

Compare these methods on:
1. Which preserves more important information?
2. Which is more readable for AI processing?
3. Which better removes noise (ads, navigation, etc.)?
4. Estimate information loss in Method B (0-100, where 0=no loss, 100=everything lost)

Respond ONLY with JSON in this exact format:
{
  "winner": "A" | "B" | "tie",
  "methodAScore": <number 0-100>,
  "methodBScore": <number 0-100>,
  "informationLoss": <number 0-100>,
  "reasoning": "<brief explanation>"
}`;

    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: 0.1,
            num_predict: 600
          }
        })
      });

      const result = await response.json();
      const llmResponse = result.response || '{}';

      // Extract JSON from response
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const winner = parsed.winner === 'A' ? 'traditional' :
                     parsed.winner === 'B' ? 'anno' : 'tie';

      return {
        winner,
        annoScore: parsed.methodBScore || 50,
        traditionalScore: parsed.methodAScore || 50,
        reasoning: parsed.reasoning || 'No reasoning provided',
        informationLoss: parsed.informationLoss || 50
      };
    } catch (error) {
      console.error('LLM comparison failed:', error);
      return {
        winner: 'tie',
        annoScore: 50,
        traditionalScore: 50,
        reasoning: `Comparison failed: ${error instanceof Error ? error.message : 'unknown'}`,
        informationLoss: 50
      };
    }
  }

  /**
   * Batch evaluate multiple URLs
   */
  async batchEvaluate(
    evaluations: Array<{
      url: string;
      traditionalHtml: string;
      annoContent: string;
    }>
  ): Promise<ComparisonEvaluation[]> {
    const results: ComparisonEvaluation[] = [];

    for (const { url, traditionalHtml, annoContent } of evaluations) {
      console.log(`Evaluating: ${url}`);
      const comparison = await this.compareExtractions(url, traditionalHtml, annoContent);
      results.push(comparison);

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Generate quality report
   */
  generateQualityReport(evaluations: ComparisonEvaluation[]): {
    avgNeurosurfScore: number;
    avgTraditionalScore: number;
    avgInformationLoss: number;
    annoWins: number;
    traditionalWins: number;
    ties: number;
    winRate: number;
  } {
    const avgNeurosurfScore = evaluations.reduce((sum, e) => sum + e.annoScore, 0) / evaluations.length;
    const avgTraditionalScore = evaluations.reduce((sum, e) => sum + e.traditionalScore, 0) / evaluations.length;
    const avgInformationLoss = evaluations.reduce((sum, e) => sum + e.informationLoss, 0) / evaluations.length;

    const annoWins = evaluations.filter(e => e.winner === 'anno').length;
    const traditionalWins = evaluations.filter(e => e.winner === 'traditional').length;
    const ties = evaluations.filter(e => e.winner === 'tie').length;

    const winRate = (annoWins / evaluations.length) * 100;

    return {
      avgNeurosurfScore,
      avgTraditionalScore,
      avgInformationLoss,
      annoWins,
      traditionalWins,
      ties,
      winRate
    };
  }
}

// Standalone test
async function main() {
  console.log('🔬 LLM Quality Evaluator Test\n');

  const evaluator = new LLMQualityEvaluator();

  // Test single evaluation
  const testContent = `
# Artificial Intelligence Overview

Artificial intelligence (AI) is the simulation of human intelligence by machines.
Key areas include:
- Machine Learning
- Natural Language Processing
- Computer Vision
- Robotics
`;

  console.log('Testing single content evaluation...');
  const quality = await evaluator.evaluateContent(
    testContent,
    'https://example.com/ai-article',
    'Article about AI fundamentals'
  );

  console.log('\nQuality Evaluation Results:');
  console.log(`  Overall Score: ${quality.score.toFixed(1)}/100`);
  console.log(`  Completeness: ${quality.completeness}/100`);
  console.log(`  Accuracy: ${quality.accuracy}/100`);
  console.log(`  Relevance: ${quality.relevance}/100`);
  console.log(`  Readability: ${quality.readability}/100`);
  console.log(`  Reasoning: ${quality.reasoning}`);

  // Test comparison
  const htmlSample = '<html><body><h1>AI Article</h1><div class="ad">Ad here</div><p>Content about AI...</p></body></html>';
  const annoSample = '# AI Article\n\nContent about AI...';

  console.log('\n\nTesting comparison evaluation...');
  const comparison = await evaluator.compareExtractions(
    'https://example.com/ai-article',
    htmlSample,
    annoSample
  );

  console.log('\nComparison Results:');
  console.log(`  Winner: ${comparison.winner}`);
  console.log(`  Anno Score: ${comparison.annoScore}/100`);
  console.log(`  Traditional Score: ${comparison.traditionalScore}/100`);
  console.log(`  Information Loss: ${comparison.informationLoss}%`);
  console.log(`  Reasoning: ${comparison.reasoning}`);
}

if (require.main === module) {
  main().catch(console.error);
}

export { QualityEvaluation, ComparisonEvaluation };
