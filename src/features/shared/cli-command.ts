type CliActionHandler<Args extends unknown[]> = (...args: Args) => unknown;

export interface CliCommand {
  command(name: string): CliCommand;
  description(text: string): CliCommand;
  action<Args extends unknown[]>(fn: CliActionHandler<Args>): CliCommand;
}

export interface CliOptionCommand extends CliCommand {
  command(name: string, opts?: { hidden?: boolean }): CliOptionCommand;
  description(text: string): CliOptionCommand;
  option(...args: unknown[]): CliOptionCommand;
  addHelpText?(position: string, text: string): CliOptionCommand;
  alias?(name: string): CliOptionCommand;
  action<Args extends unknown[]>(fn: CliActionHandler<Args>): CliOptionCommand;
}

export interface CliArgumentOptionCommand extends CliOptionCommand {
  command(name: string): CliArgumentOptionCommand;
  description(text: string): CliArgumentOptionCommand;
  argument(...args: unknown[]): CliArgumentOptionCommand;
  option(...args: unknown[]): CliArgumentOptionCommand;
  action<Args extends unknown[]>(fn: CliActionHandler<Args>): CliArgumentOptionCommand;
}

export interface CliRequiredOptionCommand extends CliOptionCommand {
  command(name: string): CliRequiredOptionCommand;
  description(text: string): CliRequiredOptionCommand;
  option(...args: unknown[]): CliRequiredOptionCommand;
  requiredOption(...args: unknown[]): CliRequiredOptionCommand;
  action<Args extends unknown[]>(fn: CliActionHandler<Args>): CliRequiredOptionCommand;
}
