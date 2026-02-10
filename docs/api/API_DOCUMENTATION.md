# Anno API Documentation

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [REST API Endpoints](#rest-api-endpoints)
4. [WebSocket API](#websocket-api)
5. [Client SDKs](#client-sdks)
6. [Error Handling](#error-handling)
7. [Rate Limiting](#rate-limiting)
8. [API Versioning](#api-versioning)
9. [Examples](#examples)

---

## Overview

Anno provides multiple API interfaces for interacting with the AI-native web browser:

- **REST API**: Synchronous operations for content fetching, knowledge graph queries
- **WebSocket API**: Real-time streaming for multi-agent research and live updates
- **GraphQL API**: Flexible queries for knowledge graph exploration
- **gRPC API**: High-performance interface for service-to-service communication

### Base URLs

```
Production:  https://api.anno.ai/v1
Staging:     https://staging-api.anno.ai/v1
Development: http://localhost:5213/v1
```

### Content Types

- **Request**: `application/json`
- **Response**: `application/json` or `application/x-ndjson` (for streaming)
- **WebSocket**: `application/json` messages

---

## Authentication

Anno uses API keys for authentication. Include your API key in the `Authorization` header:

```http
Authorization: Bearer your_api_key_here
```

### API Key Management

```http
POST /v1/auth/keys
```

**Create API Key**:
```json
{
  "name": "My Research Project",
  "permissions": ["read", "write"],
  "expiresIn": "30d"
}
```

**Response**:
```json
{
  "apiKey": "ns_live_abc123...",
  "keyId": "key_xyz789",
  "permissions": ["read", "write"],
  "expiresAt": "2024-02-15T10:30:00Z"
}
```

---

## REST API Endpoints

### Content Fetching

#### Fetch Web Content
```http
POST /v1/content/fetch
```

**Request Body**:
```json
{
  "url": "https://example.com/article",
  "options": {
    "userAgent": "Anno/1.0",
    "timeout": 30000,
    "followRedirects": true,
    "maxRedirects": 5,
    "useCache": true,
    "distillContent": true
  }
}
```

**Response**:
```json
{
  "content": {
    "url": "https://example.com/article",
    "title": "Example Article",
    "distilledContent": "The main article content...",
    "metadata": {
      "author": "John Doe",
      "publishDate": "2024-01-15T10:30:00Z",
      "wordCount": 1250,
      "readingTime": 5
    },
    "extractedData": {
      "entities": [
        {
          "text": "New York",
          "type": "LOCATION",
          "confidence": 0.95,
          "wikidataId": "Q60"
        }
      ],
      "relationships": [
        {
          "subject": "John Doe",
          "predicate": "AUTHOR_OF",
          "object": "Example Article",
          "confidence": 0.89
        }
      ]
    }
  },
  "processingTime": 1250,
  "fromCache": false,
  "confidence": 0.92
}
```

#### Stream Content Processing
```http
POST /v1/content/stream
```

Returns an NDJSON stream of processing events:

```json
{"type":"metadata","url":"https://example.com","title":"Example"}
{"type":"node","id":"node_1","content":"Main paragraph text..."}
{"type":"entity","text":"New York","type":"LOCATION","confidence":0.95}
{"type":"done","processingTime":1250}
```

### Research Operations

#### Conduct Research
```http
POST /v1/research/query
```

**Request Body**:
```json
{
  "question": "What are the latest developments in quantum computing?",
  "options": {
    "depth": "comprehensive",
    "maxSources": 20,
    "includeAcademic": true,
    "includeNews": true,
    "verificationLevel": "enhanced",
    "timeRange": {
      "from": "2023-01-01",
      "to": "2024-01-01"
    }
  }
}
```

**Response**:
```json
{
  "answer": "Recent developments in quantum computing include...",
  "confidence": 0.87,
  "evidence": [
    {
      "claim": "IBM announced a 1000-qubit processor",
      "sources": ["https://ibm.com/quantum", "https://nature.com/articles/..."],
      "confidence": 0.94
    }
  ],
  "reasoning": {
    "steps": [
      {
        "type": "information_gathering",
        "description": "Collected recent articles about quantum computing",
        "sources": 15
      },
      {
        "type": "synthesis",
        "description": "Analyzed trends across multiple sources",
        "confidence": 0.89
      }
    ]
  },
  "agents": ["academic-research-agent", "news-analysis-agent"],
  "processingTime": 25000
}
```

#### Get Research Status
```http
GET /v1/research/status/{requestId}
```

**Response**:
```json
{
  "requestId": "req_abc123",
  "status": "processing",
  "progress": 0.65,
  "eta": 15000,
  "currentAgent": "academic-research-agent",
  "completedTasks": 3,
  "totalTasks": 5
}
```

### Knowledge Graph Operations

#### Query Knowledge Graph
```http
POST /v1/knowledge/query
```

**Request Body**:
```json
{
  "query": {
    "type": "cypher",
    "statement": "MATCH (e:Entity {name: $name})-[r]->(related) RETURN e, r, related LIMIT 10",
    "parameters": {
      "name": "Tesla"
    }
  }
}
```

**Response**:
```json
{
  "results": [
    {
      "e": {
        "id": "entity_123",
        "name": "Tesla",
        "type": "ORGANIZATION",
        "properties": {
          "founded": "2003",
          "industry": "Electric Vehicles"
        }
      },
      "r": {
        "type": "CEO_OF",
        "since": "2008"
      },
      "related": {
        "id": "entity_456",
        "name": "Elon Musk",
        "type": "PERSON"
      }
    }
  ],
  "executionTime": 45,
  "resultCount": 1
}
```

#### Add Knowledge
```http
POST /v1/knowledge/entities
```

**Request Body**:
```json
{
  "entities": [
    {
      "text": "Anno",
      "type": "ORGANIZATION",
      "properties": {
        "industry": "AI Technology",
        "founded": "2024"
      },
      "sources": ["https://anno.ai/about"]
    }
  ]
}
```

### Agent Management

#### List Available Agents
```http
GET /v1/agents
```

**Response**:
```json
{
  "agents": [
    {
      "id": "academic-research-agent",
      "name": "Academic Research Agent",
      "version": "1.2.0",
      "specialization": ["arxiv.org", "scholar.google.com"],
      "skills": ["citation_analysis", "peer_review"],
      "status": "active",
      "currentLoad": 0.3
    },
    {
      "id": "news-analysis-agent",
      "name": "News Analysis Agent",
      "version": "1.1.0",
      "specialization": ["reuters.com", "ap.org"],
      "skills": ["fact_checking", "bias_detection"],
      "status": "active",
      "currentLoad": 0.7
    }
  ]
}
```

#### Get Agent Details
```http
GET /v1/agents/{agentId}
```

#### Create Custom Agent
```http
POST /v1/agents
```

**Request Body**:
```json
{
  "name": "Custom Finance Agent",
  "specialization": ["bloomberg.com", "reuters.com/finance"],
  "skills": ["financial_analysis", "market_trends"],
  "config": {
    "maxConcurrentTasks": 5,
    "timeoutMs": 30000
  }
}
```

### Source Management

#### Manage Source Credibility
```http
GET /v1/sources/credibility/{domain}
```

**Response**:
```json
{
  "domain": "reuters.com",
  "credibility": {
    "overall": 0.94,
    "byTopic": {
      "politics": 0.92,
      "finance": 0.96,
      "technology": 0.89
    }
  },
  "history": {
    "totalAssessments": 15647,
    "accuracyRate": 0.94,
    "lastUpdated": "2024-01-15T10:30:00Z"
  }
}
```

### Analytics & Monitoring

#### Get System Metrics
```http
GET /v1/metrics
```

**Response**:
```json
{
  "system": {
    "uptime": 86400,
    "version": "1.0.0",
    "requestsPerMinute": 150,
    "averageResponseTime": 1250,
    "errorRate": 0.001
  },
  "layers": {
    "transport": {
      "cacheHitRate": 0.87,
      "avgFetchTime": 800
    },
    "semantic": {
      "entitiesExtracted": 15234,
      "avgConfidence": 0.85
    },
    "agents": {
      "activeTasks": 12,
      "completedToday": 456
    }
  }
}
```

#### Get Usage Statistics
```http
GET /v1/usage?period=7d
```

**Response**:
```json
{
  "period": "7d",
  "requests": {
    "total": 10500,
    "byEndpoint": {
      "/v1/content/fetch": 6200,
      "/v1/research/query": 2800,
      "/v1/knowledge/query": 1500
    }
  },
  "tokens": {
    "consumed": 2500000,
    "remaining": 7500000
  },
  "agents": {
    "tasksCompleted": 2800,
    "avgProcessingTime": 18500
  }
}
```

---

## WebSocket API

### Connection

```javascript
const ws = new WebSocket('wss://api.anno.ai/v1/ws');

// Authentication
ws.send(JSON.stringify({
  type: 'auth',
  payload: {
    apiKey: 'your_api_key'
  }
}));
```

### Real-time Research

**Start Research Session**:
```json
{
  "type": "research_start",
  "payload": {
    "sessionId": "session_abc123",
    "question": "Analyze the impact of AI on healthcare",
    "options": {
      "depth": "comprehensive",
      "realTimeUpdates": true
    }
  }
}
```

**Receive Progress Updates**:
```json
{
  "type": "research_progress",
  "payload": {
    "sessionId": "session_abc123",
    "progress": 0.4,
    "currentAgent": "academic-research-agent",
    "status": "Found 15 relevant papers, analyzing citations..."
  }
}
```

**Receive Partial Results**:
```json
{
  "type": "research_partial",
  "payload": {
    "sessionId": "session_abc123",
    "findings": [
      {
        "claim": "AI diagnostics show 95% accuracy in radiology",
        "confidence": 0.91,
        "source": "Nature Medicine 2023"
      }
    ]
  }
}
```

### Live Knowledge Graph Updates

**Subscribe to Entity Updates**:
```json
{
  "type": "subscribe_entity",
  "payload": {
    "entityId": "entity_123",
    "includeRelated": true
  }
}
```

**Receive Entity Changes**:
```json
{
  "type": "entity_updated",
  "payload": {
    "entityId": "entity_123",
    "changes": {
      "properties": {
        "revenue": {
          "old": "$100B",
          "new": "$120B",
          "source": "earnings-report-q4-2023"
        }
      }
    }
  }
}
```

---

## Client SDKs

### JavaScript/TypeScript SDK

**Installation**:
```bash
npm install @anno/client
```

**Usage**:
```typescript
import { AnnoClient } from '@anno/client';

const client = new AnnoClient({
  apiKey: 'your_api_key',
  endpoint: 'https://api.anno.ai/v1'
});

// Fetch and process content
const result = await client.content.fetch({
  url: 'https://example.com/article',
  distillContent: true
});

// Conduct research
const research = await client.research.query({
  question: 'What are the latest developments in quantum computing?',
  depth: 'comprehensive'
});

// Query knowledge graph
const knowledge = await client.knowledge.query({
  type: 'cypher',
  statement: 'MATCH (e:Entity) WHERE e.name CONTAINS $term RETURN e LIMIT 10',
  parameters: { term: 'Tesla' }
});
```

### Python SDK

**Installation**:
```bash
pip install anno-client
```

**Usage**:
```python
from anno import AnnoClient

client = AnnoClient(
    api_key="your_api_key",
    endpoint="https://api.anno.ai/v1"
)

# Fetch content
result = client.content.fetch(
    url="https://example.com/article",
    distill_content=True
)

# Conduct research with streaming
research_stream = client.research.query_stream(
    question="What are the latest developments in quantum computing?",
    depth="comprehensive"
)

for update in research_stream:
    if update.type == "progress":
        print(f"Progress: {update.progress * 100:.1f}%")
    elif update.type == "result":
        print(f"Answer: {update.answer}")

# Multi-agent research
agents = client.agents.list()
research_result = client.research.multi_agent_query(
    question="Compare renewable energy policies across countries",
    agents=["academic-research-agent", "news-analysis-agent"],
    verification_level="enhanced"
)
```

### Go SDK

**Installation**:
```bash
go get github.com/anno/anno-go
```

**Usage**:
```go
package main

import (
    "context"
    "github.com/anno/anno-go"
)

func main() {
    client := anno.NewClient(anno.Config{
        APIKey:   "your_api_key",
        Endpoint: "https://api.anno.ai/v1",
    })

    // Fetch content
    result, err := client.Content.Fetch(context.Background(), &anno.FetchRequest{
        URL: "https://example.com/article",
        Options: &anno.FetchOptions{
            DistillContent: true,
            Timeout:        30000,
        },
    })

    // Research query
    research, err := client.Research.Query(context.Background(), &anno.ResearchRequest{
        Question: "What are the latest developments in quantum computing?",
        Options: &anno.ResearchOptions{
            Depth:     "comprehensive",
            MaxSources: 20,
        },
    })
}
```

---

## Error Handling

### HTTP Status Codes

- `200 OK` - Successful request
- `201 Created` - Resource created successfully
- `400 Bad Request` - Invalid request parameters
- `401 Unauthorized` - Invalid or missing API key
- `403 Forbidden` - Insufficient permissions
- `404 Not Found` - Resource not found
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Server error
- `503 Service Unavailable` - Service temporarily unavailable

### Error Response Format

```json
{
  "error": {
    "code": "INVALID_URL",
    "message": "The provided URL is not accessible",
    "details": {
      "url": "https://invalid-url.com",
      "reason": "DNS resolution failed"
    },
    "timestamp": "2024-01-15T10:30:00Z",
    "requestId": "req_abc123"
  }
}
```

### Common Error Codes

```yaml
Authentication Errors:
  - INVALID_API_KEY: API key is invalid or expired
  - INSUFFICIENT_PERMISSIONS: API key lacks required permissions
  - RATE_LIMIT_EXCEEDED: Request rate limit exceeded

Request Errors:
  - INVALID_URL: URL format is invalid or unreachable
  - INVALID_PARAMETERS: Request parameters are invalid
  - CONTENT_TOO_LARGE: Content exceeds size limits
  - UNSUPPORTED_CONTENT_TYPE: Content type not supported

Processing Errors:
  - EXTRACTION_FAILED: Content extraction failed
  - AGENT_UNAVAILABLE: Required agent is not available
  - KNOWLEDGE_GRAPH_ERROR: Knowledge graph operation failed
  - TIMEOUT: Request processing timeout

System Errors:
  - INTERNAL_ERROR: Internal server error
  - SERVICE_UNAVAILABLE: Service temporarily unavailable
  - MAINTENANCE_MODE: System under maintenance
```

---

## Rate Limiting

### Rate Limits by Plan

```yaml
Free Plan:
  - Requests per minute: 60
  - Requests per day: 1,000
  - Concurrent requests: 5

Starter Plan:
  - Requests per minute: 300
  - Requests per day: 10,000
  - Concurrent requests: 20

Professional Plan:
  - Requests per minute: 1,200
  - Requests per day: 100,000
  - Concurrent requests: 100

Enterprise Plan:
  - Custom limits
  - Dedicated infrastructure
  - SLA guarantees
```

### Rate Limit Headers

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1640995200
X-RateLimit-Retry-After: 15
```

### Handling Rate Limits

```javascript
// Automatic retry with exponential backoff
const client = new AnnoClient({
  apiKey: 'your_api_key',
  retryPolicy: {
    maxRetries: 3,
    backoffMultiplier: 2,
    initialDelay: 1000
  }
});

// Manual retry logic
try {
  const result = await client.content.fetch({ url: 'https://example.com' });
} catch (error) {
  if (error.code === 'RATE_LIMIT_EXCEEDED') {
    const retryAfter = error.headers['x-ratelimit-retry-after'];
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    // Retry request
  }
}
```

---

## API Versioning

### Version Strategy

- **Major Version**: Breaking changes (v1 → v2)
- **Minor Version**: New features, backwards compatible
- **Patch Version**: Bug fixes, no API changes

### Version Headers

```http
Accept: application/json; version=1.2
API-Version: 1.2
```

### Deprecation Process

1. **Announcement**: 90 days notice via email and API headers
2. **Warning Headers**: Deprecation warnings in responses
3. **Documentation**: Update docs with migration guide
4. **Grace Period**: 6 months overlap between versions

### Migration Example

```javascript
// Old API (v1.0)
const result = await client.content.fetch({
  url: 'https://example.com',
  extractEntities: true
});

// New API (v1.2)
const result = await client.content.fetch({
  url: 'https://example.com',
  options: {
    extraction: {
      entities: true,
      relationships: true
    }
  }
});
```

---

## Examples

### Complete Research Workflow

```javascript
import { AnnoClient } from '@anno/client';

async function researchWorkflow() {
  const client = new AnnoClient({
    apiKey: 'your_api_key'
  });

  // 1. Start multi-agent research
  const researchRequest = await client.research.query({
    question: 'What is the current state of renewable energy adoption globally?',
    options: {
      depth: 'comprehensive',
      agents: ['academic-research-agent', 'news-analysis-agent'],
      verificationLevel: 'enhanced',
      includeVisualizations: true
    }
  });

  console.log('Research started:', researchRequest.id);

  // 2. Monitor progress via WebSocket
  const ws = client.createWebSocket();

  ws.subscribe('research_progress', (update) => {
    console.log(`Progress: ${update.progress * 100}%`);
    console.log(`Status: ${update.status}`);
  });

  // 3. Get final results
  const results = await client.research.getResults(researchRequest.id);

  console.log('Final answer:', results.answer);
  console.log('Confidence:', results.confidence);
  console.log('Sources:', results.sources.length);

  // 4. Explore related knowledge
  for (const entity of results.entities) {
    const related = await client.knowledge.query({
      type: 'cypher',
      statement: `
        MATCH (e:Entity {id: $entityId})-[r]-(related)
        WHERE r.confidence > 0.8
        RETURN related.name, r.type, r.confidence
        ORDER BY r.confidence DESC
        LIMIT 5
      `,
      parameters: { entityId: entity.id }
    });

    console.log(`Related to ${entity.name}:`, related.results);
  }

  // 5. Save to personal knowledge base
  await client.knowledge.createCollection({
    name: 'Renewable Energy Research',
    description: 'Research findings on global renewable energy adoption',
    entities: results.entities,
    relationships: results.relationships,
    sources: results.sources
  });
}

researchWorkflow();
```

### Streaming Content Analysis

```python
import asyncio
from anno import AnnoClient

async def analyze_news_stream():
    client = AnnoClient(api_key="your_api_key")

    # URLs to analyze
    news_urls = [
        "https://reuters.com/technology/ai-breakthrough-2024",
        "https://bbc.com/news/technology-12345",
        "https://techcrunch.com/ai-startup-funding"
    ]

    # Process URLs concurrently with streaming
    async def process_url(url):
        async for event in client.content.stream_process(url):
            if event.type == "entity":
                print(f"Found entity: {event.text} ({event.type})")
            elif event.type == "relationship":
                print(f"Relationship: {event.subject} → {event.predicate} → {event.object}")
            elif event.type == "done":
                print(f"Completed processing {url}")
                return event.summary

    # Run all processing tasks
    tasks = [process_url(url) for url in news_urls]
    summaries = await asyncio.gather(*tasks)

    # Aggregate findings
    all_entities = []
    all_relationships = []

    for summary in summaries:
        all_entities.extend(summary.entities)
        all_relationships.extend(summary.relationships)

    # Find common themes
    themes = await client.analysis.find_themes(
        entities=all_entities,
        relationships=all_relationships
    )

    print("Common themes across articles:")
    for theme in themes:
        print(f"- {theme.name}: {theme.frequency} mentions")

# Run the analysis
asyncio.run(analyze_news_stream())
```

### Custom Agent Development

```typescript
import { AnnoClient, AgentBuilder } from '@anno/client';

// Create custom financial analysis agent
const financialAgent = new AgentBuilder()
  .setName('Financial Analysis Agent')
  .setSpecialization(['bloomberg.com', 'reuters.com/business', 'sec.gov'])
  .addSkill('earnings_analysis', {
    description: 'Analyze quarterly earnings reports',
    confidenceThreshold: 0.85
  })
  .addSkill('market_trend_analysis', {
    description: 'Identify market trends and patterns',
    confidenceThreshold: 0.80
  })
  .setProcessingLogic(async (task, context) => {
    // Custom processing logic
    const financialData = await extractFinancialMetrics(task.content);
    const trends = await analyzeMarketTrends(financialData);
    const insights = await generateInsights(trends);

    return {
      data: insights,
      confidence: calculateConfidence(insights),
      metadata: {
        metricsExtracted: financialData.length,
        trendsIdentified: trends.length
      }
    };
  })
  .build();

// Register agent with Anno
const client = new AnnoClient({ apiKey: 'your_api_key' });
await client.agents.register(financialAgent);

// Use custom agent
const analysis = await client.research.query({
  question: 'Analyze Tesla\'s Q4 2023 financial performance',
  agents: ['financial-analysis-agent'],
  depth: 'comprehensive'
});

console.log('Financial analysis:', analysis.answer);
```

This API documentation provides comprehensive coverage of Anno's capabilities while maintaining clarity and usability for developers integrating with the system.