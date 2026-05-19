import { AnalyticsDashboard } from '@/components/analytics-dashboard';

export default function AnalyticsPage() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Analytics</h1>
        <p className="text-sm text-slate-400 mt-1">
          Agent performance, pipeline bottlenecks, and QA trends
        </p>
      </div>
      <AnalyticsDashboard />
    </div>
  );
}
