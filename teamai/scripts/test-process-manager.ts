import { processManager } from '../src/lib/process-manager';

async function runTest() {
  const cwd = process.cwd();

  processManager.on('event', (data) => {
    console.log('[EVENT]', JSON.stringify(data, null, 2));
  });

  processManager.on('raw', (data) => {
    console.log('[RAW]', data.data);
  });

  processManager.on('error', (data) => {
    console.error('[ERROR]', data);
  });

  processManager.on('exit', (data) => {
    console.log('[EXIT]', data);
    process.exit(0);
  });

  const sessionId = await processManager.createSession({ taskId: 'test-task-123', role: 'general', cwd });
  console.log(`Session created: ${sessionId}`);

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('Sending: "What is 2+2?"');
  processManager.sendMessage(sessionId, 'What is 2+2?');

  await new Promise(resolve => setTimeout(resolve, 15000));
  console.log('Killing session...');
  processManager.killSession(sessionId);
}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
