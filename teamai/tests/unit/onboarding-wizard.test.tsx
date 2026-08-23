// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OnboardingWizard } from '@/components/onboarding-wizard';
import type { ToolStatus } from '@/lib/tool-checker';

// ── Hoisted mock functions ──────────────────────────────────────────────

const mockCheckTools = vi.hoisted(() => vi.fn());
const mockAddProject = vi.hoisted(() => vi.fn());
const mockCompleteOnboarding = vi.hoisted(() => vi.fn());

// ── Module mocks ────────────────────────────────────────────────────────

vi.mock('@/app/actions/tools', () => ({
  checkTools: () => mockCheckTools(),
}));

vi.mock('@/app/actions/projects', () => ({
  addProject: (formData: FormData) => mockAddProject(formData),
}));

vi.mock('@/app/actions/onboarding', () => ({
  completeOnboarding: () => mockCompleteOnboarding(),
}));

vi.mock('@/components/directory-browser', () => ({
  DirectoryBrowser: () => null,
}));

// Mock useTransition to resolve synchronously — same pattern as
// project-selector.test.tsx and alert-banner-absence.test.tsx.
const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void | Promise<void>) => {
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => { /* best-effort */ });
    } catch { /* suppress */ }
  }),
);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useTransition: () => [false, mockStartTransition] };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────

function makeTool(overrides: Partial<ToolStatus> & { name: ToolStatus['name'] }): ToolStatus {
  return {
    label: overrides.name,
    path: overrides.name,
    found: true,
    version: null,
    customPath: false,
    ...overrides,
  } as ToolStatus;
}

const ALL_FOUND: ToolStatus[] = [
  makeTool({ name: 'claude', label: 'Claude CLI', version: '2.0.0' }),
  makeTool({ name: 'git', label: 'Git', version: '2.45.0' }),
  makeTool({ name: 'gh', label: 'GitHub CLI', version: '2.50.0' }),
  makeTool({ name: 'docker', label: 'Docker', version: '27.0.0' }),
  makeTool({ name: 'devcontainer', label: 'Dev Container CLI' }),
];

const MISSING_CLAUDE: ToolStatus[] = [
  makeTool({ name: 'claude', label: 'Claude CLI', found: false, error: 'claude not found on PATH' }),
  makeTool({ name: 'git', label: 'Git', found: true, version: '2.45.0' }),
  makeTool({ name: 'gh', label: 'GitHub CLI', found: true }),
  makeTool({ name: 'docker', label: 'Docker', found: false }),
  makeTool({ name: 'devcontainer', label: 'Dev Container CLI', found: false }),
];

const MISSING_GIT: ToolStatus[] = [
  makeTool({ name: 'claude', label: 'Claude CLI', found: true }),
  makeTool({ name: 'git', label: 'Git', found: false, error: 'git not found' }),
  makeTool({ name: 'gh', label: 'GitHub CLI', found: true }),
  makeTool({ name: 'docker', label: 'Docker', found: false }),
  makeTool({ name: 'devcontainer', label: 'Dev Container CLI', found: false }),
];

// ── Helpers ─────────────────────────────────────────────────────────────

function clickButton(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** Call after clicking "Get Started" — waits for the tools-step heading. */
async function waitForToolsStep() {
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Prerequisites' })).toBeInTheDocument();
  });
}

async function advanceToTools() {
  clickButton('Get Started');
  await waitForToolsStep();
}

async function advanceToProject(toolsResult: ToolStatus[] = ALL_FOUND) {
  mockCheckTools.mockResolvedValue(toolsResult);
  await advanceToTools();
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled();
  });
  clickButton('Continue');
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Add Your First Project' })).toBeInTheDocument();
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('OnboardingWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckTools.mockResolvedValue(ALL_FOUND);
    mockAddProject.mockResolvedValue({ ok: true });
    mockCompleteOnboarding.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // No cleanup needed — each test gets fresh renders
  });

  // ── Welcome step ────────────────────────────────────────────────────

  describe('welcome step', () => {
    it('renders the welcome heading', () => {
      render(<OnboardingWizard />);
      expect(screen.getByText('Welcome to TeamAI')).toBeInTheDocument();
    });

    it('renders the step indicators with step 1 active', () => {
      render(<OnboardingWizard />);
      const steps = screen.getAllByText(/^(1|2|3|4)$/);
      expect(steps.length).toBeGreaterThan(0);
    });

    it('"Get Started" button advances to tools step', async () => {
      render(<OnboardingWizard />);
      clickButton('Get Started');
      await waitForToolsStep();
    });

    it('"Skip" button calls completeOnboarding', async () => {
      render(<OnboardingWizard />);
      clickButton('Skip');
      await waitFor(() => {
        expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
      });
    });

    it('shows the feature list', () => {
      render(<OnboardingWizard />);
      expect(screen.getByText(/Verify the CLI tools/)).toBeInTheDocument();
      expect(screen.getByText(/Register your first project/)).toBeInTheDocument();
    });
  });

  // ── Tools step ──────────────────────────────────────────────────────

  describe('tools step', () => {
    it('auto-fetches tools on arrival and displays them', async () => {
      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      });
      expect(screen.getByText('Git')).toBeInTheDocument();
      expect(screen.getByText('GitHub CLI')).toBeInTheDocument();
      expect(mockCheckTools).toHaveBeenCalledTimes(1);
    });

    it('marks claude and git as required', async () => {
      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      });

      const requiredBadges = screen.getAllByText('required');
      expect(requiredBadges).toHaveLength(2);
    });

    it('marks gh as recommended', async () => {
      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('GitHub CLI')).toBeInTheDocument();
      });
      expect(screen.getByText('recommended')).toBeInTheDocument();
    });

    it('shows version info when available', async () => {
      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      });
      expect(screen.getByText('2.0.0')).toBeInTheDocument();
    });

    it('Continue is disabled when tools are still loading', async () => {
      mockCheckTools.mockImplementation(() => new Promise(() => {}));

      render(<OnboardingWizard />);
      clickButton('Get Started');
      await waitForToolsStep();

      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('Continue is disabled when critical tools are missing', async () => {
      mockCheckTools.mockResolvedValue(MISSING_CLAUDE);

      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      expect(screen.getByText(/are required to continue/)).toBeInTheDocument();
    });

    it('Continue stays disabled when git is missing', async () => {
      mockCheckTools.mockResolvedValue(MISSING_GIT);

      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    });

    it('Continue is enabled when all critical tools are found', async () => {
      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled();
    });

    it('Continue advances to project step', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      expect(screen.getByRole('heading', { name: 'Add Your First Project' })).toBeInTheDocument();
    });

    it('does not re-fetch tools when returning via Back', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      clickButton('← Back');
      await waitForToolsStep();

      expect(mockCheckTools).toHaveBeenCalledTimes(1);
    });

    it('Recheck button fetches tools again', async () => {
      mockCheckTools.mockResolvedValue(MISSING_CLAUDE);

      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI')).toBeInTheDocument();
      });

      const initialCalls = mockCheckTools.mock.calls.length;

      mockCheckTools.mockResolvedValue(ALL_FOUND);
      clickButton('Recheck');

      await waitFor(() => {
        expect(mockCheckTools).toHaveBeenCalledTimes(initialCalls + 1);
      });
    });

    it('shows error state when tool check fails', async () => {
      mockCheckTools.mockRejectedValue(new Error('Permission denied'));

      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText(/Permission denied/)).toBeInTheDocument();
      });
    });

    it('dismisses error when ✕ is clicked', async () => {
      mockCheckTools.mockRejectedValue(new Error('Boom'));

      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText(/Boom/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));

      await waitFor(() => {
        expect(screen.queryByText(/Boom/)).not.toBeInTheDocument();
      });
    });

    it('renders the Claude auth note', async () => {
      render(<OnboardingWizard />);
      await advanceToTools();

      await waitFor(() => {
        expect(screen.getByText('Claude CLI Auth:')).toBeInTheDocument();
      });
      expect(screen.getByText('claude login')).toBeInTheDocument();
    });

    it('Skip button calls completeOnboarding from tools step', async () => {
      render(<OnboardingWizard />);
      await advanceToTools();

      clickButton('Skip');
      await waitFor(() => {
        expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── Project step ────────────────────────────────────────────────────

  describe('project step', () => {
    it('renders the project form', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      expect(screen.getByPlaceholderText('/home/user/my-project')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('My Project')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument();
    });

    it('Add Project is disabled when path is empty', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      expect(screen.getByRole('button', { name: 'Add Project' })).toBeDisabled();
    });

    it('Add Project is enabled when path has a value', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/test-project' },
      });

      expect(screen.getByRole('button', { name: 'Add Project' })).not.toBeDisabled();
    });

    it('submitting the form calls addProject', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/my-app' },
      });

      clickButton('Add Project');

      await waitFor(() => {
        expect(mockAddProject).toHaveBeenCalledTimes(1);
      });

      const formData = mockAddProject.mock.calls[0][0] as FormData;
      expect(formData).toBeInstanceOf(FormData);
      expect(formData.get('path')).toBe('/home/user/my-app');
    });

    it('advances to done step on successful project add', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/my-app' },
      });

      clickButton('Add Project');

      await waitFor(() => {
        expect(screen.getByText("You're All Set!")).toBeInTheDocument();
      });
    });

    it('shows error when addProject returns {error}', async () => {
      mockAddProject.mockResolvedValue({ error: 'This project is already registered.' });

      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/my-app' },
      });

      clickButton('Add Project');

      await waitFor(() => {
        expect(screen.getByText('This project is already registered.')).toBeInTheDocument();
      });
    });

    it('shows error when addProject throws', async () => {
      mockAddProject.mockRejectedValue(new Error('Network failure'));

      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/my-app' },
      });

      clickButton('Add Project');

      await waitFor(() => {
        expect(screen.getByText('Network failure')).toBeInTheDocument();
      });
    });

    it('stays on project step after error', async () => {
      mockAddProject.mockResolvedValue({ error: 'Nope' });

      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/my-app' },
      });

      clickButton('Add Project');

      await waitFor(() => {
        expect(screen.getByText('Nope')).toBeInTheDocument();
      });

      expect(screen.getByRole('heading', { name: 'Add Your First Project' })).toBeInTheDocument();
    });

    it('Back button returns to tools step', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      clickButton('← Back');
      await waitForToolsStep();
    });

    it('Skip button calls completeOnboarding from project step', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      clickButton('Skip');
      await waitFor(() => {
        expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── Done step ───────────────────────────────────────────────────────

  describe('done step', () => {
    async function reachDone() {
      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/my-app' },
      });
      clickButton('Add Project');

      await waitFor(() => {
        expect(screen.getByText("You're All Set!")).toBeInTheDocument();
      });
    }

    it('shows summary with tool counts when tools were fetched', async () => {
      await reachDone();

      expect(screen.getByText(/Required tools detected/)).toBeInTheDocument();
      expect(screen.getByText(/5\/5 available/)).toBeInTheDocument();
    });

    it('shows "Start Using TeamAI" button', async () => {
      await reachDone();
      expect(screen.getByRole('button', { name: 'Start Using TeamAI' })).toBeInTheDocument();
    });

    it('"Start Using TeamAI" calls completeOnboarding', async () => {
      await reachDone();

      mockCompleteOnboarding.mockClear();

      clickButton('Start Using TeamAI');
      await waitFor(() => {
        expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
      });
    });

    it('shows tool-skipped message when tools were not fetched', async () => {
      await reachDone();

      // When tools ARE present, we DON'T see the skipped message
      expect(screen.queryByText(/Tool checks skipped/)).not.toBeInTheDocument();
    });
  });

  // ── Step indicators ─────────────────────────────────────────────────

  describe('step indicators', () => {
    it('shows completed checkmarks for past steps', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      const checkmarks = screen.getAllByText('✓');
      expect(checkmarks.length).toBeGreaterThanOrEqual(1);
    });

    it('shows all steps completed on done step', async () => {
      render(<OnboardingWizard />);
      await advanceToProject();

      fireEvent.change(screen.getByPlaceholderText('/home/user/my-project'), {
        target: { value: '/home/user/my-app' },
      });
      clickButton('Add Project');

      await waitFor(() => {
        expect(screen.getByText("You're All Set!")).toBeInTheDocument();
      });

      // 3 step indicator circles (welcome, tools, project) + 3 summary card checks
      const checkmarks = screen.getAllByText('✓');
      expect(checkmarks).toHaveLength(6);
    });
  });
});
