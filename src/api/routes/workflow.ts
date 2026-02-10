/**
 * Workflow API Routes
 *
 * Exposes the WorkflowEngine through REST endpoints for executing,
 * validating, and parsing multi-step browser workflows.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { workflowEngine } from '../../services/workflow-engine';
import { asyncHandler } from '../../middleware/error-handler';
import { logger } from '../../utils/logger';

const router = Router();

// ---------------------------------------------------------------------------
// Request timeout for workflow endpoints (120s — workflows can be long)
// ---------------------------------------------------------------------------

const WORKFLOW_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const workflowStepSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      id: z.string().optional(),
      type: z.literal('fetch'),
      url: z.string(),
    }),
    z.object({
      id: z.string().optional(),
      type: z.literal('interact'),
      actions: z.array(z.object({
        type: z.string(),
        selector: z.string().optional(),
        value: z.string().optional(),
        values: z.array(z.string()).optional(),
        direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
        condition: z.object({
          kind: z.enum(['selector', 'timeout', 'networkidle', 'expression']),
          selector: z.string().optional(),
          ms: z.number().optional(),
          expression: z.string().optional(),
        }).optional(),
        expression: z.string().optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      })).min(1),
    }),
    z.object({
      id: z.string().optional(),
      type: z.literal('extract'),
      policy: z.string().optional(),
      saveAs: z.string().optional(),
    }),
    z.object({
      id: z.string().optional(),
      type: z.literal('wait'),
      condition: z.enum(['networkidle', 'timeout', 'selector']),
      value: z.union([z.string(), z.number()]).optional(),
    }),
    z.object({
      id: z.string().optional(),
      type: z.literal('screenshot'),
      saveAs: z.string().optional(),
      fullPage: z.boolean().optional(),
    }),
    z.object({
      id: z.string().optional(),
      type: z.literal('setVariable'),
      name: z.string(),
      value: z.string().optional(),
      fromEval: z.string().optional(),
      fromSelector: z.string().optional(),
    }),
    z.object({
      id: z.string().optional(),
      type: z.literal('if'),
      condition: z.string(),
      then: z.array(z.lazy(() => workflowStepSchema)).min(1),
      else: z.array(z.lazy(() => workflowStepSchema)).optional(),
    }),
    z.object({
      id: z.string().optional(),
      type: z.literal('loop'),
      over: z.string().optional(),
      times: z.number().optional(),
      maxIterations: z.number().optional(),
      steps: z.array(z.lazy(() => workflowStepSchema)).min(1),
      breakIf: z.string().optional(),
    }),
  ])
);

const workflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  options: z.object({
    timeout: z.number().positive().optional(),
    continueOnError: z.boolean().optional(),
    sessionTtl: z.number().positive().optional(),
  }).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  steps: z.array(workflowStepSchema).min(1),
});

const executeRequestSchema = z.object({
  workflow: workflowDefinitionSchema,
});

const validateRequestSchema = z.object({
  workflow: workflowDefinitionSchema,
});

const parseRequestSchema = z.object({
  yaml: z.string().min(1),
});

// ---------------------------------------------------------------------------
// POST / — Execute a workflow
// ---------------------------------------------------------------------------

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = executeRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request validation failed',
      details: parseResult.error.flatten(),
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  const { workflow } = parseResult.data;

  logger.info('workflow: execute request received', {
    name: workflow.name,
    stepCount: workflow.steps.length,
    hasVariables: !!workflow.variables,
  });

  const overallStart = Date.now();

  // Set a request-level timeout
  req.setTimeout(WORKFLOW_TIMEOUT_MS);

  const result = await workflowEngine.execute(workflow);

  logger.info('workflow: execute request completed', {
    name: workflow.name,
    status: result.status,
    totalDuration: result.totalDuration,
    stepsCompleted: result.steps.length,
    extractionCount: result.extractions.length,
    screenshotCount: result.screenshots.length,
  });

  res.json({
    success: result.status === 'completed',
    result,
  });
}));

// ---------------------------------------------------------------------------
// POST /validate — Validate a workflow without executing
// ---------------------------------------------------------------------------

router.post('/validate', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = validateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request validation failed',
      details: parseResult.error.flatten(),
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  const { workflow } = parseResult.data;

  logger.info('workflow: validate request received', {
    name: workflow.name,
    stepCount: workflow.steps.length,
  });

  const validation = workflowEngine.validate(workflow);

  logger.info('workflow: validate request completed', {
    name: workflow.name,
    valid: validation.valid,
    errorCount: validation.errors.length,
  });

  res.json({
    valid: validation.valid,
    errors: validation.errors,
  });
}));

// ---------------------------------------------------------------------------
// POST /parse — Parse YAML into a WorkflowDefinition
// ---------------------------------------------------------------------------

router.post('/parse', asyncHandler(async (req: Request, res: Response) => {
  const parseResult = parseRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request validation failed',
      details: parseResult.error.flatten(),
      timestamp: Date.now(),
      path: req.path,
    });
    return;
  }

  const { yaml: yamlString } = parseResult.data;

  logger.info('workflow: parse request received', {
    yamlLength: yamlString.length,
  });

  const workflow = workflowEngine.parseYaml(yamlString);

  logger.info('workflow: parse request completed', {
    name: workflow.name,
    stepCount: workflow.steps?.length ?? 0,
  });

  res.json({
    workflow,
  });
}));

export const workflowRouter = router;
