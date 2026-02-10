const API_BASE = process.env.NEUROSURF_API ?? 'http://localhost:5213';

interface UrlDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

const documents: UrlDocument[] = [
  {
    id: 'whitepaper-1',
    text: 'Agent automation whitepaper describes coordination strategies for multi-agent research.',
    metadata: { url: 'https://docs.example.com/automation-whitepaper' }
  },
  {
    id: 'guide-1',
    text: 'Step-by-step guide outlines how to fine-tune LLMs for tool usage.',
    metadata: { url: 'https://docs.example.com/tooling-guide' }
  }
];

const queries = [
  'How do we orchestrate multiple AI agents?',
  'What is the process for fine-tuning tool usage?'
];

async function main() {
  await indexDocuments(documents);
  for (const query of queries) {
    const response = await ragQuery(query, 'batch-session');
    console.log(`\n=== Query: ${query} ===`);
    console.log(response.answer);
  }
}

async function indexDocuments(docs: UrlDocument[]) {
  const res = await fetch(`${API_BASE}/v1/semantic/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents: docs })
  });
  if (!res.ok) {
    throw new Error(`Indexing failed: ${res.status}`);
  }
}

async function ragQuery(query: string, sessionId: string) {
  const res = await fetch(`${API_BASE}/v1/semantic/rag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, sessionId, k: 2, summaryLevels: ['headline'] })
  });
  if (!res.ok) {
    throw new Error(`RAG request failed: ${res.status}`);
  }
  return res.json();
}

void main().catch((error) => {
  console.error('batch-rag demo failed', error);
  process.exit(1);
});
