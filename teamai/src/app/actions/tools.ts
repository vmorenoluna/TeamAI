'use server';

import { revalidatePath } from 'next/cache';
import { checkAllTools, setToolPath, clearToolPath, checkTool, type ToolName, type ToolStatus } from '@/lib/tool-checker';

export async function checkTools(): Promise<ToolStatus[]> {
  return await checkAllTools();
}

export async function updateToolPath(name: ToolName, binaryPath: string): Promise<ToolStatus> {
  setToolPath(name, binaryPath);
  revalidatePath('/', 'layout');
  return await checkTool(name);
}

export async function resetToolPath(name: ToolName): Promise<ToolStatus> {
  clearToolPath(name);
  revalidatePath('/', 'layout');
  return await checkTool(name);
}
