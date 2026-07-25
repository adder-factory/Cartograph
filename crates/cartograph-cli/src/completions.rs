use std::collections::BTreeSet;

use clap::{Command, ValueEnum};

#[derive(Clone, Copy, Debug, ValueEnum)]
pub(super) enum CompletionShell {
    Bash,
    Zsh,
    Fish,
    Powershell,
}

pub(super) fn render_script(shell: CompletionShell) -> &'static str {
    match shell {
        CompletionShell::Bash => {
            r#"# cartograph shell completion for bash
_cartograph_completion() {
  local completions
  completions="$(command cartograph __complete "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)" || return 0
  COMPREPLY=($(compgen -W "$completions" -- "${COMP_WORDS[COMP_CWORD]}"))
}

complete -o default -F _cartograph_completion cartograph
"#
        }
        CompletionShell::Zsh => {
            r#"#compdef cartograph
# cartograph shell completion for zsh
_cartograph_completion() {
  local -a completions
  local candidate
  while IFS= read -r candidate; do
    completions+=("$candidate")
  done < <(command cartograph __complete "${words[@]:1}" 2>/dev/null)
  compadd -- "${completions[@]}"
}

_cartograph_completion "$@"
"#
        }
        CompletionShell::Fish => {
            r#"# cartograph shell completion for fish
function __cartograph_complete
  set -l tokens (commandline -opc)
  if test (count $tokens) -gt 0
    set tokens $tokens[2..-1]
  end
  command cartograph __complete $tokens 2>/dev/null
end

complete -c cartograph -f -a "(__cartograph_complete)"
"#
        }
        CompletionShell::Powershell => {
            r#"# cartograph shell completion for PowerShell
Register-ArgumentCompleter -Native -CommandName cartograph -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($words.Count -le 1) { $words = @() } else { $words = $words[1..($words.Count - 1)] }
  $completions = & cartograph __complete @words 2>$null
  foreach ($completion in $completions) {
    [System.Management.Automation.CompletionResult]::new($completion, $completion, 'ParameterValue', $completion)
  }
}
"#
        }
    }
}

pub(super) fn complete(command: &Command, words: &[String]) -> Vec<String> {
    let words = words
        .strip_prefix(&["cartograph".to_owned()])
        .unwrap_or(words);
    let current = words.last().map_or("", String::as_str);
    let previous = words
        .get(..words.len().saturating_sub(1))
        .unwrap_or_default();
    let selected = resolve_command(command, previous);
    if let Some(choices) = option_choices(selected, previous.last().map(String::as_str)) {
        return filter(choices, current);
    }
    let mut candidates = BTreeSet::new();
    if !current.starts_with('-') {
        for subcommand in selected.get_subcommands() {
            if subcommand.is_hide_set() || subcommand.get_name().starts_with("__") {
                continue;
            }
            candidates.insert(subcommand.get_name().to_owned());
            for alias in subcommand.get_all_aliases() {
                candidates.insert(alias.to_owned());
            }
        }
    }
    candidates.insert("--help".to_owned());
    for argument in selected.get_arguments() {
        if argument.is_hide_set() {
            continue;
        }
        if let Some(long) = argument.get_long() {
            candidates.insert(format!("--{long}"));
        }
        if let Some(short) = argument.get_short() {
            candidates.insert(format!("-{short}"));
        }
    }
    filter(candidates, current)
}

fn resolve_command<'command>(
    mut command: &'command Command,
    words: &[String],
) -> &'command Command {
    for word in words {
        if word == "--" {
            break;
        }
        if word.starts_with('-') {
            continue;
        }
        let Some(next) = command.get_subcommands().find(|candidate| {
            candidate.get_name() == word || candidate.get_all_aliases().any(|alias| alias == word)
        }) else {
            break;
        };
        command = next;
    }
    command
}

fn option_choices(command: &Command, previous: Option<&str>) -> Option<BTreeSet<String>> {
    let previous = previous?.strip_prefix('-')?.trim_start_matches('-');
    let argument = command.get_arguments().find(|argument| {
        argument.get_long() == Some(previous)
            || argument
                .get_short()
                .is_some_and(|short| previous == short.to_string())
    })?;
    let values = argument
        .get_value_parser()
        .possible_values()?
        .map(|value| value.get_name().to_owned())
        .collect::<BTreeSet<_>>();
    (!values.is_empty()).then_some(values)
}

fn filter(candidates: BTreeSet<String>, current: &str) -> Vec<String> {
    candidates
        .into_iter()
        .filter(|candidate| current.is_empty() || candidate.starts_with(current))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{Arg, Command};

    #[test]
    fn dynamic_completion_routes_subcommands_options_and_enum_values() {
        let command = Command::new("cartograph").subcommand(
            Command::new("find").arg(Arg::new("by").long("by").value_parser(["name", "content"])),
        );
        assert_eq!(complete(&command, &[String::new()]), vec!["--help", "find"]);
        assert_eq!(
            complete(&command, &["find".to_owned(), "--b".to_owned()]),
            vec!["--by"]
        );
        assert_eq!(
            complete(
                &command,
                &["find".to_owned(), "--by".to_owned(), "n".to_owned()]
            ),
            vec!["name"]
        );
    }
}
