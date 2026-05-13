#!/usr/bin/env node

/**
 * AI PR Review Script
 *
 * Fetches the PR diff, sends it to DeepSeek API for review,
 * and posts a PR review (approve / request changes / comment).
 *
 * Environment variables:
 *   DEEPSEEK_API_KEY  — DeepSeek API key (required)
 *   GITHUB_TOKEN      — GitHub token for API calls (automatic in Actions)
 *   PR_NUMBER         — Pull request number
 *   REPO              — Repository in "owner/repo" format
 *   GITHUB_SHA        — Latest commit SHA on the PR
 */

import { execSync } from 'node:child_process';

const {
  DEEPSEEK_API_KEY,
  GITHUB_TOKEN,
  PR_NUMBER,
  REPO,
  GITHUB_SHA,
} = process.env;

if (!DEEPSEEK_API_KEY) {
  console.log('DEEPSEEK_API_KEY not set — skipping AI review');
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function gh(args) {
  return execSync(`gh ${args}`, {
    encoding: 'utf-8',
    env: { ...process.env, GITHUB_TOKEN },
  }).trim();
}

async function deepseek(prompt) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            'You are an expert code reviewer. Review the PR diff and respond ' +
            'with a structured verdict. Be thorough but fair — approve PRs that ' +
            'are well-structured, follow conventions, and have proper tests. ' +
            'Request changes only for real issues (bugs, type errors, missing ' +
            'tests, anti-patterns). Use COMMENT for minor suggestions.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${text}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function postReview(body, event) {
  const url = `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}/reviews`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      body,
      event,
      commit_id: GITHUB_SHA,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`GitHub API error ${response.status}: ${text}`);
  }
}

function parseVerdict(text) {
  const norm = text.toLowerCase();
  if (norm.includes('verdict: approve')) return 'APPROVE';
  if (norm.includes('verdict: changes')) return 'REQUEST_CHANGES';
  return 'COMMENT';
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Gather PR context
  const prInfoRaw = gh(`pr view ${PR_NUMBER} --json title,body,headRefName,baseRefName`);
  const prInfo = JSON.parse(prInfoRaw);
  const diff = gh(`pr diff ${PR_NUMBER} --color never`);

  if (!diff) {
    console.log('No diff to review — skipping AI review');
    return;
  }

  console.log(`Reviewing PR #${PR_NUMBER}: ${prInfo.title}`);

  // 2. Build the review prompt with project conventions
  const prompt = [
    `## Pull Request Review`,
    ``,
    `**Title:** ${prInfo.title}`,
    `**Description:** ${prInfo.body || '(none)'}`,
    `**Branch:** ${prInfo.headRefName} → ${prInfo.baseRefName}`,
    ``,
    `## Project Conventions`,
    ``,
    `- Source code is in the \`teamai/\` subdirectory`,
    `- Path alias \`@/*\` maps to \`src/*\``,
    `- Uses Tailwind CSS 4 with shadcn/ui components in \`src/components/ui/\``,
    `- Next.js App Router (\`src/app/\`)`,
    `- Server actions use \`'use server'\` directive`,
    `- Client components use \`'use client'\` directive`,
    `- Testing: Vitest for unit/integration, Playwright for E2E`,
    `- Commands run from \`teamai/\` directory`,
    `- TypeScript strict mode with --noEmit`,
    `- All new features should have tests`,
    ``,
    `## Diff to Review`,
    ``,
    '```diff',
    diff,
    '```',
    ``,
    `## Review Guidelines`,
    ``,
    `Check for:`,
    `1. TypeScript type safety (no \`any\` casts, proper generics)`,
    `2. Proper error handling (no empty catch blocks unless intentional)`,
    `3. Test coverage (new features should include tests)`,
    `4. Following existing project patterns (import paths, component structure)`,
    `5. No unused variables, imports, or dead code`,
    `6. Proper cleanup in tests (afterEach/afterAll for temp files)`,
    `7. React hooks rules (proper deps arrays, no hooks in conditions)`,
    `8. No hardcoded secrets or credentials`,
    ``,
    `Respond with exactly this format:`,
    ``,
    `VERDICT: approve | changes | comment`,
    `SUMMARY: <2-3 sentence summary>`,
    `DETAILS:`,
    `<numbered list of findings or "No issues found">`,
  ].join('\n');

  // 3. Call DeepSeek
  console.log('Calling DeepSeek API...');
  const reviewText = await deepseek(prompt);
  console.log('AI review received');

  // 4. Parse and post review
  const verdict = parseVerdict(reviewText);
  const summary = [
    `### 🤖 AI PR Review`,
    ``,
    reviewText,
    ``,
    `---`,
    `_Powered by DeepSeek API_`,
  ].join('\n');

  await postReview(summary, verdict);
  console.log(`Review posted: ${verdict}`);
}

main().catch((err) => {
  console.error('AI review failed:', err.message);
  // Don't fail the workflow — review is advisory
  process.exit(0);
});
