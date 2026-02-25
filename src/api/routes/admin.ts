/**
 * Admin API Routes — Key Provisioning
 *
 * Protected by ANNO_ADMIN_KEY. Used by the website to auto-provision
 * API keys on signup and Stripe checkout.
 *
 * POST /admin/keys     — Provision a new key
 * DELETE /admin/keys    — Revoke a key
 * GET /admin/keys       — List all provisioned keys
 *
 * @module api/routes/admin
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../config/env';
import { getKeyStore } from '../../services/key-store';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * Admin auth guard. Checks ANNO_ADMIN_KEY from Authorization header.
 */
function requireAdmin(req: Request, res: Response): boolean {
  const adminKey = config.auth.adminKey;
  if (!adminKey) {
    res.status(503).json({ error: 'Admin API not configured' });
    return false;
  }

  const authHeader = req.get('authorization');
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

  if (provided !== adminKey) {
    res.status(401).json({ error: 'Invalid admin key' });
    return false;
  }

  return true;
}

const provisionSchema = z.object({
  keyHash: z.string().regex(/^[a-f0-9]{64}$/, 'Must be a SHA-256 hex hash'),
  tier: z.enum(['free', 'pro', 'business']),
  email: z.string().email().optional(),
});

/**
 * POST /admin/keys — Provision a new API key
 */
router.post('/keys', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const { keyHash, tier, email } = provisionSchema.parse(req.body);
    const store = getKeyStore();

    if (!store.isReady()) {
      res.status(503).json({ error: 'Key store unavailable' });
      return;
    }

    const success = await store.provision(keyHash, tier, email);
    if (success) {
      logger.info('Admin: Key provisioned', { keyHash: keyHash.slice(0, 8) + '...', tier, email });
      res.status(201).json({ status: 'provisioned', tier });
    } else {
      res.status(500).json({ error: 'Failed to provision key' });
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.flatten() });
    } else {
      res.status(500).json({ error: 'Internal error' });
    }
  }
});

/**
 * DELETE /admin/keys — Revoke an API key
 */
router.delete('/keys', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { keyHash } = req.body || {};
  if (!keyHash || typeof keyHash !== 'string') {
    res.status(400).json({ error: 'keyHash required' });
    return;
  }

  const store = getKeyStore();
  const success = await store.revoke(keyHash);
  if (success) {
    logger.info('Admin: Key revoked', { keyHash: keyHash.slice(0, 8) + '...' });
    res.json({ status: 'revoked' });
  } else {
    res.status(404).json({ error: 'Key not found or store unavailable' });
  }
});

/**
 * GET /admin/keys — List all provisioned keys
 */
router.get('/keys', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const store = getKeyStore();
  const keys = await store.listKeys();
  res.json({ keys, count: keys.length });
});

export const adminRouter = router;
