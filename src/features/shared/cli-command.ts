export interface CliCommand {
  command(name: string): CliCommand;
  description(text: string): CliCommand;
  action(fn: (...args: any[]) => unknown): CliCommand;
}

export interface CliOptionCommand extends CliCommand {
  command(name: string, opts?: { hidden?: boolean }): CliOptionCommand;
  description(text: string): CliOptionCommand;
  option(...args: unknown[]): CliOptionCommand;
  addHelpText?(position: string, text: string): CliOptionCommand;
  alias?(name: string): CliOptionCommand;
  action(fn: (...args: any[]) => unknown): CliOptionCommand;
}

export interface CliArgumentOptionCommand extends CliOptionCommand {
  command(name: string): CliArgumentOptionCommand;
  description(text: string): CliArgumentOptionCommand;
  argument(...args: unknown[]): CliArgumentOptionCommand;
  option(...args: unknown[]): CliArgumentOptionCommand;
  action(fn: (...args: any[]) => unknown): CliArgumentOptionCommand;
}

export interface CliRequiredOptionCommand extends CliOptionCommand {
  command(name: string): CliRequiredOptionCommand;
  description(text: string): CliRequiredOptionCommand;
  option(...args: unknown[]): CliRequiredOptionCommand;
  requiredOption(...args: unknown[]): CliRequiredOptionCommand;
  action(fn: (...args: any[]) => unknown): CliRequiredOptionCommand;
}
