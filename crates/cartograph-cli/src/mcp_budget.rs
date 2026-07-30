use std::collections::BTreeSet;

use cartograph_mcp::{ToolDefinition, ToolProfile};
use num_traits::ToPrimitive as _;
use serde::Serialize;

const TOKEN_CHARACTER_ESTIMATE: usize = 4;
const TOOL_COUNT_LIMIT: usize = 37;
const TOOLS_LIST_CHARACTER_LIMIT: usize = 65_000;
const COMBINED_CHARACTER_LIMIT: usize = 68_000;
const TOOLS_LIST_CHARACTER_TARGET: usize = 62_500;
const COMBINED_CHARACTER_TARGET: usize = 65_500;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadMetric {
    chars: usize,
    estimated_tokens: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Contributor {
    name: String,
    chars: usize,
    estimated_tokens: usize,
    share_of_tools_list: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    tool_count: usize,
    tools_list_chars: usize,
    combined_chars: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpBudgetReport {
    profile: String,
    write_tools: bool,
    disabled_tools: Vec<String>,
    tool_count: usize,
    tools_list: LoadMetric,
    initialize: LoadMetric,
    combined_startup: LoadMetric,
    full_playbook: LoadMetric,
    limits: Limits,
    targets: Limits,
    top_schema_contributors: Vec<Contributor>,
}

pub(super) struct McpBudgetInput<'value> {
    pub(super) definitions: Vec<ToolDefinition>,
    pub(super) profile: ToolProfile,
    pub(super) read_only_only: bool,
    pub(super) disabled: &'value [String],
    pub(super) top: usize,
    pub(super) instructions: &'value str,
    pub(super) playbook: &'value str,
}

pub(super) fn measure(input: McpBudgetInput<'_>) -> Result<McpBudgetReport, String> {
    let McpBudgetInput {
        definitions,
        profile,
        read_only_only,
        disabled,
        top,
        instructions,
        playbook,
    } = input;
    let disabled_set = disabled.iter().map(String::as_str).collect::<BTreeSet<_>>();
    let mut tools = definitions
        .into_iter()
        .filter(|definition| definition.included_in(profile))
        .filter(|definition| !disabled_set.contains(definition.name()))
        .filter(|definition| {
            !read_only_only
                || definition
                    .annotations()
                    .is_some_and(|annotations| annotations.read_only_hint == Some(true))
                || definition.has_read_only_carve_out()
        })
        .collect::<Vec<_>>();
    tools.sort_by(|left, right| left.name().cmp(right.name()));
    let tools_value = serde_json::json!({"tools": &tools});
    let tools_list_chars = serde_json::to_string(&tools_value)
        .map_err(|_| "could not measure MCP tools/list".to_owned())?
        .len();
    let initialize_chars = serde_json::to_string(&serde_json::json!({
        "instructions": instructions
    }))
    .map_err(|_| "could not measure MCP initialize payload".to_owned())?
    .len();
    let playbook_chars = serde_json::to_string(&serde_json::json!({
        "instructions": playbook
    }))
    .map_err(|_| "could not measure MCP playbook payload".to_owned())?
    .len();
    let mut contributors = tools
        .iter()
        .map(|definition| {
            let chars = serde_json::to_string(definition).map_or(0, |value| value.len());
            Contributor {
                name: definition.name().to_owned(),
                chars,
                estimated_tokens: estimate_tokens(chars),
                share_of_tools_list: if tools_list_chars == 0 {
                    0.0
                } else {
                    chars.to_f64().unwrap_or(f64::MAX)
                        / tools_list_chars.to_f64().unwrap_or(f64::MAX)
                        * 100.0
                },
            }
        })
        .collect::<Vec<_>>();
    contributors.sort_by(|left, right| {
        right
            .chars
            .cmp(&left.chars)
            .then(left.name.cmp(&right.name))
    });
    contributors.truncate(top);
    Ok(McpBudgetReport {
        profile: profile_name(profile).to_owned(),
        write_tools: !read_only_only,
        disabled_tools: disabled_set.into_iter().map(str::to_owned).collect(),
        tool_count: tools.len(),
        tools_list: metric(tools_list_chars),
        initialize: metric(initialize_chars),
        combined_startup: metric(tools_list_chars.saturating_add(initialize_chars)),
        full_playbook: metric(playbook_chars),
        limits: Limits {
            tool_count: TOOL_COUNT_LIMIT,
            tools_list_chars: TOOLS_LIST_CHARACTER_LIMIT,
            combined_chars: COMBINED_CHARACTER_LIMIT,
        },
        targets: Limits {
            tool_count: TOOL_COUNT_LIMIT,
            tools_list_chars: TOOLS_LIST_CHARACTER_TARGET,
            combined_chars: COMBINED_CHARACTER_TARGET,
        },
        top_schema_contributors: contributors,
    })
}

pub(super) fn render(report: &McpBudgetReport) -> String {
    let disabled = if report.disabled_tools.is_empty() {
        "none".to_owned()
    } else {
        report.disabled_tools.join(", ")
    };
    let mut lines = vec![
        "MCP Load Budget".to_owned(),
        String::new(),
        format!("Profile: {}", report.profile),
        format!(
            "Write tools: {}",
            if report.write_tools {
                "enabled"
            } else {
                "disabled"
            }
        ),
        format!("Disabled tools: {disabled}"),
        "Token counts are estimated as characters / 4.".to_owned(),
        String::new(),
        "| Payload | Chars | Est. tokens |".to_owned(),
        "|---|---:|---:|".to_owned(),
        format!(
            "| tools/list ({} tools) | {} | ~{} |",
            report.tool_count, report.tools_list.chars, report.tools_list.estimated_tokens
        ),
        format!(
            "| initialize instructions | {} | ~{} |",
            report.initialize.chars, report.initialize.estimated_tokens
        ),
        format!(
            "| combined startup load | {} | ~{} |",
            report.combined_startup.chars, report.combined_startup.estimated_tokens
        ),
        format!(
            "| full playbook (on demand) | {} | ~{} |",
            report.full_playbook.chars, report.full_playbook.estimated_tokens
        ),
        String::new(),
        format!(
            "Hard guard: <= {} tools, <= {} tools/list chars, <= {} combined startup chars.",
            report.limits.tool_count, report.limits.tools_list_chars, report.limits.combined_chars
        ),
        format!(
            "Release target: <= {} tools/list chars, <= {} combined startup chars.",
            report.targets.tools_list_chars, report.targets.combined_chars
        ),
        String::new(),
        format!(
            "Top schema contributors ({}):",
            report.top_schema_contributors.len()
        ),
        "| Tool | Chars | Est. tokens | Share of tools/list |".to_owned(),
        "|---|---:|---:|---:|".to_owned(),
    ];
    for contributor in &report.top_schema_contributors {
        lines.push(format!(
            "| {} | {} | ~{} | {:.1}% |",
            contributor.name,
            contributor.chars,
            contributor.estimated_tokens,
            contributor.share_of_tools_list
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}

const fn metric(chars: usize) -> LoadMetric {
    LoadMetric {
        chars,
        estimated_tokens: estimate_tokens(chars),
    }
}

const fn estimate_tokens(chars: usize) -> usize {
    chars.saturating_add(TOKEN_CHARACTER_ESTIMATE - 1) / TOKEN_CHARACTER_ESTIMATE
}

const fn profile_name(profile: ToolProfile) -> &'static str {
    match profile {
        ToolProfile::Full => "full",
        ToolProfile::Core => "core",
        ToolProfile::Coding => "coding",
        ToolProfile::ReadOnly => "read-only",
        ToolProfile::Review => "review",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cartograph_mcp::{ToolDefinitionInput, ToolProfiles};

    #[test]
    fn budget_filters_profiles_write_tools_and_exact_disabled_names() {
        let read = ToolDefinition::new(
            ToolDefinitionInput::new(
                "cartograph_read",
                "Read evidence.",
                serde_json::json!({"type":"object","properties":{}}),
            )
            .with_profiles(ToolProfiles::CORE),
        )
        .unwrap_or_else(|error| panic!("read contract failed: {error}"))
        .with_annotations(cartograph_mcp::ToolAnnotations {
            read_only_hint: Some(true),
            ..cartograph_mcp::ToolAnnotations::default()
        });
        let write = ToolDefinition::new(
            ToolDefinitionInput::new(
                "cartograph_write",
                "Write evidence.",
                serde_json::json!({"type":"object","properties":{}}),
            )
            .with_profiles(ToolProfiles::CORE),
        )
        .unwrap_or_else(|error| panic!("write contract failed: {error}"));
        let report = measure(McpBudgetInput {
            definitions: vec![read.clone(), write],
            profile: ToolProfile::Core,
            read_only_only: true,
            disabled: &[],
            top: 10,
            instructions: "instructions",
            playbook: "playbook",
        })
        .unwrap_or_else(|error| panic!("budget failed: {error}"));
        assert_eq!(report.tool_count, 1);
        let disabled_names = ["cartograph_read".to_owned()];
        let disabled = measure(McpBudgetInput {
            definitions: vec![read],
            profile: ToolProfile::Core,
            read_only_only: false,
            disabled: &disabled_names,
            top: 10,
            instructions: "instructions",
            playbook: "playbook",
        })
        .unwrap_or_else(|error| panic!("disabled budget failed: {error}"));
        assert_eq!(disabled.tool_count, 0);
    }
}
