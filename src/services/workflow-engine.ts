/**
 * WorkflowEngine - Multi-step workflow orchestration for Anno
 *
 * Chains multiple steps (fetch, interact, wait, extract, screenshot, etc.)
 * into reusable, repeatable workflows defined in YAML or JSON.
 *
 * Integrates with:
 * - SessionManager for persistent browser sessions
 * - InteractionManager for browser actions
 * - Distiller for content extraction
 *
 * @module services/workflow-engine
 */

import type { Page } from 'playwright-core';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger';
import { getSessionManager } from './session-manager';
import {
  InteractionManager,
  type BrowserAction,
  type ScreenshotOptions,
} from './interaction-manager';
import { distillContent } from './distiller';

// ---------------------------------------------------------------------------
// Types — Workflow Definition
// ---------------------------------------------------------------------------

export interface WorkflowDefinition {
  name: string;
  description?: string;
  options?: {
    /** Overall workflow timeout in milliseconds. Default 120000. */
    timeout?: number;
    /** Keep going after step failure. Default false. */
    continueOnError?: boolean;
    /** Session TTL in seconds. Default 1800. */
    sessionTtl?: number;
  };
  /** Initial variables for {{interpolation}}. */
  variables?: Record<string, string>;
  steps: WorkflowStep[];
}

export type WorkflowStep =
  | FetchStep
  | InteractStep
  | ExtractStep
  | WaitStep
  | ScreenshotStep
  | SetVariableStep
  | ConditionalStep
  | LoopStep;

export interface FetchStep {
  id?: string;
  type: 'fetch';
  /** URL to navigate to. Supports {{variable}} interpolation. */
  url: string;
}

export interface InteractStep {
  id?: string;
  type: 'interact';
  actions: BrowserAction[];
}

export interface ExtractStep {
  id?: string;
  type: 'extract';
  /** Extraction policy name passed to distiller. Default 'default'. */
  policy?: string;
  /** Variable name to store extracted content. */
  saveAs?: string;
}

export interface WaitStep {
  id?: string;
  type: 'wait';
  condition: 'networkidle' | 'timeout' | 'selector';
  /** Selector string or timeout in ms. */
  value?: string | number;
}

export interface ScreenshotStep {
  id?: string;
  type: 'screenshot';
  /** Variable name for base64 data. */
  saveAs?: string;
  fullPage?: boolean;
}

export interface SetVariableStep {
  id?: string;
  type: 'setVariable';
  name: string;
  /** Literal value or {{expression}}. */
  value?: string;
  /** JS expression to evaluate in page context. */
  fromEval?: string;
  /** CSS selector to extract text content from. */
  fromSelector?: string;
}

export interface ConditionalStep {
  id?: string;
  type: 'if';
  /** JS expression evaluated against variables context. */
  condition: string;
  then: WorkflowStep[];
  else?: WorkflowStep[];
}

export interface LoopStep {
  id?: string;
  type: 'loop';
  /** Variable name containing array to iterate. */
  over?: string;
  /** Repeat N times. */
  times?: number;
  /** Safety limit. Default 50. */
  maxIterations?: number;
  steps: WorkflowStep[];
  /** JS expression — break loop if true. */
  breakIf?: string;
}

// ---------------------------------------------------------------------------
// Types — Workflow Result
// ---------------------------------------------------------------------------

export interface WorkflowResult {
  name: string;
  status: 'completed' | 'failed' | 'timeout';
  steps: StepResult[];
  /** Final variable state. */
  variables: Record<string, unknown>;
  extractions: Array<{ stepId: string; content: string; policy: string }>;
  screenshots: Array<{ stepId: string; data: string }>;
  totalDuration: number;
  error?: string;
}

export interface StepResult {
  id: string;
  type: string;
  status: 'success' | 'failed' | 'skipped';
  duration: number;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Types — Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_SESSION_TTL = 1800;
const DEFAULT_MAX_LOOP_ITERATIONS = 50;

const VALID_STEP_TYPES = new Set([
  'fetch',
  'interact',
  'extract',
  'wait',
  'screenshot',
  'setVariable',
  'if',
  'loop',
]);

const VALID_WAIT_CONDITIONS = new Set(['networkidle', 'timeout', 'selector']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace all {{variableName}} occurrences with their values from the context. */
function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = variables[key];
    if (val === undefined || val === null) {
      return '';
    }
    return String(val);
  });
}

/** Evaluate a JS expression with a variables context, returning a value. */
function evaluateCondition(expression: string, variables: Record<string, unknown>): unknown {
  // Build a function that receives variables as named arguments
  const keys = Object.keys(variables);
  const values = keys.map((k) => variables[k]);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `return (${expression});`);
  return fn(...values);
}

/** Auto-generate a step ID from type and index when not provided. */
let stepCounter = 0;
function resolveStepId(step: WorkflowStep): string {
  if (step.id) {
    return step.id;
  }
  stepCounter += 1;
  return `${step.type}_${stepCounter}`;
}

/** Reset the global step counter. Called at the start of each workflow. */
function resetStepCounter(): void {
  stepCounter = 0;
}

// ---------------------------------------------------------------------------
// WorkflowEngine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private readonly interactionManager = new InteractionManager();

  /**
   * Execute a workflow definition.
   * Creates a session, navigates through steps, returns results.
   */
  async execute(workflow: WorkflowDefinition): Promise<WorkflowResult> {
    resetStepCounter();

    const startTime = Date.now();
    const timeout = workflow.options?.timeout ?? DEFAULT_TIMEOUT;
    const continueOnError = workflow.options?.continueOnError ?? false;
    const sessionTtl = workflow.options?.sessionTtl ?? DEFAULT_SESSION_TTL;

    // Mutable state accumulated over the course of execution
    const variables: Record<string, unknown> = { ...(workflow.variables ?? {}) };
    const allStepResults: StepResult[] = [];
    const extractions: WorkflowResult['extractions'] = [];
    const screenshots: WorkflowResult['screenshots'] = [];

    let finalStatus: WorkflowResult['status'] = 'completed';
    let finalError: string | undefined;

    // Obtain a session and page
    const sessionManager = await getSessionManager();
    const sessionInfo = await sessionManager.createSession({
      name: `workflow:${workflow.name}`,
      ttl: sessionTtl,
    });
    const sessionId = sessionInfo.id;

    logger.info('workflow:execute started', {
      name: workflow.name,
      stepCount: workflow.steps.length,
      timeout,
      sessionId,
    });

    let page: Page;

    try {
      page = await sessionManager.getSessionPage(sessionId);
    } catch (err) {
      await sessionManager.closeSession(sessionId).catch(() => {});
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        name: workflow.name,
        status: 'failed',
        steps: [],
        variables,
        extractions,
        screenshots,
        totalDuration: Date.now() - startTime,
        error: `Failed to obtain session page: ${errMsg}`,
      };
    }

    // Wrap execution in a timeout race
    try {
      await Promise.race([
        this.executeSteps(
          workflow.steps,
          page,
          variables,
          allStepResults,
          extractions,
          screenshots,
          continueOnError
        ),
        this.createTimeoutPromise(timeout),
      ]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === '__workflow_timeout__') {
        finalStatus = 'timeout';
        finalError = `Workflow timed out after ${timeout}ms`;
        logger.warn('workflow:execute timed out', {
          name: workflow.name,
          timeout,
        });
      } else if (errMsg === '__workflow_abort__') {
        finalStatus = 'failed';
        finalError =
          allStepResults.length > 0
            ? allStepResults[allStepResults.length - 1].error
            : errMsg;
      } else {
        finalStatus = 'failed';
        finalError = errMsg;
      }
    } finally {
      // Always close the session
      await sessionManager.closeSession(sessionId).catch((closeErr) => {
        logger.warn('workflow:execute session close failed', {
          sessionId,
          error: closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      });
    }

    const totalDuration = Date.now() - startTime;

    logger.info('workflow:execute finished', {
      name: workflow.name,
      status: finalStatus,
      totalDuration,
      stepsCompleted: allStepResults.length,
      extractionCount: extractions.length,
      screenshotCount: screenshots.length,
    });

    return {
      name: workflow.name,
      status: finalStatus,
      steps: allStepResults,
      variables,
      extractions,
      screenshots,
      totalDuration,
      error: finalError,
    };
  }

  /**
   * Validate a workflow definition without executing.
   * Returns errors if the structure is invalid.
   */
  validate(workflow: WorkflowDefinition): ValidationResult {
    const errors: string[] = [];

    if (!workflow) {
      return { valid: false, errors: ['Workflow definition is null or undefined'] };
    }

    if (!workflow.name || typeof workflow.name !== 'string') {
      errors.push('Workflow must have a non-empty "name" string');
    }

    if (!Array.isArray(workflow.steps)) {
      errors.push('Workflow must have a "steps" array');
      return { valid: false, errors };
    }

    if (workflow.steps.length === 0) {
      errors.push('Workflow must have at least one step');
    }

    if (workflow.options) {
      if (workflow.options.timeout !== undefined && (typeof workflow.options.timeout !== 'number' || workflow.options.timeout <= 0)) {
        errors.push('options.timeout must be a positive number');
      }
      if (workflow.options.sessionTtl !== undefined && (typeof workflow.options.sessionTtl !== 'number' || workflow.options.sessionTtl <= 0)) {
        errors.push('options.sessionTtl must be a positive number');
      }
      if (workflow.options.continueOnError !== undefined && typeof workflow.options.continueOnError !== 'boolean') {
        errors.push('options.continueOnError must be a boolean');
      }
    }

    // Validate each step recursively
    this.validateSteps(workflow.steps, errors, 'steps');

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Parse a YAML string into a WorkflowDefinition.
   */
  parseYaml(yamlString: string): WorkflowDefinition {
    const parsed = yaml.load(yamlString);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('YAML did not parse into a valid object');
    }
    return parsed as WorkflowDefinition;
  }

  // -------------------------------------------------------------------------
  // Private: Step Execution
  // -------------------------------------------------------------------------

  /**
   * Execute an array of steps sequentially, accumulating results.
   * Throws '__workflow_abort__' if a step fails and continueOnError is false.
   */
  private async executeSteps(
    steps: WorkflowStep[],
    page: Page,
    variables: Record<string, unknown>,
    allStepResults: StepResult[],
    extractions: WorkflowResult['extractions'],
    screenshots: WorkflowResult['screenshots'],
    continueOnError: boolean
  ): Promise<void> {
    for (const step of steps) {
      const stepId = resolveStepId(step);
      const stepStart = Date.now();

      let result: StepResult;

      try {
        const data = await this.executeStep(
          step,
          stepId,
          page,
          variables,
          allStepResults,
          extractions,
          screenshots,
          continueOnError
        );

        result = {
          id: stepId,
          type: step.type,
          status: 'success',
          duration: Date.now() - stepStart,
          data,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Propagate internal control-flow errors
        if (errMsg === '__workflow_timeout__' || errMsg === '__workflow_abort__') {
          throw err;
        }

        result = {
          id: stepId,
          type: step.type,
          status: 'failed',
          duration: Date.now() - stepStart,
          error: errMsg,
        };

        logger.warn('workflow:step failed', {
          stepId,
          type: step.type,
          error: errMsg,
        });

        allStepResults.push(result);

        if (!continueOnError) {
          throw new Error('__workflow_abort__');
        }

        continue;
      }

      allStepResults.push(result);

      logger.debug('workflow:step completed', {
        stepId,
        type: step.type,
        duration: result.duration,
      });
    }
  }

  /**
   * Execute a single step. Returns optional data payload.
   */
  private async executeStep(
    step: WorkflowStep,
    stepId: string,
    page: Page,
    variables: Record<string, unknown>,
    allStepResults: StepResult[],
    extractions: WorkflowResult['extractions'],
    screenshots: WorkflowResult['screenshots'],
    continueOnError: boolean
  ): Promise<unknown> {
    switch (step.type) {
      case 'fetch':
        return this.executeFetch(step, page, variables);

      case 'interact':
        return this.executeInteract(step, page, variables);

      case 'extract':
        return this.executeExtract(step, stepId, page, variables, extractions);

      case 'wait':
        return this.executeWait(step, page, variables);

      case 'screenshot':
        return this.executeScreenshot(step, stepId, page, variables, screenshots);

      case 'setVariable':
        return this.executeSetVariable(step, page, variables);

      case 'if':
        return this.executeConditional(
          step,
          page,
          variables,
          allStepResults,
          extractions,
          screenshots,
          continueOnError
        );

      case 'loop':
        return this.executeLoop(
          step,
          page,
          variables,
          allStepResults,
          extractions,
          screenshots,
          continueOnError
        );

      default: {
        const exhaustive: never = step;
        throw new Error(`Unknown step type: ${(exhaustive as WorkflowStep).type}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step implementations
  // -------------------------------------------------------------------------

  private async executeFetch(
    step: FetchStep,
    page: Page,
    variables: Record<string, unknown>
  ): Promise<{ url: string; statusCode: number | null }> {
    const url = interpolate(step.url, variables);
    logger.info('workflow:fetch', { url });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const statusCode = response ? response.status() : null;

    return { url, statusCode };
  }

  private async executeInteract(
    step: InteractStep,
    page: Page,
    variables: Record<string, unknown>
  ): Promise<unknown> {
    // Interpolate string fields within each action
    const interpolatedActions: BrowserAction[] = step.actions.map((action) => {
      const copy = { ...action };
      if (copy.selector) {
        copy.selector = interpolate(copy.selector, variables);
      }
      if (copy.value !== undefined) {
        copy.value = interpolate(copy.value, variables);
      }
      if (copy.expression) {
        copy.expression = interpolate(copy.expression, variables);
      }
      return copy;
    });

    const results = await this.interactionManager.executeActions(
      page,
      interpolatedActions
    );

    // If any action failed, report the first failure
    const firstFailure = results.find((r) => !r.success);
    if (firstFailure) {
      throw new Error(
        `Interaction action "${firstFailure.action.type}" failed: ${firstFailure.error}`
      );
    }

    return results.map((r) => ({
      type: r.action.type,
      success: r.success,
      duration: r.duration,
      data: r.data,
    }));
  }

  private async executeExtract(
    step: ExtractStep,
    stepId: string,
    page: Page,
    variables: Record<string, unknown>,
    extractions: WorkflowResult['extractions']
  ): Promise<unknown> {
    const policy = step.policy ?? 'default';
    const html = await page.content();
    const url = page.url();

    const distilled = await distillContent(html, url, policy);

    extractions.push({
      stepId,
      content: distilled.contentText,
      policy,
    });

    if (step.saveAs) {
      variables[step.saveAs] = distilled.contentText;
    }

    return {
      title: distilled.title,
      contentLength: distilled.contentLength,
      method: distilled.extractionMethod,
      confidence: distilled.extractionConfidence,
    };
  }

  private async executeWait(
    step: WaitStep,
    page: Page,
    variables: Record<string, unknown>
  ): Promise<void> {
    switch (step.condition) {
      case 'networkidle':
        await page.waitForLoadState('networkidle');
        break;

      case 'timeout': {
        const ms =
          typeof step.value === 'number'
            ? step.value
            : parseInt(String(step.value ?? '1000'), 10);
        await page.waitForTimeout(ms);
        break;
      }

      case 'selector': {
        const selector =
          typeof step.value === 'string'
            ? interpolate(step.value, variables)
            : String(step.value ?? '');
        if (!selector) {
          throw new Error('Wait step with condition "selector" requires a value');
        }
        await page.waitForSelector(selector, { state: 'visible' });
        break;
      }

      default:
        throw new Error(`Unknown wait condition: ${step.condition}`);
    }
  }

  private async executeScreenshot(
    step: ScreenshotStep,
    stepId: string,
    page: Page,
    variables: Record<string, unknown>,
    screenshots: WorkflowResult['screenshots']
  ): Promise<{ byteLength: number }> {
    const opts: ScreenshotOptions = {
      fullPage: step.fullPage ?? false,
    };

    const base64 = await this.interactionManager.screenshot(page, opts);

    screenshots.push({
      stepId,
      data: base64,
    });

    if (step.saveAs) {
      variables[step.saveAs] = base64;
    }

    return { byteLength: base64.length };
  }

  private async executeSetVariable(
    step: SetVariableStep,
    page: Page,
    variables: Record<string, unknown>
  ): Promise<{ name: string; value: unknown }> {
    let resolvedValue: unknown;

    if (step.fromEval) {
      // Evaluate JS expression in the page context
      resolvedValue = await page.evaluate((expr: string) => {
        // eslint-disable-next-line no-eval
        return eval(expr);
      }, step.fromEval);
    } else if (step.fromSelector) {
      const selector = interpolate(step.fromSelector, variables);
      const element = await page.$(selector);
      if (element) {
        resolvedValue = await element.textContent();
      } else {
        resolvedValue = null;
      }
    } else if (step.value !== undefined) {
      resolvedValue = interpolate(step.value, variables);
    } else {
      resolvedValue = null;
    }

    variables[step.name] = resolvedValue;

    return { name: step.name, value: resolvedValue };
  }

  private async executeConditional(
    step: ConditionalStep,
    page: Page,
    variables: Record<string, unknown>,
    allStepResults: StepResult[],
    extractions: WorkflowResult['extractions'],
    screenshots: WorkflowResult['screenshots'],
    continueOnError: boolean
  ): Promise<{ branch: 'then' | 'else' | 'none' }> {
    let condResult: boolean;
    try {
      condResult = Boolean(evaluateCondition(step.condition, variables));
    } catch (err) {
      throw new Error(
        `Condition evaluation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (condResult) {
      await this.executeSteps(
        step.then,
        page,
        variables,
        allStepResults,
        extractions,
        screenshots,
        continueOnError
      );
      return { branch: 'then' };
    } else if (step.else && step.else.length > 0) {
      await this.executeSteps(
        step.else,
        page,
        variables,
        allStepResults,
        extractions,
        screenshots,
        continueOnError
      );
      return { branch: 'else' };
    }

    return { branch: 'none' };
  }

  private async executeLoop(
    step: LoopStep,
    page: Page,
    variables: Record<string, unknown>,
    allStepResults: StepResult[],
    extractions: WorkflowResult['extractions'],
    screenshots: WorkflowResult['screenshots'],
    continueOnError: boolean
  ): Promise<{ iterations: number }> {
    const maxIterations = step.maxIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
    let iterations = 0;

    if (step.over) {
      // Iterate over an array stored in a variable
      const arrayVar = variables[step.over];
      if (!Array.isArray(arrayVar)) {
        throw new Error(
          `Loop "over" variable "${step.over}" is not an array (got ${typeof arrayVar})`
        );
      }

      for (const item of arrayVar) {
        if (iterations >= maxIterations) {
          logger.warn('workflow:loop hit maxIterations', {
            maxIterations,
            over: step.over,
          });
          break;
        }

        // Set loop variables
        variables['__item'] = item;
        variables['__index'] = iterations;

        // Check breakIf
        if (step.breakIf) {
          try {
            if (Boolean(evaluateCondition(step.breakIf, variables))) {
              logger.debug('workflow:loop breakIf triggered', { iteration: iterations });
              break;
            }
          } catch (err) {
            throw new Error(
              `Loop breakIf evaluation failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        await this.executeSteps(
          step.steps,
          page,
          variables,
          allStepResults,
          extractions,
          screenshots,
          continueOnError
        );

        iterations++;
      }
    } else if (step.times !== undefined && step.times > 0) {
      // Repeat N times
      const repeatCount = Math.min(step.times, maxIterations);

      for (let i = 0; i < repeatCount; i++) {
        variables['__index'] = i;

        // Check breakIf
        if (step.breakIf) {
          try {
            if (Boolean(evaluateCondition(step.breakIf, variables))) {
              logger.debug('workflow:loop breakIf triggered', { iteration: i });
              break;
            }
          } catch (err) {
            throw new Error(
              `Loop breakIf evaluation failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        await this.executeSteps(
          step.steps,
          page,
          variables,
          allStepResults,
          extractions,
          screenshots,
          continueOnError
        );

        iterations++;
      }
    } else {
      throw new Error('Loop step requires either "over" (variable name) or "times" (number)');
    }

    // Clean up loop variables
    delete variables['__item'];
    delete variables['__index'];

    return { iterations };
  }

  // -------------------------------------------------------------------------
  // Private: Timeout
  // -------------------------------------------------------------------------

  private createTimeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('__workflow_timeout__'));
      }, timeoutMs);

      // Allow Node to exit even if timer is pending
      if (timer.unref) {
        timer.unref();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Private: Validation Helpers
  // -------------------------------------------------------------------------

  private validateSteps(
    steps: WorkflowStep[],
    errors: string[],
    path: string
  ): void {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepPath = `${path}[${i}]`;

      if (!step || typeof step !== 'object') {
        errors.push(`${stepPath}: step must be a non-null object`);
        continue;
      }

      if (!step.type || !VALID_STEP_TYPES.has(step.type)) {
        errors.push(
          `${stepPath}: invalid step type "${step.type}". Must be one of: ${[...VALID_STEP_TYPES].join(', ')}`
        );
        continue;
      }

      switch (step.type) {
        case 'fetch':
          if (!step.url || typeof step.url !== 'string') {
            errors.push(`${stepPath}: fetch step requires a non-empty "url" string`);
          }
          break;

        case 'interact':
          if (!Array.isArray(step.actions) || step.actions.length === 0) {
            errors.push(`${stepPath}: interact step requires a non-empty "actions" array`);
          }
          break;

        case 'extract':
          // No required fields beyond type
          break;

        case 'wait':
          if (!step.condition || !VALID_WAIT_CONDITIONS.has(step.condition)) {
            errors.push(
              `${stepPath}: wait step requires a "condition" of: ${[...VALID_WAIT_CONDITIONS].join(', ')}`
            );
          }
          if (step.condition === 'selector' && (!step.value || typeof step.value !== 'string')) {
            errors.push(`${stepPath}: wait step with condition "selector" requires a string "value"`);
          }
          if (step.condition === 'timeout' && step.value !== undefined) {
            const numVal = typeof step.value === 'number' ? step.value : parseInt(String(step.value), 10);
            if (isNaN(numVal) || numVal <= 0) {
              errors.push(`${stepPath}: wait step with condition "timeout" requires a positive numeric "value"`);
            }
          }
          break;

        case 'screenshot':
          // No required fields beyond type
          break;

        case 'setVariable':
          if (!step.name || typeof step.name !== 'string') {
            errors.push(`${stepPath}: setVariable step requires a non-empty "name" string`);
          }
          if (step.value === undefined && !step.fromEval && !step.fromSelector) {
            errors.push(
              `${stepPath}: setVariable step requires at least one of "value", "fromEval", or "fromSelector"`
            );
          }
          break;

        case 'if':
          if (!step.condition || typeof step.condition !== 'string') {
            errors.push(`${stepPath}: if step requires a non-empty "condition" string`);
          }
          if (!Array.isArray(step.then) || step.then.length === 0) {
            errors.push(`${stepPath}: if step requires a non-empty "then" array`);
          } else {
            this.validateSteps(step.then, errors, `${stepPath}.then`);
          }
          if (step.else !== undefined) {
            if (!Array.isArray(step.else)) {
              errors.push(`${stepPath}: if step "else" must be an array`);
            } else if (step.else.length > 0) {
              this.validateSteps(step.else, errors, `${stepPath}.else`);
            }
          }
          break;

        case 'loop':
          if (!step.over && (step.times === undefined || step.times <= 0)) {
            errors.push(
              `${stepPath}: loop step requires either "over" (variable name) or a positive "times" number`
            );
          }
          if (!Array.isArray(step.steps) || step.steps.length === 0) {
            errors.push(`${stepPath}: loop step requires a non-empty "steps" array`);
          } else {
            this.validateSteps(step.steps, errors, `${stepPath}.steps`);
          }
          if (step.maxIterations !== undefined && (typeof step.maxIterations !== 'number' || step.maxIterations <= 0)) {
            errors.push(`${stepPath}: loop step "maxIterations" must be a positive number`);
          }
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const workflowEngine = new WorkflowEngine();
