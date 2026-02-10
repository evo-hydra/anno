# Anno Architecture

## Overview

Anno is built as a layered architecture where each layer adds intelligence and abstraction over traditional web browsing. The design prioritizes semantic understanding, probabilistic reasoning, and multi-agent collaboration.

## Core Architectural Principles

1. **Semantic-First**: Every piece of web content is immediately converted to structured, semantic representations
2. **Probabilistic Truth**: All information carries uncertainty and confidence measures
3. **Agent-Centric Design**: Built for AI consumption, not human visual processing
4. **Temporal Awareness**: Information is tracked across time with drift detection
5. **Collaborative Intelligence**: Multiple specialized agents work together
6. **Provenance Everything**: Full citation chains from conclusions to sources

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer H: Reasoning Engine                │
│  Multi-Agent Orchestration | Hypothesis Testing            │
├─────────────────────────────────────────────────────────────┤
│                 Layer G: Temporal Intelligence             │
│  Version Control | Drift Detection | Event-Driven Updates │
├─────────────────────────────────────────────────────────────┤
│                Layer F: Probabilistic Truth                │
│  Confidence Scoring | Source Credibility | Uncertainty     │
├─────────────────────────────────────────────────────────────┤
│                Layer E: Multi-Agent Swarm                  │
│  Agent Coordination | Specialization | Collective Memory   │
├─────────────────────────────────────────────────────────────┤
│                Layer D: Semantic Intelligence              │
│  Knowledge Graphs | Entity Resolution | Relationship Ext.  │
├─────────────────────────────────────────────────────────────┤
│                   Layer C: Content Delivery                │
│  JSONL Streams | Proxy Pages | Reader Mode Distillation    │
├─────────────────────────────────────────────────────────────┤
│                   Layer B: Site Adaptation                 │
│  Selector Learning | API Discovery | Drift Detection       │
├─────────────────────────────────────────────────────────────┤
│                    Layer A: Web Fetching                   │
│  QUIC Transport | Content Addressing | Deterministic JS    │
└─────────────────────────────────────────────────────────────┘
```

---

## Layer A: Web Fetching & Transport

### Responsibilities
- Protocol handling (QUIC/HTTP3/HTTP2/HTTP1.1)
- Content-addressed caching using IPFS-style hashing
- Robots.txt compliance and polite crawling
- Deterministic JavaScript execution with QuickJS
- Raw HTML/JSON/XML content retrieval

### Components

#### Transport Manager
```typescript
class TransportManager {
  async fetch(url: string, options: FetchOptions): Promise<RawContent> {
    // Try QUIC first, fallback to HTTP/2, then HTTP/1.1
    const transport = this.selectBestTransport(url);

    // Check robots.txt and rate limiting
    await this.respectRobotsTxt(url);
    await this.rateLimit.check(this.extractDomain(url));

    // Fetch with content addressing
    const contentHash = await this.getContentHash(url);
    if (this.cache.has(contentHash)) {
      return this.cache.get(contentHash);
    }

    const content = await transport.fetch(url, options);
    this.cache.set(contentHash, content);
    return content;
  }
}
```

#### Deterministic JavaScript Engine
```typescript
class DeterministicJS {
  constructor() {
    this.quickjs = new QuickJS({
      memoryLimit: 64 * 1024 * 1024,    // 64MB memory limit
      timeLimit: 5000,                   // 5 second execution limit
      stepLimit: 1000000,                // 1M instruction limit
      frozenTime: true                   // Freeze Date.now(), Math.random()
    });
  }

  async executeWithDOMDiff(
    script: string,
    initialDOM: DOMSnapshot
  ): Promise<{finalDOM: DOMSnapshot, mutations: DOMMutation[]}> {
    const context = this.quickjs.createContext();

    // Inject deterministic APIs
    context.global.Date.now = () => this.frozenTimestamp;
    context.global.Math.random = () => this.deterministicRandom.next();

    // Execute script and capture DOM mutations
    const result = await context.eval(script);
    const mutations = this.captureMutations(initialDOM);

    return { finalDOM: this.getCurrentDOM(), mutations };
  }
}
```

#### Content Addressing System
```typescript
class ContentAddressingSystem {
  generateHash(content: string, metadata: ContentMetadata): string {
    const canonical = this.canonicalize(content);
    const fullHash = sha256(canonical + JSON.stringify(metadata));
    return `sha256:${fullHash}`;
  }

  canonicalize(content: string): string {
    // Remove non-semantic variations (whitespace, comments, etc.)
    return content
      .replace(/<!--[\s\S]*?-->/g, '')      // Remove HTML comments
      .replace(/\s+/g, ' ')                 // Normalize whitespace
      .trim();
  }
}
```

### Data Flow
1. URL request → Transport selection → Rate limiting check
2. Content addressing → Cache check → Fetch if not cached
3. Content validation → Deterministic JS execution (if needed)
4. Raw content passed to Layer B

---

## Layer B: Site Adaptation & Learning

### Responsibilities
- CSS/XPath selector synthesis and repair
- API endpoint discovery via network monitoring
- DOM drift detection and adaptation
- Site-specific extraction pattern learning

### Components

#### Adaptive Selector Engine
```typescript
class AdaptiveSelectorEngine {
  private sitePatterns: Map<string, SitePattern> = new Map();
  private trainingData: ExtractionExample[] = [];

  async extract(url: string, intent: ExtractionIntent): Promise<ExtractionResult> {
    const domain = this.extractDomain(url);
    const pattern = this.sitePatterns.get(domain);

    if (pattern) {
      const result = await this.tryExtraction(pattern, intent);
      if (result.success && result.confidence > 0.8) {
        return result;
      }
    }

    // Pattern failed or doesn't exist, learn new one
    return await this.learnAndExtract(url, intent);
  }

  private async learnAndExtract(url: string, intent: ExtractionIntent): Promise<ExtractionResult> {
    // Use multiple selector strategies
    const candidates = await Promise.all([
      this.cssHeuristicExtraction(url, intent),
      this.domStructureAnalysis(url, intent),
      this.textualPatternMatching(url, intent),
      this.accessibilityTreeExtraction(url, intent)
    ]);

    // Score candidates and pick best
    const best = this.scoreCandidates(candidates, intent);

    // Learn from successful extraction
    if (best.confidence > 0.7) {
      this.updateSitePattern(url, intent, best.selector);
    }

    return best;
  }
}
```

#### API Discovery Engine
```typescript
class APIDiscoveryEngine {
  private networkMonitor: NetworkMonitor;

  async discoverAPIs(url: string): Promise<APIEndpoint[]> {
    // Monitor all network requests during page load
    const requests = await this.networkMonitor.captureRequests(url);

    const apiCandidates = requests
      .filter(req => req.responseType === 'application/json')
      .filter(req => this.isStableEndpoint(req.url))
      .map(req => this.analyzeEndpoint(req));

    return apiCandidates.filter(api => api.stability > 0.8);
  }

  private analyzeEndpoint(request: NetworkRequest): APIEndpoint {
    return {
      url: request.url,
      method: request.method,
      stability: this.calculateStability(request),
      dataSchema: this.inferSchema(request.response),
      rateLimit: this.detectRateLimit(request),
      authentication: this.detectAuth(request)
    };
  }
}
```

#### Drift Detection System
```typescript
class DriftDetectionSystem {
  async detectDrift(
    url: string,
    currentDOM: DOMSnapshot,
    historicalPattern: SitePattern
  ): Promise<DriftAnalysis> {

    const structuralFeatures = this.extractStructuralFeatures(currentDOM);
    const historicalFeatures = historicalPattern.structuralFeatures;

    const driftScore = this.computeStructuralDistance(
      structuralFeatures,
      historicalFeatures
    );

    if (driftScore > DRIFT_THRESHOLD) {
      const repairSuggestions = await this.generateRepairSuggestions(
        url, currentDOM, historicalPattern
      );

      return {
        drifted: true,
        severity: this.categorizeDriftSeverity(driftScore),
        affectedSelectors: this.identifyAffectedSelectors(historicalPattern),
        repairSuggestions
      };
    }

    return { drifted: false, severity: 'none' };
  }
}
```

### Data Flow
1. Raw content from Layer A → Selector application
2. If extraction fails → Learning mode activation
3. Multiple extraction strategies → Best candidate selection
4. Successful pattern → Site pattern database update
5. Structured data passed to Layer C

---

## Layer C: Content Delivery & Distillation

### Responsibilities
- Convert raw HTML to semantic JSONL streams
- Generate human-readable proxy pages
- Reader mode distillation with provenance
- Chrome DevTools Protocol integration

### Components

#### JSONL Stream Generator
```typescript
class JSONLStreamGenerator {
  async generateStream(
    content: RawContent,
    extractedData: ExtractionResult[]
  ): Promise<AsyncIterable<JSONLEvent>> {

    const events: AsyncIterable<JSONLEvent> = async function* () {
      // Emit metadata first
      yield {
        type: 'metadata',
        url: content.url,
        timestamp: content.fetchTimestamp,
        contentHash: content.hash,
        title: content.title,
        language: content.language
      };

      // Emit structured nodes
      for (const node of content.domNodes) {
        if (node.semantic_value > SEMANTIC_THRESHOLD) {
          yield {
            type: 'node',
            id: node.id,
            selector: node.selector,
            content: node.textContent,
            attributes: node.relevantAttributes,
            provenance: {
              byteRange: node.byteRange,
              sha256: node.contentHash,
              extractionConfidence: node.confidence
            }
          };
        }
      }

      // Emit extracted entities and relationships
      for (const entity of extractedData.entities) {
        yield {
          type: 'entity',
          text: entity.text,
          type: entity.type,
          confidence: entity.confidence,
          linkedData: entity.wikidataId,
          provenance: entity.sourceNodes
        };
      }

      // Signal completion
      yield { type: 'done' };
    };

    return events();
  }
}
```

#### Reader Mode Distillation
```typescript
class ReaderModeDistiller {
  private readability: Readability;
  private trafilatura: Trafilatura;

  async distill(html: string, url: string): Promise<DistilledContent> {
    // Try multiple distillation approaches
    const candidates = await Promise.all([
      this.readability.extract(html),
      this.trafilatura.extract(html),
      this.customHeuristicExtraction(html)
    ]);

    // Score and combine results
    const best = this.selectBestDistillation(candidates);

    return {
      title: best.title,
      content: best.content,
      publishDate: best.publishDate,
      author: best.author,
      mainImage: best.mainImage,
      readingTime: this.estimateReadingTime(best.content),
      provenance: this.generateProvenance(best, html),
      confidence: best.confidence
    };
  }

  private generateProvenance(
    distilled: DistilledCandidate,
    originalHtml: string
  ): ProvenanceRecord {
    return {
      extractionMethod: distilled.method,
      sourceSelectors: distilled.selectors,
      confidenceBreakdown: {
        contentQuality: distilled.contentQuality,
        structuralClarity: distilled.structuralClarity,
        semanticCoherence: distilled.semanticCoherence
      },
      originalByteRanges: this.mapToByteRanges(distilled.selectors, originalHtml)
    };
  }
}
```

### Data Flow
1. Structured data from Layer B → JSONL event generation
2. Raw HTML → Reader mode distillation
3. CDP integration → Clean DOM snapshots
4. Provenance generation → Citation tracking
5. Stream output to Layer D + proxy page generation

---

## Layer D: Semantic Intelligence

### Responsibilities
- Real-time knowledge graph construction
- Entity recognition and resolution
- Relationship extraction
- Cross-page semantic linking

### Components

#### Knowledge Graph Builder
```typescript
class KnowledgeGraphBuilder {
  private entityResolver: EntityResolver;
  private relationExtractor: RelationExtractor;
  private graph: SemanticGraph;

  async processPage(events: AsyncIterable<JSONLEvent>): Promise<SemanticPage> {
    const entities: Entity[] = [];
    const relations: Relation[] = [];
    const claims: Claim[] = [];

    for await (const event of events) {
      switch (event.type) {
        case 'entity':
          const resolvedEntity = await this.entityResolver.resolve(event);
          entities.push(resolvedEntity);
          break;

        case 'node':
          // Extract additional entities and relationships from text
          const extracted = await this.extractSemanticContent(event.content);
          entities.push(...extracted.entities);
          relations.push(...extracted.relations);
          claims.push(...extracted.claims);
          break;
      }
    }

    // Cross-reference with existing knowledge graph
    const linkedEntities = await this.linkToExistingEntities(entities);
    const verifiedClaims = await this.verifyClaims(claims);

    const semanticPage: SemanticPage = {
      entities: linkedEntities,
      relationships: relations,
      claims: verifiedClaims,
      temporalBounds: this.extractTemporalBounds(events),
      contradictions: await this.detectContradictions(verifiedClaims)
    };

    // Update global knowledge graph
    await this.graph.integrate(semanticPage);

    return semanticPage;
  }
}
```

#### Entity Resolution Engine
```typescript
class EntityResolver {
  private wikidataClient: WikidataClient;
  private localCache: EntityCache;

  async resolve(entity: RawEntity): Promise<ResolvedEntity> {
    // Try local cache first
    const cached = this.localCache.get(entity.text, entity.context);
    if (cached && cached.confidence > 0.9) {
      return cached;
    }

    // Resolve against multiple knowledge bases
    const candidates = await Promise.all([
      this.wikidataClient.search(entity.text, entity.context),
      this.dbpediaClient.search(entity.text, entity.context),
      this.customEntityMatcher.match(entity.text, entity.context)
    ]);

    // Score and select best resolution
    const best = this.scoreCandidates(candidates, entity);

    // Update cache if confidence is high
    if (best.confidence > 0.8) {
      this.localCache.set(entity.text, entity.context, best);
    }

    return best;
  }
}
```

#### Temporal Bounds Extraction
```typescript
class TemporalBoundsExtractor {
  async extractTemporalBounds(page: SemanticPage): Promise<TemporalBounds> {
    // Extract temporal indicators from text
    const timeExpressions = await this.extractTimeExpressions(page);

    // Analyze publication/modification dates
    const publishDates = this.extractPublishDates(page);

    // Determine information validity period
    const validityPeriod = this.inferValidityPeriod(
      timeExpressions,
      publishDates,
      page.claims
    );

    return {
      publicationDate: publishDates.published,
      lastModified: publishDates.modified,
      informationValidFrom: validityPeriod.start,
      informationValidUntil: validityPeriod.end,
      temporalExpressions: timeExpressions,
      confidence: this.calculateTemporalConfidence(timeExpressions)
    };
  }
}
```

### Data Flow
1. JSONL events from Layer C → Entity extraction & resolution
2. Resolved entities → Relationship extraction
3. Claims extraction → Temporal bounds analysis
4. Knowledge graph integration → Contradiction detection
5. Semantic page output to Layer E

---

## Layer E: Multi-Agent Swarm Intelligence

### Responsibilities
- Agent specialization and coordination
- Task decomposition and distribution
- Collective memory management
- Result synthesis and verification

### Components

#### Agent Orchestra
```typescript
class AgentOrchestra {
  private agents: Map<string, SpecializedAgent> = new Map();
  private taskQueue: TaskQueue;
  private sharedMemory: SharedKnowledgeGraph;

  async research(query: ResearchQuery): Promise<ResearchResult> {
    // Decompose query into sub-tasks
    const tasks = await this.decompose(query);

    // Assign tasks to specialized agents
    const assignments = this.assignTasks(tasks);

    // Execute tasks in parallel with coordination
    const results = await this.executeWithCoordination(assignments);

    // Synthesize results
    return await this.synthesize(results, query);
  }

  private assignTasks(tasks: Task[]): TaskAssignment[] {
    return tasks.map(task => {
      const suitableAgents = this.findSuitableAgents(task);
      const primaryAgent = this.selectPrimary(suitableAgents, task);
      const verificationAgents = this.selectVerifiers(suitableAgents, primaryAgent);

      return {
        task,
        primaryAgent,
        verificationAgents,
        maxDuration: this.estimateTaskDuration(task)
      };
    });
  }
}
```

#### Specialized Agent Types
```typescript
abstract class SpecializedAgent {
  abstract specialization: string[];
  abstract skills: string[];

  async process(task: Task, context: AgentContext): Promise<AgentResult> {
    // Validate task fits specialization
    if (!this.canHandle(task)) {
      throw new Error(`Agent cannot handle task type: ${task.type}`);
    }

    // Execute specialized processing
    const result = await this.executeTask(task, context);

    // Add agent-specific metadata
    result.metadata.processingAgent = this.constructor.name;
    result.metadata.specialization = this.specialization;

    return result;
  }

  abstract canHandle(task: Task): boolean;
  abstract executeTask(task: Task, context: AgentContext): Promise<AgentResult>;
}

class AcademicResearchAgent extends SpecializedAgent {
  specialization = ['arxiv.org', 'scholar.google.com', 'pubmed.ncbi.nlm.nih.gov'];
  skills = ['citation_extraction', 'peer_review_analysis', 'methodology_assessment'];

  canHandle(task: Task): boolean {
    return task.domain === 'academic' ||
           task.sources.some(source => this.specialization.includes(this.extractDomain(source)));
  }

  async executeTask(task: Task, context: AgentContext): Promise<AgentResult> {
    // Specialized academic processing
    const papers = await this.findRelevantPapers(task.query);
    const citationNetwork = await this.buildCitationNetwork(papers);
    const methodologyAssessment = await this.assessMethodologies(papers);

    return {
      claims: this.extractAcademicClaims(papers),
      evidence: this.buildEvidenceChain(citationNetwork),
      confidence: this.calculateAcademicConfidence(methodologyAssessment),
      metadata: {
        citationCount: citationNetwork.totalCitations,
        peerReviewStatus: methodologyAssessment.reviewStatus,
        replicationAttempts: methodologyAssessment.replications
      }
    };
  }
}
```

#### Collective Memory System
```typescript
class CollectiveMemorySystem {
  private distributedGraph: DistributedKnowledgeGraph;
  private consensusEngine: ConsensusEngine;

  async updateGlobalKnowledge(
    agentResults: AgentResult[],
    verification: VerificationResult
  ): Promise<void> {

    // Extract new knowledge claims
    const newClaims = this.extractClaims(agentResults);

    // Check against existing knowledge
    const conflicts = await this.identifyConflicts(newClaims);

    if (conflicts.length > 0) {
      // Resolve conflicts through consensus
      const resolution = await this.consensusEngine.resolve(conflicts);
      await this.distributedGraph.update(resolution.resolvedClaims);
    } else {
      // No conflicts, directly integrate
      await this.distributedGraph.integrate(newClaims);
    }

    // Update agent specialization knowledge
    await this.updateSpecializationKnowledge(agentResults);
  }
}
```

### Data Flow
1. Research query → Task decomposition → Agent assignment
2. Parallel agent execution → Intermediate result sharing
3. Cross-agent verification → Consensus building
4. Result synthesis → Collective memory update
5. Final research result to Layer F

---

## Layer F: Probabilistic Truth Engine

### Responsibilities
- Multi-dimensional confidence scoring
- Source credibility learning
- Uncertainty propagation
- Bayesian truth synthesis

### Components

#### Confidence Scoring Engine
```typescript
class ConfidenceScoring {
  async computeConfidence(claim: Claim, context: ConfidenceContext): Promise<ConfidenceScore> {
    const scores = await Promise.all([
      this.extractionConfidence(claim),
      this.sourceCredibilityScore(claim.sources, claim.domain),
      this.temporalConfidence(claim.temporalBounds),
      this.crossValidationScore(claim),
      this.logicalConsistencyScore(claim, context.knowledgeGraph)
    ]);

    // Bayesian combination of confidence dimensions
    const overall = this.bayesianCombination(scores);

    return {
      extraction: scores[0],
      sourceCredibility: scores[1],
      temporal: scores[2],
      crossValidation: scores[3],
      logicalConsistency: scores[4],
      overall,
      uncertaintySources: this.identifyUncertaintySources(scores)
    };
  }

  private bayesianCombination(scores: number[]): number {
    // Convert to log-odds, sum, convert back to probability
    const logOdds = scores.map(p => Math.log(p / (1 - p)));
    const sumLogOdds = logOdds.reduce((sum, lo) => sum + lo, 0);
    return 1 / (1 + Math.exp(-sumLogOdds));
  }
}
```

#### Source Credibility Learning
```typescript
class SourceCredibilitySystem {
  private credibilityProfiles: Map<string, SourceProfile> = new Map();

  async assessCredibility(
    source: Source,
    domain: string,
    claim: Claim
  ): Promise<CredibilityAssessment> {

    const profile = this.getOrCreateProfile(source.domain);

    // Multi-factor credibility assessment
    const factors = {
      historicalAccuracy: profile.historicalAccuracy[domain] || 0.5,
      expertiseScore: await this.assessExpertise(source, domain),
      transparencyScore: this.assessTransparency(source),
      biasIndicators: this.detectBias(source, claim),
      updateFrequency: profile.updateFrequency,
      factCheckingHistory: profile.factCheckingHistory
    };

    const credibilityScore = this.computeCredibilityScore(factors);

    // Update profile with this assessment
    await this.updateCredibilityProfile(source, domain, credibilityScore, factors);

    return {
      score: credibilityScore,
      factors,
      reasoning: this.explainCredibilityScore(factors)
    };
  }

  async learnFromVerification(
    source: Source,
    domain: string,
    claim: Claim,
    verificationResult: VerificationResult
  ): Promise<void> {
    // Update historical accuracy based on verification
    const profile = this.credibilityProfiles.get(source.domain);
    if (profile) {
      profile.historicalAccuracy[domain] = this.updateAccuracy(
        profile.historicalAccuracy[domain],
        verificationResult.wasAccurate
      );
    }
  }
}
```

#### Uncertainty Propagation
```typescript
class UncertaintyPropagation {
  async propagateUncertainty(
    reasoning: ReasoningChain,
    premises: Claim[]
  ): Promise<UncertaintyAnalysis> {

    const stepConfidences: number[] = [];
    let accumulatedUncertainty = 0;

    for (const step of reasoning.steps) {
      const stepInputConfidences = step.inputClaims.map(claim =>
        premises.find(p => p.id === claim.id)?.confidence.overall || 0.5
      );

      // Calculate step confidence based on input confidences and inference type
      const stepConfidence = this.calculateStepConfidence(
        stepInputConfidences,
        step.inferenceType
      );

      stepConfidences.push(stepConfidence);

      // Accumulate uncertainty (error propagation)
      accumulatedUncertainty = this.combineUncertainties(
        accumulatedUncertainty,
        1 - stepConfidence,
        step.inferenceType
      );
    }

    const finalConfidence = 1 - accumulatedUncertainty;

    return {
      finalConfidence,
      stepConfidences,
      uncertaintySources: this.identifyUncertaintySources(reasoning, premises),
      sensitivityAnalysis: await this.performSensitivityAnalysis(reasoning, premises)
    };
  }
}
```

### Data Flow
1. Claims from Layer E → Confidence computation
2. Source assessment → Credibility profile update
3. Uncertainty propagation → Sensitivity analysis
4. Probabilistic claims to Layer G

---

## Layer G: Temporal Intelligence

### Responsibilities
- Information version control
- Predictive drift detection
- Event-driven revalidation
- Volatility scoring and tracking

### Components

#### Information Version Control
```typescript
class InformationVersionControl {
  private entityTimelines: Map<string, EntityTimeline> = new Map();

  async trackInformation(entity: Entity, newValue: any, source: Source): Promise<void> {
    const timeline = this.entityTimelines.get(entity.id) || new EntityTimeline(entity);

    const newVersion: InformationVersion = {
      timestamp: Date.now(),
      value: newValue,
      source,
      confidence: newValue.confidence,
      changeType: this.detectChangeType(timeline.current, newValue),
      changeMagnitude: this.computeChangeMagnitude(timeline.current, newValue)
    };

    timeline.add(newVersion);

    // Detect significant changes
    if (newVersion.changeMagnitude > SIGNIFICANT_CHANGE_THRESHOLD) {
      await this.triggerChangeEvent(entity, newVersion);
    }

    this.entityTimelines.set(entity.id, timeline);
  }

  async queryHistoricalValue(
    entity: Entity,
    timestamp: number
  ): Promise<InformationVersion | null> {
    const timeline = this.entityTimelines.get(entity.id);
    if (!timeline) return null;

    return timeline.getValueAtTime(timestamp);
  }
}
```

#### Predictive Drift Detection
```typescript
class PredictiveDriftDetection {
  private volatilityModels: Map<string, VolatilityModel> = new Map();

  async predictDrift(entity: Entity): Promise<DriftPrediction> {
    const timeline = this.getTimeline(entity);
    const model = this.volatilityModels.get(entity.category) || this.buildVolatilityModel(entity);

    // Analyze historical patterns
    const patterns = this.analyzePatterns(timeline);

    // External event correlation
    const eventCorrelations = await this.analyzeEventCorrelations(entity);

    // Predict next change probability
    const changeProbability = model.predictChangeProbability(
      patterns,
      eventCorrelations,
      this.getCurrentMarketConditions()
    );

    return {
      changeProbability,
      predictedMagnitude: model.predictChangeMagnitude(patterns),
      timeToNextChange: model.predictTimeToChange(patterns),
      triggersToWatch: eventCorrelations.significantTriggers,
      revalidationSchedule: this.generateRevalidationSchedule(changeProbability)
    };
  }
}
```

#### Event-Driven Revalidation
```typescript
class EventDrivenRevalidation {
  private eventListeners: Map<string, EventListener[]> = new Map();

  async registerEntity(entity: Entity, triggers: EventTrigger[]): Promise<void> {
    for (const trigger of triggers) {
      const listeners = this.eventListeners.get(trigger.eventType) || [];
      listeners.push({
        entityId: entity.id,
        priority: trigger.priority,
        callback: () => this.scheduleRevalidation(entity, trigger.priority)
      });
      this.eventListeners.set(trigger.eventType, listeners);
    }
  }

  async processEvent(event: ExternalEvent): Promise<void> {
    const listeners = this.eventListeners.get(event.type) || [];

    // Sort by priority and execute
    listeners
      .sort((a, b) => b.priority - a.priority)
      .forEach(listener => {
        listener.callback();
      });
  }

  private async scheduleRevalidation(entity: Entity, priority: Priority): Promise<void> {
    const delay = this.calculateDelay(priority);

    setTimeout(async () => {
      const currentValue = await this.fetchCurrentValue(entity);
      const storedValue = await this.getStoredValue(entity);

      if (this.hasSignificantChange(currentValue, storedValue)) {
        await this.updateAndNotify(entity, currentValue);
      }
    }, delay);
  }
}
```

### Data Flow
1. New information → Version control tracking
2. Historical analysis → Drift prediction model
3. External events → Revalidation triggering
4. Updated information → Confidence recalculation
5. Temporal intelligence to Layer H

---

## Layer H: Reasoning Engine & Orchestration

### Responsibilities
- Multi-agent research orchestration
- Hypothesis testing frameworks
- Evidence aggregation and synthesis
- Citation provenance graph construction

### Components

#### Research Orchestrator
```typescript
class ResearchOrchestrator {
  async conductResearch(query: ComplexQuery): Promise<ResearchResult> {
    // Generate research strategy
    const strategy = await this.generateStrategy(query);

    // Create hypothesis to test
    const hypothesis = await this.generateHypothesis(query);

    // Decompose into research tasks
    const tasks = this.decomposeTasks(strategy, hypothesis);

    // Execute multi-agent research
    const rawResults = await this.executeMultiAgentResearch(tasks);

    // Synthesize findings
    const synthesis = await this.synthesizeFindings(rawResults, hypothesis);

    // Build reasoning chain
    const reasoningChain = this.buildReasoningChain(synthesis);

    // Generate final assessment
    return {
      hypothesis: hypothesis,
      evidence: synthesis.evidence,
      reasoning: reasoningChain,
      conclusion: synthesis.conclusion,
      confidence: synthesis.confidence,
      provenance: this.buildProvenanceGraph(rawResults),
      recommendations: this.generateRecommendations(synthesis)
    };
  }
}
```

#### Hypothesis Testing Framework
```typescript
class HypothesisTestingFramework {
  async testHypothesis(
    hypothesis: Hypothesis,
    evidence: Evidence[]
  ): Promise<HypothesisTest> {

    // Categorize evidence
    const supporting = evidence.filter(e => this.supportsHypothesis(e, hypothesis));
    const contradicting = evidence.filter(e => this.contradictsHypothesis(e, hypothesis));
    const neutral = evidence.filter(e => !this.supportsHypothesis(e, hypothesis) && !this.contradictsHypothesis(e, hypothesis));

    // Calculate weighted evidence scores
    const supportScore = this.calculateEvidenceScore(supporting);
    const contradictScore = this.calculateEvidenceScore(contradicting);

    // Perform statistical tests if applicable
    const statisticalTests = await this.performStatisticalTests(hypothesis, evidence);

    // Generate alternative hypotheses
    const alternatives = await this.generateAlternativeHypotheses(hypothesis, contradicting);

    return {
      hypothesis,
      supportingEvidence: supporting,
      contradictingEvidence: contradicting,
      evidenceBalance: supportScore / (supportScore + contradictScore),
      statisticalSignificance: statisticalTests.pValue,
      alternativeHypotheses: alternatives,
      recommendation: this.generateTestRecommendation(supportScore, contradictScore, statisticalTests)
    };
  }
}
```

#### Citation Provenance Engine
```typescript
class CitationProvenanceEngine {
  buildProvenanceGraph(researchResults: AgentResult[]): ProvenanceGraph {
    const graph = new ProvenanceGraph();

    for (const result of researchResults) {
      // Add source nodes
      for (const source of result.sources) {
        graph.addSourceNode({
          id: source.id,
          url: source.url,
          title: source.title,
          credibility: source.credibilityScore,
          accessTime: source.accessTimestamp
        });
      }

      // Add claim nodes
      for (const claim of result.claims) {
        graph.addClaimNode({
          id: claim.id,
          content: claim.content,
          confidence: claim.confidence,
          extractionMethod: claim.extractionMethod
        });

        // Link claims to sources
        for (const sourceId of claim.sourceIds) {
          graph.addEdge(sourceId, claim.id, {
            type: 'supports',
            strength: claim.sourceSupport[sourceId],
            extractionConfidence: claim.extractionConfidence
          });
        }
      }

      // Add reasoning step nodes
      for (const step of result.reasoning.steps) {
        graph.addReasoningNode({
          id: step.id,
          type: step.inferenceType,
          inputs: step.inputClaimIds,
          output: step.outputClaimId,
          confidence: step.confidence,
          method: step.method
        });
      }
    }

    return graph;
  }

  async explainConclusion(
    conclusion: Claim,
    graph: ProvenanceGraph
  ): Promise<ProvenanceExplanation> {

    // Trace back from conclusion to sources
    const paths = graph.findAllPaths(conclusion.id, node => node.type === 'source');

    // Score paths by reliability
    const scoredPaths = paths.map(path => ({
      path,
      reliability: this.calculatePathReliability(path),
      criticalNodes: this.identifyCriticalNodes(path)
    }));

    // Generate natural language explanation
    const explanation = await this.generateExplanation(scoredPaths);

    return {
      conclusion,
      supportingPaths: scoredPaths.filter(p => p.reliability > 0.7),
      weakestLinks: this.identifyWeakestLinks(scoredPaths),
      explanation,
      alternativeInterpretations: await this.generateAlternativeInterpretations(scoredPaths)
    };
  }
}
```

### Data Flow
1. Complex query → Strategy generation → Hypothesis formation
2. Task decomposition → Multi-agent execution
3. Result synthesis → Evidence categorization
4. Hypothesis testing → Statistical analysis
5. Provenance graph construction → Final research result

---

## Cross-Layer Communication

### Event Bus Architecture
```typescript
class AnnoEventBus {
  private subscribers: Map<string, EventHandler[]> = new Map();

  // Inter-layer communication
  async publishEvent(event: AnnoEvent): Promise<void> {
    const handlers = this.subscribers.get(event.type) || [];

    await Promise.all(
      handlers.map(handler => handler.handle(event))
    );
  }

  subscribe(eventType: string, handler: EventHandler): void {
    const handlers = this.subscribers.get(eventType) || [];
    handlers.push(handler);
    this.subscribers.set(eventType, handlers);
  }
}

// Example events that flow between layers
interface LayerEvents {
  'content_fetched': { url: string, content: RawContent, layer: 'A' },
  'extraction_learned': { domain: string, pattern: SitePattern, layer: 'B' },
  'semantic_processed': { page: SemanticPage, layer: 'D' },
  'confidence_updated': { claim: Claim, confidence: ConfidenceScore, layer: 'F' },
  'drift_detected': { entity: Entity, drift: DriftAnalysis, layer: 'G' },
  'research_completed': { query: ComplexQuery, result: ResearchResult, layer: 'H' }
}
```

### Performance Monitoring
```typescript
class PerformanceMonitor {
  private metrics: Map<string, LayerMetrics> = new Map();

  async recordLayerPerformance(
    layer: string,
    operation: string,
    duration: number,
    metadata: Record<string, any>
  ): Promise<void> {

    const layerMetrics = this.metrics.get(layer) || new LayerMetrics(layer);
    layerMetrics.record(operation, duration, metadata);
    this.metrics.set(layer, layerMetrics);

    // Trigger alerts for performance issues
    if (duration > this.getThreshold(layer, operation)) {
      await this.triggerPerformanceAlert(layer, operation, duration);
    }
  }
}
```

This architecture provides a robust foundation for building Anno as a truly AI-native web browser, where each layer adds sophisticated intelligence while maintaining clean separation of concerns and efficient communication patterns.