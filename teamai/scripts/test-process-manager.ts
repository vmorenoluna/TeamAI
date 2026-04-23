const { processManager } = require('../src/lib/process-manager');

async function runTest() {
  const cwd = process.cwd();
  const taskId = 'test-task-123';
  const role = 'general';

  console.log(`Starting test for ProcessManager in ${cwd}`);
  console.log(`Type of processManager: ${typeof processManager}`);

  const sessionId = processManager.createSession({
    taskId,
    role,
    cwd,
  });

  console.log(`Session created: ${sessionId}`);

  processManager.on('event', (data) => {
    console.log(`[EVENT]`, JSON.stringify(data, null, 2));
  });

  processManager.on('error', (data) => {
    console.error(`[ERROR]`, data);
  });

  processManager.on('exit', (data) => {
    console.log(`[EXIT]`, data);
    process.exit(0);
  });

  // Wait a bit for the process to start
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('Sending command: "What is 2+2?"');
  processManager.writeToSession(sessionId, 'What is 2+2?\n');

  // Wait for some response, then terminate
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log('Terminating session...');
  processManager.terminateSession(sessionId);

}

runTest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
