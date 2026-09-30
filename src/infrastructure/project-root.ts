import { realpath } from "node:fs/promises";
import path from "node:path";

export async function normalizeProjectRoot(projectRootInput: string): Promise<string> {
  const absolutePath = path.resolve(projectRootInput);
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}
