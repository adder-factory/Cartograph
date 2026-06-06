import * as path from 'node:path';

export function resolveInitProjectPath(pathArg: string | undefined, cwd = process.cwd()): string {
  return path.resolve(pathArg || cwd);
}

export function shouldConfirmUninit(answer: string): boolean {
  return answer.toLowerCase() === 'y';
}
