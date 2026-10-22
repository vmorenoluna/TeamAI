import { describe, it, expect } from 'vitest';
import { buildActionResultMessage } from '../../src/lib/action-result-message';

// Project filtering is not tested here: it is the existing `broadcastToProject`
// closure in server.ts, which filters on the event's `projectRoot`.
describe('buildActionResultMessage', () => {
  it('serialises a success event with the exact key order and no projectRoot', () => {
    const msg = buildActionResultMessage({
      operationId: 'op-1',
      action: 'deleteTask',
      taskId: 't1',
      projectRoot: '/p',
      ok: true,
    });
    expect(msg).toBe('{"type":"action-result","operationId":"op-1","action":"deleteTask","taskId":"t1","ok":true}');
    expect(msg).not.toContain('projectRoot');
  });

  it('carries the error for a failed background operation', () => {
    const msg = buildActionResultMessage({
      operationId: 'op-2',
      action: 'removeWorktree',
      taskId: 't2',
      projectRoot: '/p',
      ok: false,
      error: 'boom',
    });
    expect(msg).toBe('{"type":"action-result","operationId":"op-2","action":"removeWorktree","taskId":"t2","ok":false,"error":"boom"}');
    expect(JSON.parse(msg).projectRoot).toBeUndefined();
  });
});
