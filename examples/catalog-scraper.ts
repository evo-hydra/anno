const API_BASE = process.env.NEUROSURF_API ?? 'http://localhost:5213';

async function main() {
  await seedCatalog();
  const results = await search('wireless headphones with noise cancellation');
  console.log('\n=== Similar Products ===');
  for (const item of results) {
    console.log(`- ${item.metadata?.sku ?? item.id}: score=${item.score.toFixed(2)} price=${item.metadata?.price}`);
  }
}

async function seedCatalog() {
  const documents = [
    {
      id: 'sku-1001',
      text: 'Aurora Headphones Pro feature adaptive noise cancellation and 30-hour battery life.',
      metadata: { sku: 'AUR-HP-PRO', price: '$299', url: 'https://shop.example.com/aurora-pro' }
    },
    {
      id: 'sku-1002',
      text: 'Aurora Earbuds Lite offer active noise reduction and wireless charging.',
      metadata: { sku: 'AUR-EB-LITE', price: '$149', url: 'https://shop.example.com/aurora-lite' }
    },
    {
      id: 'sku-2001',
      text: 'Nimbus Speaker delivers spatial audio for home theaters with Wi-Fi streaming.',
      metadata: { sku: 'NIM-SPK', price: '$399', url: 'https://shop.example.com/nimbus-speaker' }
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

async function search(query: string) {
  const res = await fetch(`${API_BASE}/v1/semantic/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, k: 2 })
  });
  if (!res.ok) {
    throw new Error(`Search failed: ${res.status}`);
  }
  const payload = await res.json();
  return payload.results as Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
}

void main().catch((error) => {
  console.error('catalog-scraper demo failed', error);
  process.exit(1);
});
