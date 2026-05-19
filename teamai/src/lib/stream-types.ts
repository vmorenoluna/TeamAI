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
  name: string;
  status: 'PASS' | 'FAIL';
  notes?: string;
}

export interface QAReportData {
  overall: 'PASS' | 'FAIL';
  criteria?: QACriterion[];
}

export function extractText(event: StreamEvent): string {
  if (event.type !== 'assistant') return '';
  return (event.message?.content ?? [])
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}
