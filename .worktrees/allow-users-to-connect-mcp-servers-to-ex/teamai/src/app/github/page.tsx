import { GitHubImport } from '@/components/github-import';

export const metadata = {
  title: 'GitHub Issues — TeamAI',
};

export default async function GitHubPage() {
  return <GitHubImport />;
}
