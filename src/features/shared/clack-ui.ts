interface ClackLog {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ClackUi {
  intro(message?: string): void;
  outro(message?: string): void;
  note(message: string, title?: string): void;
  log: ClackLog;
}

export type LoadClackUi = () => Promise<ClackUi>;
