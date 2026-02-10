const API_BASE = process.env.NEUROSURF_API ?? 'http://localhost:5213';

async function main() {
  await seedNewsArticles();
  const rag = await callRag('How are major AI labs positioning themselves?', 'news-session');
  console.log('\n=== RAG Answer ===');
  console.log(rag.answer);
  console.log('\n=== Citations ===');
  for (const citation of rag.citations) {
    console.log(`- ${citation.id} (${citation.score.toFixed(2)}) ${citation.url ?? ''}`);
  }
}

async function seedNewsArticles() {
  const documents = [
    {
      id: 'news-openai',
      text: 'OpenAI announced a new multi-modal assistant capable of grounding responses in retrieved documents.',
      metadata: { url: 'https://news.example.com/openai' }
    },
    {
      id: 'news-anthropic',
      text: 'Anthropic is focusing on responsible scaling policies for Claude models with emphasis on safety.',
      metadata: { url: 'https://news.example.com/anthropic' }
    },
    {
      id: 'news-google',
      text: 'Google DeepMind introduced Gemini updates improving coding and reasoning for enterprise developers.',
      metadata: { url: 'https://news.example.com/google' }
    }
  ];

  const res = await fetch(`${API_BASE}/v1/semantic/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents })
  });
  if (!res.ok) {
    throw new Error(`Indexing failed: ${res.status}`);
  }
}

async function callRag(query: string, sessionId: string) {
  const res = await fetch(`${API_BASE}/v1/semantic/rag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, sessionId, k: 3, summaryLevels: ['headline', 'paragraph'] })
  });
  if (!res.ok) {
    throw new Error(`RAG request failed: ${res.status}`);
  }
  return res.json();
}

void main().catch((error) => {
  console.error('news-insight demo failed', error);
  process.exit(1);
});
