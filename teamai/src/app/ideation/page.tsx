import { IdeationScanner } from '@/components/ideation-scanner';

export default function IdeationPage() {
  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900">
      <div className="shrink-0 px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <h1 className="text-base font-semibold text-slate-900 dark:text-white">Ideation</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Scan the codebase for improvements, vulnerabilities, and tech debt.
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <IdeationScanner />
      </div>
    </div>
  );
}
