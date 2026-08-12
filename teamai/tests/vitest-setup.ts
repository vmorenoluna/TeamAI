import { configure } from '@testing-library/react';

configure({ testIdAttribute: 'data-component' });

// When vitest runs inside a git hook (e.g. the pre-commit hook running
// `npx vitest run`), git sets GIT_INDEX_FILE/GIT_DIR/etc. pointing at the
// OUTER repo's .git so hook scripts can inspect the commit-in-progress
// state. Those variables are inherited by every child process this test
// run spawns — including `git init`/`git worktree add` in unrelated temp
// repos created by integration tests — and cause git to resolve the wrong
// repository, producing errors like "Unable to create '.../index.lock':
// No such file or directory" that look like a Windows filesystem race but
// are actually a plain environment leak. Strip them so every git command
// spawned by tests resolves its repo purely from its own cwd.
for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) {
  delete process.env[key];
}
