import { IdeationScanner } from '@/components/ideation-scanner';

export default function IdeationPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 py-4 border-b border-[#1e293b] bg-[#11131b]">
        <h1 className="text-base font-semibold text-white">Ideation</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Scan the codebase for improvements, vulnerabilities, and tech debt.
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <IdeationScanner />
      </div>
    </div>
  );
}
