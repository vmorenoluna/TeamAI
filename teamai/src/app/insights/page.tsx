import { InsightsChat } from '@/components/insights-chat';

export default function InsightsPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 py-4 border-b border-[#1e293b]">
        <h1 className="text-base font-semibold text-white">Insights</h1>
        <p className="text-xs text-slate-400 mt-0.5">Chat with Claude about the active project.</p>
      </div>
      <div className="flex-1 min-h-0">
        <InsightsChat />
      </div>
    </div>
  );
}
