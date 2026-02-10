const API_BASE = process.env.NEUROSURF_API ?? 'http://localhost:5213';

async function main() {
  await seedSalesData();
  const results = await search('vintage camera price history');
  console.log('\n=== FlipIQ Pricing Insights ===');
  results.forEach((item) => {
    console.log(`- ${item.metadata?.listingId ?? item.id} sold for ${item.metadata?.price} on ${item.metadata?.soldDate}`);
  });
}

async function seedSalesData() {
  const documents = [
    {
      id: 'ebay-1',
      text: 'Sold Listing: Canon AE-1 Program camera with 50mm lens sold for $220 on September 10, 2025.',
      metadata: {
        listingId: 'CANON-AE1-123',
        price: '$220',
        soldDate: '2025-09-10',
        url: 'https://ebay.example.com/listing/123'
      }
    },
    {
      id: 'ebay-2',
      text: 'Sold Listing: Canon AE-1 body only sold for $150 on August 22, 2025.',
      metadata: {
        listingId: 'CANON-AE1-456',
        price: '$150',
        soldDate: '2025-08-22',
        url: 'https://ebay.example.com/listing/456'
      }
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
    body: JSON.stringify({ query, k: 3 })
  });
  if (!res.ok) {
    throw new Error(`Search failed: ${res.status}`);
  }
  const payload = await res.json();
  return payload.results as Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
}

void main().catch((error) => {
  console.error('flipiQ pricing demo failed', error);
  process.exit(1);
});
