import { Router } from 'express';
import { z } from 'zod';
import { getSemanticServices } from '../../services/semantic-services';

const router = Router();

const appendSchema = z.object({
  content: z.string().min(1),
  type: z.enum(['note', 'context', 'summary']).default('note'),
  metadata: z.record(z.string(), z.unknown()).optional()
});

router.get('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { memoryStore } = getSemanticServices();
  const session = await memoryStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(session);
});

router.post('/:sessionId/entries', async (req, res) => {
  const { sessionId } = req.params;
  const parse = appendSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid_request', details: parse.error.flatten() });
    return;
  }

  const { memoryStore } = getSemanticServices();
  await memoryStore.addEntry({
    sessionId,
    type: parse.data.type,
    content: parse.data.content,
    metadata: parse.data.metadata,
    createdAt: Date.now()
  });

  res.status(202).json({ status: 'queued' });
});

router.delete('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { memoryStore } = getSemanticServices();
  await memoryStore.clearSession(sessionId);
  res.status(204).send();
});

export const memoryRouter = router;
