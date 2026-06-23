import { describe, it, expect } from 'vitest';
import {
  extractText,
  extractProgressText,
  type AssistantMessage,
  type SystemEvent,
  type ResultEvent,
  type ErrorEvent,
  type StreamEvent,
  type TextContentBlock,
  type ToolUseContentBlock,
  type ToolResultContentBlock,
  type ContentBlock,
  type PlanSubtask,
  type PlanData,
  type QACriterion,
  type QAIssue,
  type QAReportData,
} from '@/lib/stream-types';

// ── extractText ──────────────────────────────────────────────────────────────

describe('extractText', () => {
  it('returns empty string for non-assistant events', () => {
    const systemEvent: StreamEvent = { type: 'system', subtype: 'init' };
    expect(extractText(systemEvent)).toBe('');

    const resultEvent: StreamEvent = { type: 'result', duration_ms: 100 };
    expect(extractText(resultEvent)).toBe('');

    const errorEvent: StreamEvent = { type: 'error', error: 'fail' };
    expect(extractText(errorEvent)).toBe('');
  });

  it('returns empty string for assistant message with no content', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: { content: [] },
    };
    expect(extractText(msg)).toBe('');
  });

  it('returns empty string for assistant message with missing message field', () => {
    const msg = { type: 'assistant' } as unknown as StreamEvent;
    expect(extractText(msg)).toBe('');
  });

  it('returns empty string for assistant message with null message field', () => {
    const msg = { type: 'assistant', message: null } as unknown as StreamEvent;
    expect(extractText(msg)).toBe('');
  });

  it('extracts text from a single text content block', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello, world!' } as TextContentBlock,
        ],
      },
    };
    expect(extractText(msg)).toBe('Hello, world!');
  });

  it('concatenates text from multiple text content blocks', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello' } as TextContentBlock,
          { type: 'text', text: ', ' } as TextContentBlock,
          { type: 'text', text: 'world!' } as TextContentBlock,
        ],
      },
    };
    expect(extractText(msg)).toBe('Hello, world!');
  });

  it('skips non-text content blocks (tool_use, tool_result)', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Before' } as TextContentBlock,
          { type: 'tool_use', id: '1', name: 'read', input: {} } as ToolUseContentBlock,
          { type: 'tool_result', tool_use_id: '1', content: 'result' } as ToolResultContentBlock,
          { type: 'text', text: 'After' } as TextContentBlock,
        ],
      },
    };
    expect(extractText(msg)).toBe('BeforeAfter');
  });

  it('handles assistant message with usage and model metadata', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hi' } as TextContentBlock],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    expect(extractText(msg)).toBe('Hi');
  });

  it('returns empty string for all tool_use blocks (no text)', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: '1', name: 'bash', input: {} } as ToolUseContentBlock,
        ],
      },
    };
    expect(extractText(msg)).toBe('');
  });

  it('handles empty string text blocks', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '' } as TextContentBlock,
          { type: 'text', text: 'non-empty' } as TextContentBlock,
          { type: 'text', text: '' } as TextContentBlock,
        ],
      },
    };
    expect(extractText(msg)).toBe('non-empty');
  });

  it('handles assistant event with stop_sequence set', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Done' } as TextContentBlock],
        stop_sequence: '</output>',
      },
    };
    expect(extractText(msg)).toBe('Done');
  });

  it('handles undefined content gracefully', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: { content: [] },
    };
    expect(extractText(msg)).toBe('');
  });
});

// ── extractProgressText ──────────────────────────────────────────────────────

describe('extractProgressText', () => {
  it('returns empty string for unknown event types', () => {
    const unknownEvent: StreamEvent = { type: 'unknown' } as unknown as StreamEvent;
    expect(extractProgressText(unknownEvent)).toBe('');
  });

  it('returns session started for system init event', () => {
    const initEvent: StreamEvent = {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4-20250514',
    };
    expect(extractProgressText(initEvent)).toBe(
      '◆ Session started — claude-sonnet-4-20250514'
    );
  });

  it('returns session started with fallback for system init without model', () => {
    const initEvent: StreamEvent = { type: 'system', subtype: 'init' };
    expect(extractProgressText(initEvent)).toBe('◆ Session started — claude');
  });

  it('returns empty for non-init system events', () => {
    const sysEvent: StreamEvent = { type: 'system', subtype: 'other' };
    expect(extractProgressText(sysEvent)).toBe('');
  });

  it('extracts text from assistant event with single text block', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Analyzing codebase…' } as TextContentBlock],
      },
    };
    expect(extractProgressText(msg)).toBe('Analyzing codebase…');
  });

  it('includes tool_use names with ▶ prefix, separated by newlines', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading files' } as TextContentBlock,
          { type: 'tool_use', id: '1', name: 'read_file', input: {} } as ToolUseContentBlock,
          { type: 'tool_use', id: '2', name: 'bash', input: {} } as ToolUseContentBlock,
        ],
      },
    };
    expect(extractProgressText(msg)).toBe('Reading files\n▶ read_file\n▶ bash');
  });

  it('handles assistant message with only tool_use blocks (no text)', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: '1', name: 'grep', input: {} } as ToolUseContentBlock,
        ],
      },
    };
    expect(extractProgressText(msg)).toBe('▶ grep');
  });

  it('skips tool_result content blocks', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Done' } as TextContentBlock,
          { type: 'tool_result', tool_use_id: '1', content: 'output' } as ToolResultContentBlock,
        ],
      },
    };
    expect(extractProgressText(msg)).toBe('Done');
  });

  it('returns success result with cost and duration', () => {
    const result: StreamEvent = {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.042,
      duration_ms: 12345,
    };
    expect(extractProgressText(result)).toBe('✓ Done — $0.0420 (12345ms)');
  });

  it('returns success result without cost when missing', () => {
    const result: StreamEvent = {
      type: 'result',
      subtype: 'success',
      duration_ms: 5000,
    };
    expect(extractProgressText(result)).toBe('✓ Done (5000ms)');
  });

  it('returns success result without duration when missing', () => {
    const result: StreamEvent = {
      type: 'result',
      subtype: 'success',
    };
    expect(extractProgressText(result)).toBe('✓ Done (?ms)');
  });

  it('returns failure result', () => {
    const result: StreamEvent = {
      type: 'result',
      subtype: 'error',
      result: 'permission denied',
    };
    expect(extractProgressText(result)).toBe('✗ Failed: permission denied');
  });

  it('returns failure result with fallback when result field is missing', () => {
    const result: StreamEvent = { type: 'result', subtype: 'error' };
    expect(extractProgressText(result)).toBe('✗ Failed: unknown error');
  });

  it('returns error message for error events', () => {
    const err: StreamEvent = { type: 'error', error: 'connection lost' };
    expect(extractProgressText(err)).toBe('⚠ connection lost');
  });

  it('returns fallback for error events without error field', () => {
    const err: StreamEvent = { type: 'error' } as StreamEvent;
    expect(extractProgressText(err)).toBe('⚠ unknown error');
  });

  it('handles assistant message with empty content block', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: { content: [] },
    };
    expect(extractProgressText(msg)).toBe('');
  });

  it('handles assistant message with missing message field', () => {
    const msg = { type: 'assistant' } as unknown as StreamEvent;
    expect(extractProgressText(msg)).toBe('');
  });

  it('handles tool_use with non-string name gracefully', () => {
    const msg: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: '1', name: 123, input: {} } as unknown as ToolUseContentBlock,
        ],
      },
    };
    expect(extractProgressText(msg)).toBe('▶ tool');
  });
});

// ── Type guard behavior (runtime validation) ─────────────────────────────────

describe('StreamEvent type discrimination', () => {
  it('AssistantMessage has correct type literal', () => {
    const msg: AssistantMessage = {
      type: 'assistant',
      message: { content: [] },
    };
    expect(msg.type).toBe('assistant');
  });

  it('SystemEvent has correct type literal', () => {
    const evt: SystemEvent = { type: 'system', subtype: 'init' };
    expect(evt.type).toBe('system');
  });

  it('ResultEvent has correct type literal', () => {
    const evt: ResultEvent = { type: 'result', duration_ms: 100 };
    expect(evt.type).toBe('result');
  });

  it('ErrorEvent has correct type literal', () => {
    const evt: ErrorEvent = { type: 'error', error: 'fail' };
    expect(evt.type).toBe('error');
  });
});

// ── ContentBlock union type ──────────────────────────────────────────────────

describe('ContentBlock union', () => {
  it('TextContentBlock has type text and text string', () => {
    const block: TextContentBlock = { type: 'text', text: 'hello' };
    expect(block.type).toBe('text');
    expect(block.text).toBe('hello');
  });

  it('ToolUseContentBlock has required fields', () => {
    const block: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'read_file',
      input: { path: '/src/index.ts' },
    };
    expect(block.type).toBe('tool_use');
    expect(block.id).toBe('toolu_01');
    expect(block.name).toBe('read_file');
    expect(block.input.path).toBe('/src/index.ts');
  });

  it('ToolResultContentBlock has required fields', () => {
    const block: ToolResultContentBlock = {
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: 'file contents here',
    };
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('toolu_01');
    expect(block.content).toBe('file contents here');
  });

  it('ContentBlock can be any of the three types', () => {
    const textBlock: ContentBlock = { type: 'text', text: 'a' };
    const toolUseBlock: ContentBlock = { type: 'tool_use', id: '1', name: 'f', input: {} };
    const toolResultBlock: ContentBlock = { type: 'tool_result', tool_use_id: '1', content: 'r' };

    expect(textBlock.type).toBe('text');
    expect(toolUseBlock.type).toBe('tool_use');
    expect(toolResultBlock.type).toBe('tool_result');
  });
});

// ── Plan data types ──────────────────────────────────────────────────────────

describe('PlanData types', () => {
  it('PlanSubtask with all fields', () => {
    const subtask: PlanSubtask = {
      id: 'task-1',
      title: 'Implement login',
      description: 'Add login page',
      files: ['src/login.ts', 'src/login.test.ts'],
    };
    expect(subtask.id).toBe('task-1');
    expect(subtask.title).toBe('Implement login');
    expect(subtask.description).toBe('Add login page');
    expect(subtask.files).toEqual(['src/login.ts', 'src/login.test.ts']);
  });

  it('PlanSubtask without optional fields', () => {
    const subtask: PlanSubtask = { id: 'task-2', title: 'Setup CI' };
    expect(subtask.description).toBeUndefined();
    expect(subtask.files).toBeUndefined();
  });

  it('PlanData with subtasks', () => {
    const plan: PlanData = {
      subtasks: [
        { id: '1', title: 'Step 1' },
        { id: '2', title: 'Step 2' },
      ],
    };
    expect(plan.subtasks).toHaveLength(2);
  });

  it('PlanData with undefined subtasks', () => {
    const plan: PlanData = {};
    expect(plan.subtasks).toBeUndefined();
  });

  it('PlanData with empty subtasks array', () => {
    const plan: PlanData = { subtasks: [] };
    expect(plan.subtasks).toHaveLength(0);
  });
});

// ── QA report data types ─────────────────────────────────────────────────────

describe('QAReportData types', () => {
  it('QACriterion with PASS status', () => {
    const c: QACriterion = { criterion: 'Type safety', status: 'PASS' };
    expect(c.status).toBe('PASS');
    expect(c.notes).toBeUndefined();
  });

  it('QACriterion with FAIL status and notes', () => {
    const c: QACriterion = {
      criterion: 'Error handling',
      status: 'FAIL',
      notes: 'Missing try/catch in processData()',
    };
    expect(c.status).toBe('FAIL');
    expect(c.notes).toBe('Missing try/catch in processData()');
  });

  it('QACriterion with criterion field only (no name)', () => {
    const c: QACriterion = { criterion: 'Modern format', status: 'PASS' };
    expect(c.criterion).toBe('Modern format');
    expect(c.name).toBeUndefined();
  });

  it('QACriterion with name field as fallback for older reports', () => {
    const c: QACriterion = { name: 'Legacy format', status: 'FAIL', notes: 'Old style' };
    expect(c.name).toBe('Legacy format');
    expect(c.criterion).toBeUndefined();
  });

  it('QACriterion with both criterion and name', () => {
    const c: QACriterion = {
      criterion: 'Primary',
      name: 'Fallback',
      status: 'PASS',
    };
    expect(c.criterion).toBe('Primary');
    expect(c.name).toBe('Fallback');
  });

  it('QACriterion with fix_needed field', () => {
    const c: QACriterion = {
      criterion: 'Security',
      status: 'FAIL',
      fix_needed: 'Add input validation',
    };
    expect(c.fix_needed).toBe('Add input validation');
  });

  it('QACriterion with evidence field', () => {
    const c: QACriterion = {
      criterion: 'Coverage',
      status: 'FAIL',
      evidence: 'Line 42 throws unhandled exception',
    };
    expect(c.evidence).toBe('Line 42 throws unhandled exception');
  });

  it('QAReportData with PASS overall', () => {
    const report: QAReportData = { overall: 'PASS' };
    expect(report.overall).toBe('PASS');
    expect(report.criteria).toBeUndefined();
  });

  it('QAReportData with FAIL overall and criteria', () => {
    const report: QAReportData = {
      overall: 'FAIL',
      criteria: [
        { criterion: 'Tests', status: 'PASS' },
        { criterion: 'Lint', status: 'FAIL', notes: '3 errors' },
      ],
    };
    expect(report.overall).toBe('FAIL');
    expect(report.criteria).toHaveLength(2);
  });

  it('QAReportData with additional_issues field', () => {
    const report: QAReportData = {
      overall: 'FAIL',
      additional_issues: [
        { severity: 'critical', description: 'Memory leak in render loop', file: 'src/renderer.ts' },
        { severity: 'warning', description: 'Deprecated hook usage', fix_needed: 'Switch to useEffect' },
      ],
    };
    expect(report.additional_issues).toHaveLength(2);
    expect(report.additional_issues![0].severity).toBe('critical');
    expect(report.additional_issues![0].description).toBe('Memory leak in render loop');
    expect(report.additional_issues![0].file).toBe('src/renderer.ts');
  });

  it('QAIssue with all fields', () => {
    const issue: QAIssue = {
      severity: 'critical',
      description: 'SQL injection in query builder',
      file: 'src/db/query.ts',
      fix_needed: 'Use parameterized queries',
    };
    expect(issue.severity).toBe('critical');
    expect(issue.description).toBe('SQL injection in query builder');
    expect(issue.file).toBe('src/db/query.ts');
    expect(issue.fix_needed).toBe('Use parameterized queries');
  });

  it('QAIssue with message field (legacy format fallback)', () => {
    const issue: QAIssue = {
      severity: 'suggestion',
      description: 'Consider adding retries',
      message: 'Consider adding retries',
    };
    expect(issue.message).toBe('Consider adding retries');
  });

  it('QAIssue without optional fields', () => {
    const issue: QAIssue = {
      severity: 'warning',
      description: 'Documentation missing',
    };
    expect(issue.file).toBeUndefined();
    expect(issue.fix_needed).toBeUndefined();
    expect(issue.message).toBeUndefined();
  });
});
