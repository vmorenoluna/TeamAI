// Stub — full implementation in Step 8.
export class Orchestrator {
  constructor(private projectPath: string) {}

  runTask(_taskId: string, _description: string): void {
    throw new Error('Orchestrator not yet implemented (Step 8)');
  }

  async approveTask(_taskId: string, _strategy: 'local-merge' | 'pull-request'): Promise<void> {
    throw new Error('Orchestrator not yet implemented (Step 8)');
  }

  async rejectTask(_taskId: string, _feedback: string): Promise<void> {
    throw new Error('Orchestrator not yet implemented (Step 8)');
  }
}
