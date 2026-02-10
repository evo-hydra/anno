#!/usr/bin/env tsx
import { ValidationRunner, TEST_URLS } from './comprehensive-validation';

async function main() {
  const runner = new ValidationRunner();
  const subset = TEST_URLS.slice(0, 15);
  const results = [] as Awaited<ReturnType<typeof runner.runSingleTest>>[];

  for (let i = 0; i < subset.length; i++) {
    let r = await runner.runSingleTest(subset[i], 1);
    if (!r) {
      // Simple retry/backoff for flaky URLs
      await new Promise(res => setTimeout(res, 1000));
      r = await runner.runSingleTest(subset[i], 1);
    }
    if (r) results.push(r);
    await new Promise(res => setTimeout(res, 500));
  }

  const valid = results.filter(r => r && !isNaN(r.reduction.tokenPercent)) as NonNullable<typeof results[number]>[];
  const avgReduction = valid.length ? valid.reduce((a, b) => a + b.reduction.tokenPercent, 0) / valid.length : 0;

  const byCategory: Record<string, number[]> = {};
  valid.forEach(v => {
    (byCategory[v.category] ||= []).push(v.reduction.tokenPercent);
  });

  const byCatSummary = Object.fromEntries(
    Object.entries(byCategory).map(([k, arr]) => [k, Math.round((arr.reduce((a,b)=>a+b,0)/arr.length) * 10)/10])
  );

  console.log(JSON.stringify({ count: valid.length, avgReduction: Math.round(avgReduction*10)/10, byCategory: byCatSummary }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });


