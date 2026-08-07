'use server';

import { completeOnboarding as persistOnboarding } from '@/lib/onboarding';
import { revalidatePath } from 'next/cache';

export async function completeOnboarding(): Promise<void> {
  persistOnboarding();
  revalidatePath('/', 'layout');
}
