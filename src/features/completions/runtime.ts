export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export interface CompletionOptionLike {
  short?: string | undefined;
  long?: string | undefined;
  hidden?: boolean | undefined;
  required?: boolean | undefined;
  optional?: boolean | undefined;
  argChoices?: string[] | undefined;
}

export interface CompletionCommandLike {
  commands: readonly CompletionCommandLike[];
  options: readonly CompletionOptionLike[];
  name(): string;
  aliases?(): string[];
}

export function parseCompletionShell(value: string): CompletionShell | null {
  return COMPLETION_SHELLS.includes(value as CompletionShell) ? (value as CompletionShell) : null;
}

export function completionShellList(): string {
  return COMPLETION_SHELLS.join(', ');
}

export function completeWords(program: CompletionCommandLike, rawWords: readonly string[]): string[] {
  const words = stripProgramName(rawWords);
  const current = words.at(-1) ?? '';
  const previousWords = words.length === 0 ? [] : words.slice(0, -1);
  const command = resolveCompletionCommand(program, previousWords);

  const valueChoices = optionValueChoices(command, previousWords.at(-1));
  if (valueChoices) return filterCandidates(valueChoices, current);

  const commands = commandNames(command);
  const options = optionNames(command);
  const candidates = current.startsWith('-') ? options : [...commands, ...options];
  return filterCandidates(candidates, current);
}

export function renderCompletionScript(shell: CompletionShell, commandName = 'cartograph'): string {
  switch (shell) {
    case 'bash':
      return renderBashCompletion(commandName);
    case 'zsh':
      return renderZshCompletion(commandName);
    case 'fish':
      return renderFishCompletion(commandName);
    case 'powershell':
      return renderPowerShellCompletion(commandName);
  }
}

function stripProgramName(words: readonly string[]): readonly string[] {
  return words[0] === 'cartograph' ? words.slice(1) : words;
}

function resolveCompletionCommand(program: CompletionCommandLike, words: readonly string[]): CompletionCommandLike {
  let command = program;
  for (const word of words) {
    if (word === '--') break;
    if (word.startsWith('-')) continue;
    const subcommand = findSubcommand(command, word);
    if (!subcommand) break;
    command = subcommand;
  }
  return command;
}

function findSubcommand(command: CompletionCommandLike, name: string): CompletionCommandLike | undefined {
  return command.commands.find((subcommand) => {
    if (subcommand.name() === name) return true;
    return subcommand.aliases?.().includes(name) === true;
  });
}

function commandNames(command: CompletionCommandLike): string[] {
  const names: string[] = [];
  for (const subcommand of command.commands) {
    const name = subcommand.name();
    if (name === 'help' || name.startsWith('__')) continue;
    names.push(name, ...(subcommand.aliases?.() ?? []));
  }
  return names;
}

function optionNames(command: CompletionCommandLike): string[] {
  const names = ['--help'];
  for (const option of command.options) {
    if (option.hidden) continue;
    if (option.long) names.push(option.long);
    if (option.short) names.push(option.short);
  }
  return names;
}

function optionValueChoices(command: CompletionCommandLike, previous: string | undefined): string[] | null {
  if (!previous?.startsWith('-')) return null;
  const option = command.options.find((candidate) => previous === candidate.long || previous === candidate.short);
  if (!option || (!option.required && !option.optional)) return null;
  return option.argChoices && option.argChoices.length > 0 ? option.argChoices : null;
}

function filterCandidates(candidates: readonly string[], current: string): string[] {
  return [...new Set(candidates)]
    .filter((candidate) => candidate.length > 0)
    .filter((candidate) => current.length === 0 || candidate.startsWith(current))
    .sort((a, b) => a.localeCompare(b));
}

function renderBashCompletion(commandName: string): string {
  return `# ${commandName} shell completion for bash
_cartograph_completion() {
  local completions
  completions="$(command ${commandName} __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)" || return 0
  COMPREPLY=($(compgen -W "$completions" -- "\${COMP_WORDS[COMP_CWORD]}"))
}

complete -o default -F _cartograph_completion ${commandName}
`;
}

function renderZshCompletion(commandName: string): string {
  return `#compdef ${commandName}
# ${commandName} shell completion for zsh
_cartograph_completion() {
  local -a completions
  local candidate
  while IFS= read -r candidate; do
    completions+=("$candidate")
  done < <(command ${commandName} __complete "\${words[@]:1}" 2>/dev/null)
  compadd -- "\${completions[@]}"
}

_cartograph_completion "$@"
`;
}

function renderFishCompletion(commandName: string): string {
  return `# ${commandName} shell completion for fish
function __cartograph_complete
  set -l tokens (commandline -opc)
  if test (count $tokens) -gt 0
    set tokens $tokens[2..-1]
  end
  command ${commandName} __complete $tokens 2>/dev/null
end

complete -c ${commandName} -f -a "(__cartograph_complete)"
`;
}

function renderPowerShellCompletion(commandName: string): string {
  return `# ${commandName} shell completion for PowerShell
Register-ArgumentCompleter -Native -CommandName ${commandName} -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $words = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($words.Count -le 1) {
    $words = @()
  } else {
    $words = $words[1..($words.Count - 1)]
  }

  $completions = & ${commandName} __complete @words 2>$null
  foreach ($completion in $completions) {
    [System.Management.Automation.CompletionResult]::new($completion, $completion, 'ParameterValue', $completion)
  }
}
`;
}
