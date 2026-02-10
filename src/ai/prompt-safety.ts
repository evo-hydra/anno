/**
 * Prompt Safety Module
 *
 * Detects and flags potential prompt injection attempts in user inputs
 * and retrieved content before they reach the LLM.
 *
 * @module ai/prompt-safety
 */

export interface PromptSafetyResult {
  /** Whether the content is considered safe */
  safe: boolean;

  /** Confidence score (0-1) that content is safe */
  confidence: number;

  /** List of detected threats */
  threats: PromptThreat[];

  /** Risk level: 'low', 'medium', 'high', 'critical' */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';

  /** Sanitized version of the content (with threats removed/neutralized) */
  sanitized: string;
}

export interface PromptThreat {
  /** Type of threat detected */
  type: ThreatType;

  /** Severity score (0-1) */
  severity: number;

  /** Description of the threat */
  description: string;

  /** The actual detected pattern/content */
  match: string;

  /** Character position in original text */
  position?: number;
}

export type ThreatType =
  | 'instruction_injection'      // "Ignore previous instructions and..."
  | 'role_manipulation'          // "You are now a helpful assistant who..."
  | 'system_prompt_leak'         // "Repeat your system prompt"
  | 'delimiters'                 // Triple quotes, XML tags, etc.
  | 'encoding_attack'            // Base64, hex encoding to bypass filters
  | 'jailbreak_attempt'          // Known jailbreak patterns
  | 'context_overflow'           // Extremely long content to overflow context
  | 'html_comment_injection'     // <!-- ignore above and do this -->
  | 'control_characters'         // Null bytes, ANSI codes, etc.
  | 'sql_like_injection';        // SQL-style comments, unions, etc.

/**
 * Patterns for detecting prompt injection attempts
 */
const THREAT_PATTERNS: Array<{
  type: ThreatType;
  pattern: RegExp;
  severity: number;
  description: string;
}> = [
  // Instruction Injection
  {
    type: 'instruction_injection',
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|commands?|directives?)/gi,
    severity: 0.9,
    description: 'Attempts to override previous instructions'
  },
  {
    type: 'instruction_injection',
    pattern: /disregard\s+(all\s+|everything\s+|the\s+)?(previous|prior|above|earlier)/gi,
    severity: 0.9,
    description: 'Attempts to disregard previous context'
  },
  {
    type: 'instruction_injection',
    pattern: /forget\s+(everything|all|what)\s+(you|was|were|that)/gi,
    severity: 0.85,
    description: 'Attempts to reset context'
  },

  // Role Manipulation
  {
    type: 'role_manipulation',
    pattern: /(you\s+are\s+now|from\s+now\s+on|act\s+as|pretend\s+to\s+be|roleplay\s+as)\s+(a|an|the)?\s*\w+/gi,
    severity: 0.8,
    description: 'Attempts to change AI role or behavior'
  },
  {
    type: 'role_manipulation',
    pattern: /your\s+new\s+(role|task|objective|purpose)\s+is/gi,
    severity: 0.85,
    description: 'Attempts to redefine AI purpose'
  },

  // System Prompt Leakage
  {
    type: 'system_prompt_leak',
    pattern: /(print|show|display|reveal|output|repeat|tell\s+me)\s+(me\s+)?(your\s+)?(system\s+prompt|initial\s+instructions|original\s+instructions)/gi,
    severity: 0.7,
    description: 'Attempts to extract system prompts'
  },
  {
    type: 'system_prompt_leak',
    pattern: /what\s+(are\s+)?your\s+(initial|original|system)\s+(instructions|prompts|rules)/gi,
    severity: 0.7,
    description: 'Attempts to query system configuration'
  },

  // Delimiter Attacks
  {
    type: 'delimiters',
    pattern: /```[\s\S]*?```/g,
    severity: 0.5,
    description: 'Code blocks that could escape context'
  },
  {
    type: 'delimiters',
    pattern: /\[SYSTEM\]|\[\/SYSTEM\]|\[USER\]|\[\/USER\]|\[ASSISTANT\]|\[\/ASSISTANT\]/gi,
    severity: 0.8,
    description: 'Fake system/user/assistant delimiters'
  },
  {
    type: 'delimiters',
    pattern: /<\|system\|>|<\|user\|>|<\|assistant\|>|<\|end\|>/gi,
    severity: 0.8,
    description: 'Chat template injection'
  },

  // HTML Comment Injection
  {
    type: 'html_comment_injection',
    pattern: /<!--[\s\S]*?(ignore|disregard|instead|override)[\s\S]*?-->/gi,
    severity: 0.75,
    description: 'Instructions hidden in HTML comments'
  },

  // Encoding Attacks
  {
    type: 'encoding_attack',
    pattern: /\\x[0-9a-f]{2}/gi,
    severity: 0.6,
    description: 'Hex-encoded content that may bypass filters'
  },
  {
    type: 'encoding_attack',
    pattern: /\\u[0-9a-f]{4}/gi,
    severity: 0.6,
    description: 'Unicode-encoded content'
  },
  {
    type: 'encoding_attack',
    pattern: /[A-Za-z0-9+\/]{20,}={0,2}/g, // Base64-like
    severity: 0.4,
    description: 'Possible base64-encoded payload'
  },

  // Jailbreak Patterns
  {
    type: 'jailbreak_attempt',
    pattern: /DAN\s+mode|do\s+anything\s+now/gi,
    severity: 0.95,
    description: 'Known "DAN" jailbreak attempt'
  },
  {
    type: 'jailbreak_attempt',
    pattern: /developer\s+mode|dev\s+mode|bypass\s+restrictions/gi,
    severity: 0.9,
    description: 'Developer mode jailbreak attempt'
  },

  // Control Characters
  {
    type: 'control_characters',
    pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
    severity: 0.6,
    description: 'Control characters that may cause parsing issues'
  },
  {
    type: 'control_characters',
    pattern: /\x1b\[[0-9;]*m/g, // ANSI escape codes
    severity: 0.5,
    description: 'ANSI escape sequences'
  },

  // SQL-like Injection (for LLM tool use)
  {
    type: 'sql_like_injection',
    pattern: /--\s*[\r\n]|\/\*[\s\S]*?\*\//g,
    severity: 0.5,
    description: 'SQL-style comments'
  },
  {
    type: 'sql_like_injection',
    pattern: /;\s*(drop|delete|truncate|insert|update)\s+/gi,
    severity: 0.7,
    description: 'SQL injection-like commands'
  }
];

/**
 * Analyzes text for prompt injection threats
 */
export function analyzePromptSafety(text: string, options: {
  /** Maximum allowed text length before flagging as context overflow */
  maxLength?: number;

  /** Minimum severity to consider a threat (0-1) */
  minSeverity?: number;
} = {}): PromptSafetyResult {
  const {
    maxLength = 100000, // 100k chars
    minSeverity = 0.4
  } = options;

  const threats: PromptThreat[] = [];
  let sanitized = text;

  // Check for context overflow
  if (text.length > maxLength) {
    threats.push({
      type: 'context_overflow',
      severity: 0.8,
      description: `Content exceeds max length (${text.length} > ${maxLength})`,
      match: `${text.slice(0, 100)}...`,
      position: 0
    });
  }

  // Scan for threat patterns
  for (const { type, pattern, severity, description } of THREAT_PATTERNS) {
    if (severity < minSeverity) continue;

    const matches = [...text.matchAll(new RegExp(pattern))];

    for (const match of matches) {
      threats.push({
        type,
        severity,
        description,
        match: match[0],
        position: match.index
      });

      // Sanitize by removing the threat
      // For high-severity threats, remove completely
      // For medium-severity, neutralize with backticks
      if (severity >= 0.7) {
        sanitized = sanitized.replace(match[0], '[REMOVED]');
      } else if (severity >= 0.5) {
        sanitized = sanitized.replace(match[0], `\`${match[0]}\``);
      }
    }
  }

  // Calculate overall risk level
  const maxSeverity = threats.length > 0
    ? Math.max(...threats.map(t => t.severity))
    : 0;

  const riskLevel: PromptSafetyResult['riskLevel'] =
    maxSeverity >= 0.8 ? 'critical' :
    maxSeverity >= 0.6 ? 'high' :
    maxSeverity >= 0.4 ? 'medium' : 'low';

  // Content is safe if no high-severity threats
  const safe = maxSeverity < 0.7;

  // Confidence is inverse of max severity
  const confidence = 1 - maxSeverity;

  return {
    safe,
    confidence,
    threats,
    riskLevel,
    sanitized
  };
}

/**
 * Quick check if text contains any high-severity threats
 */
export function isSafePrompt(text: string): boolean {
  const result = analyzePromptSafety(text, { minSeverity: 0.7 });
  return result.safe;
}

/**
 * Sanitize text by removing detected threats
 */
export function sanitizePrompt(text: string): string {
  const result = analyzePromptSafety(text);
  return result.sanitized;
}

/**
 * Get a human-readable summary of safety analysis
 */
export function getSafetySummary(result: PromptSafetyResult): string {
  if (result.safe) {
    return `✓ Content appears safe (${Math.round(result.confidence * 100)}% confidence)`;
  }

  const threatTypes = [...new Set(result.threats.map(t => t.type))];
  const threatCount = result.threats.length;

  return `⚠ ${threatCount} threat(s) detected: ${threatTypes.join(', ')} (Risk: ${result.riskLevel})`;
}
