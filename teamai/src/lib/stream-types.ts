/**
 * Shared types for Claude stream-json events used across hooks and components.
 */

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextContentBlock | ToolUseContentBlock | ToolResultContentBlock;

export interface AssistantMessage {
  type: 'assistant';
  message: {
    content: ContentBlock[];
    model?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

export interface SystemEvent {
  type: 'system';
  subtype: string;
  [key: string]: unknown;
}

export interface ResultEvent {
  type: 'result';
  subtype?: string;
  duration_ms?: number;
  cost_usd?: number;
  [key: string]: unknown;
}

export interface ErrorEvent {
  type: 'error';
  error: string;
}

/**
 * Union type for any Claude stream-json event.
 */
export type StreamEvent = AssistantMessage | SystemEvent | ResultEvent | ErrorEvent;

/**
 * Extract text content from a StreamEvent's assistant message.
 * Returns the concatenated text from all text-type content blocks.
 */

/** Plan data from plan.json */
export interface PlanSubtask {
  id: string;
  title: string;
  description?: string;
  files?: string[];
  completed?: boolean;
}

export interface PlanData {
  subtasks?: PlanSubtask[];
}

/** QA report data from qa_report.json */
export interface QACriterion {
  criterion?: string;
  name?: string;
  status: 'PASS' | 'FAIL';
  notes?: string;
  evidence?: string;
  fix_needed?: string;
}

export interface QAIssue {
  /** @deprecated Severity is no longer used by the pipeline — all issues are mandatory. */
  severity?: 'critical' | 'warning' | 'suggestion';
  description: string;
  file?: string;
  fix_needed?: string;
  message?: string;
}

export interface QAReportData {
  overall: 'PASS' | 'FAIL';
  criteria?: QACriterion[];
  additional_issues?: QAIssue[];
}

export function extractText(event: StreamEvent): string {
  if (event.type !== 'assistant') return '';
  return (event.message?.content ?? [])
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * Extract rich progress text from any stream event, including tool names
 * and system events. Use this for streaming output where the user needs
 * to see what the agent is doing (not just its thinking text).
 *
 * Produces lines like:
 *   ◆ Session started — claude-sonnet-4-20250514
 *   I'll analyze the codebase...
 *   ▶ bash
 *   ▶ read_file
 *   ✓ Done — $0.0420 (12345ms)
 */
export function extractProgressText(event: StreamEvent): string {
  if (event.type === 'system' && event.subtype === 'init') {
    return `◆ Session started — ${event.model ?? 'claude'}`;
  }
  if (event.type === 'assistant') {
    const blocks = (event.message?.content ?? []) as ContentBlock[];
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        parts.push(b.text);
      } else if (b.type === 'tool_use') {
        const label = typeof b.name === 'string' ? b.name : 'tool';
        parts.push(`▶ ${label}`);
      }
    }
    return parts.join('\n');
  }
  if (event.type === 'result') {
    const cost = typeof event.total_cost_usd === 'number'
      ? ` — $${event.total_cost_usd.toFixed(4)}`
      : '';
    return event.subtype === 'success'
      ? `✓ Done${cost} (${event.duration_ms ?? '?'}ms)`
      : `✗ Failed: ${event.result ?? 'unknown error'}`;
  }
  if (event.type === 'error') {
    return `⚠ ${event.error ?? 'unknown error'}`;
  }
  return '';
}
