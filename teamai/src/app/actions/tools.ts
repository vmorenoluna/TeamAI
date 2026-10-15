'use server';

import { checkAllTools, setToolPath, clearToolPath, checkTool, type ToolName, type ToolStatus } from '@/lib/tool-checker';

export async function checkTools(): Promise<ToolStatus[]> {
  return await checkAllTools();
}

export async function updateToolPath(name: ToolName, binaryPath: string): Promise<ToolStatus> {
  setToolPath(name, binaryPath);
  return await checkTool(name);
}

export async function resetToolPath(name: ToolName): Promise<ToolStatus> {
  clearToolPath(name);
  return await checkTool(name);
}
