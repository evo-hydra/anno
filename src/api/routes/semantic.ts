import { Router } from 'express';
import { z } from 'zod';
import { getSemanticServices } from '../../services/semantic-services';
import { queryCache } from '../../services/query-cache';
import { asyncHandler } from '../../middleware/error-handler';

const router = Router();

const indexRequestSchema = z.object({
  documents: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().min(1),
        content: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional()
      })
    )
    .min(1)
});

const searchRequestSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
  minScore: z.number().optional(),
  filter: z.record(z.string(), z.unknown()).optional()
});

const ragRequestSchema = z.object({
  query: z.string().min(1),
  sessionId: z.string().optional(),
  k: z.number().int().min(1).max(10).optional(),
  minScore: z.number().optional(),
  summaryLevels: z.array(z.enum(['headline', 'paragraph', 'detailed'])).optional(),
  skipCache: z.boolean().optional()
});

router.post('/index', asyncHandler(async (req, res) => {
  const { documents } = indexRequestSchema.parse(req.body);
  const { searchService } = getSemanticServices();
  await searchService.indexDocuments(documents);
  res.status(202).json({ status: 'indexed', count: documents.length });
}));

router.post('/search', asyncHandler(async (req, res) => {
  const { query, k, filter, minScore } = searchRequestSchema.parse(req.body);
  const { searchService } = getSemanticServices();
  const results = await searchService.search(query, { k, filter, minScore });
  res.json({ results });
}));

router.post('/rag', asyncHandler(async (req, res) => {
  const { query, sessionId, k, summaryLevels, minScore, skipCache } = ragRequestSchema.parse(req.body);
  const { ragPipeline } = getSemanticServices();

  // Use query cache for RAG responses
  const { result, cached } = await queryCache.getOrCompute(
    query,
    () => ragPipeline.run({ query, sessionId, topK: k, summaryLevels, minScore }),
    { k, summaryLevels, minScore },
    { skipCache, ttl: 3600, prefix: 'rag:' } // 1 hour TTL for RAG results
  );

  res.json({ ...result, _cached: cached });
}));

export const semanticRouter = router;
