import { readFile, stat } from 'fs/promises';

/**
 * True only when the error means "the path does not exist" (ENOENT, or ENOTDIR
 * when a parent component is a file). Every other failure (EIO, EACCES, EMFILE…)
 * is a real read failure and must not be treated as absence.
 */
export function isMissing(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Read a UTF-8 file; null if it does not exist, rejects on any other error. */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** Whether a path exists; false if missing, rejects on any other error. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}
