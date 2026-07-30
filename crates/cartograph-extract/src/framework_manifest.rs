use std::ops::Range;

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolId, SymbolKind};
use toml_edit::{Document, Item, Table, Value};

use crate::{
    ExtractError,
    framework::{FrameworkBuilder, FrameworkReferenceInput, LandmarkInput},
};

const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES: usize = 4_096;
const MAX_JSON_NESTING: usize = 64;
const JSON_CANCEL_BYTES: usize = 4_096;

#[derive(Clone, Copy)]
struct CargoDependencyScan<'manifest> {
    owner: Option<&'manifest SymbolId>,
    source: &'manifest str,
    section: &'manifest str,
    table: &'manifest Table,
}

struct ManifestSpanInput<'manifest> {
    ecosystem: &'manifest str,
    value: &'manifest str,
    span: Range<usize>,
}

#[derive(Clone, Copy)]
struct JsonCompound {
    opening: u8,
    closing: u8,
    depth: usize,
}

pub(crate) fn scan(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
) -> Result<(), ExtractError> {
    if source.len() > MAX_MANIFEST_BYTES {
        return Ok(());
    }
    let filename = builder.path().rsplit('/').next().unwrap_or(builder.path());
    match (builder.language(), filename) {
        (SourceLanguage::Json, "package.json") => scan_json_manifest(builder, source, "npm"),
        (SourceLanguage::Json, "composer.json") => scan_json_manifest(builder, source, "composer"),
        (SourceLanguage::Toml, "Cargo.toml") => scan_cargo_manifest(builder, source),
        _ => Ok(()),
    }
}

fn scan_json_manifest(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
    ecosystem: &'static str,
) -> Result<(), ExtractError> {
    let members = parse_json_object(builder, source, 0..source.len())?;
    let name = members
        .iter()
        .find(|member| member.key == Some("name"))
        .and_then(|member| json_static_string(source, member.value.clone()));
    let workspace_sections = if ecosystem == "npm" {
        json_workspace_patterns(builder, source, &members)?
    } else {
        Vec::new()
    };
    if name.is_none() && workspace_sections.is_empty() {
        return Ok(());
    }
    let package_owner = if let Some((name, span)) = name.filter(|(name, _)| safe_package_name(name))
    {
        add_package(
            builder,
            ManifestSpanInput {
                ecosystem,
                value: name,
                span,
            },
        )?
    } else {
        None
    };
    let workspace_owner = if workspace_sections.is_empty() {
        None
    } else {
        add_workspace_owner(builder, ecosystem, source)?
    };
    let owner = package_owner.or(workspace_owner);

    let dependency_sections: &[&str] = if ecosystem == "npm" {
        &[
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ]
    } else {
        &["require", "require-dev"]
    };
    for section in dependency_sections {
        builder.check_cancelled()?;
        let Some(member) = members.iter().find(|member| member.key == Some(*section)) else {
            continue;
        };
        for dependency in parse_json_object(builder, source, member.value.clone())? {
            let Some(name) = dependency.key.filter(|name| safe_package_name(name)) else {
                continue;
            };
            add_dependency(
                builder,
                DependencyInput {
                    owner: owner.as_ref(),
                    ecosystem,
                    section,
                    name,
                    resolution_name: None,
                    span: dependency.key_span,
                },
            )?;
        }
    }
    for (pattern, span) in workspace_sections {
        add_workspace_pattern(
            builder,
            ManifestSpanInput {
                ecosystem,
                value: pattern,
                span,
            },
        )?;
    }
    Ok(())
}

fn scan_cargo_manifest(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
) -> Result<(), ExtractError> {
    builder.check_cancelled()?;
    let Ok(document) = Document::parse(source) else {
        return Ok(());
    };
    builder.check_cancelled()?;
    let package_name = document
        .get("package")
        .and_then(Item::as_table)
        .and_then(|package| package.get("name"))
        .and_then(Item::as_str)
        .filter(|name| safe_package_name(name));
    let package_span = package_name.and_then(|name| {
        document
            .get("package")
            .and_then(Item::as_table)
            .and_then(|package| package.get("name"))
            .and_then(Item::span)
            .and_then(|span| value_text_span(source, span, name))
    });
    let workspace = document.get("workspace").and_then(Item::as_table);
    let workspace_members = workspace
        .and_then(|workspace| workspace.get("members"))
        .and_then(Item::as_array)
        .map_or_else(Vec::new, |members| toml_string_array(source, members));
    let workspace_excludes = workspace
        .and_then(|workspace| workspace.get("exclude"))
        .and_then(Item::as_array)
        .map_or_else(Vec::new, |members| toml_string_array(source, members));
    if package_name.is_none() && workspace_members.is_empty() {
        return Ok(());
    }
    let package_owner = match (package_name, package_span) {
        (Some(name), Some(span)) => add_package(
            builder,
            ManifestSpanInput {
                ecosystem: "cargo",
                value: name,
                span,
            },
        )?,
        _ => None,
    };
    let workspace_owner = if workspace_members.is_empty() && workspace_excludes.is_empty() {
        None
    } else {
        add_workspace_owner(builder, "cargo", source)?
    };
    let owner = package_owner.or(workspace_owner);
    let scan = CargoManifestScan {
        source,
        document: &document,
        owner: owner.as_ref(),
    };
    scan_cargo_dependency_tables(builder, scan)?;
    scan_cargo_target_dependencies(builder, scan)?;
    add_cargo_workspace_entries(builder, workspace_members, workspace_excludes)?;
    Ok(())
}

#[derive(Clone, Copy)]
struct CargoManifestScan<'manifest, 'source> {
    source: &'source str,
    document: &'manifest Document<&'source str>,
    owner: Option<&'manifest SymbolId>,
}

fn scan_cargo_dependency_tables(
    builder: &mut FrameworkBuilder<'_, '_>,
    scan: CargoManifestScan<'_, '_>,
) -> Result<(), ExtractError> {
    for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(table) = scan.document.get(section).and_then(Item::as_table) {
            scan_cargo_dependencies(
                builder,
                CargoDependencyScan {
                    owner: scan.owner,
                    source: scan.source,
                    section,
                    table,
                },
            )?;
        }
    }
    if let Some(workspace) = scan.document.get("workspace").and_then(Item::as_table)
        && let Some(table) = workspace.get("dependencies").and_then(Item::as_table)
    {
        scan_cargo_dependencies(
            builder,
            CargoDependencyScan {
                owner: scan.owner,
                source: scan.source,
                section: "workspace.dependencies",
                table,
            },
        )?;
    }
    Ok(())
}

fn scan_cargo_target_dependencies(
    builder: &mut FrameworkBuilder<'_, '_>,
    scan: CargoManifestScan<'_, '_>,
) -> Result<(), ExtractError> {
    let Some(targets) = scan.document.get("target").and_then(Item::as_table) else {
        return Ok(());
    };
    for (target, target_item) in targets.iter().take(MAX_MANIFEST_ENTRIES) {
        builder.check_cancelled()?;
        let Some(target_table) = target_item.as_table() else {
            continue;
        };
        for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
            if let Some(table) = target_table.get(section).and_then(Item::as_table) {
                let scoped = format!("target.{target}.{section}");
                scan_cargo_dependencies(
                    builder,
                    CargoDependencyScan {
                        owner: scan.owner,
                        source: scan.source,
                        section: &scoped,
                        table,
                    },
                )?;
            }
        }
    }
    Ok(())
}

fn add_cargo_workspace_entries(
    builder: &mut FrameworkBuilder<'_, '_>,
    members: Vec<(&str, Range<usize>)>,
    excludes: Vec<(&str, Range<usize>)>,
) -> Result<(), ExtractError> {
    for (pattern, span) in members {
        add_workspace_pattern(
            builder,
            ManifestSpanInput {
                ecosystem: "cargo",
                value: pattern,
                span,
            },
        )?;
    }
    for (pattern, span) in excludes {
        add_workspace_exclusion(
            builder,
            ManifestSpanInput {
                ecosystem: "cargo",
                value: pattern,
                span,
            },
        )?;
    }
    Ok(())
}

fn toml_string_array<'value>(
    source: &str,
    values: &'value toml_edit::Array,
) -> Vec<(&'value str, Range<usize>)> {
    values
        .iter()
        .filter_map(|value| {
            let pattern = value.as_str()?;
            let span = value.span()?;
            let span = value_text_span(source, span, pattern)?;
            Some((pattern, span))
        })
        .take(MAX_MANIFEST_ENTRIES)
        .collect()
}

fn scan_cargo_dependencies(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: CargoDependencyScan<'_>,
) -> Result<(), ExtractError> {
    for (alias, item) in input.table.iter().take(MAX_MANIFEST_ENTRIES) {
        builder.check_cancelled()?;
        if !safe_package_name(alias) {
            continue;
        }
        let Some(key_span) = input
            .table
            .key(alias)
            .and_then(toml_edit::Key::span)
            .and_then(|span| value_text_span(input.source, span, alias))
        else {
            continue;
        };
        let package = cargo_dependency_package(item)
            .filter(|name| safe_package_name(name))
            .filter(|name| *name != alias);
        add_dependency(
            builder,
            DependencyInput {
                owner: input.owner,
                ecosystem: "cargo",
                section: input.section,
                name: alias,
                resolution_name: package,
                span: key_span,
            },
        )?;
    }
    Ok(())
}

fn cargo_dependency_package(item: &Item) -> Option<&str> {
    item.as_inline_table()
        .and_then(|table| table.get("package"))
        .and_then(Value::as_str)
        .or_else(|| {
            item.as_table()
                .and_then(|table| table.get("package"))
                .and_then(Item::as_str)
        })
}

fn add_package(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: ManifestSpanInput<'_>,
) -> Result<Option<SymbolId>, ExtractError> {
    let ManifestSpanInput {
        ecosystem,
        value,
        span,
    } = input;
    let directory = manifest_identity_directory(builder.path());
    builder.add_landmark_with_id(LandmarkInput {
        kind: SymbolKind::Resource,
        name: value.to_owned(),
        identity: format!("manifest-package-{ecosystem}::{value}::manifest-dir::{directory}"),
        start: span.start,
        end: span.end,
        body_search_text: format!("{ecosystem} package dependency manifest {value}"),
        target: None,
    })
}

fn add_workspace_owner(
    builder: &mut FrameworkBuilder<'_, '_>,
    ecosystem: &str,
    source: &str,
) -> Result<Option<SymbolId>, ExtractError> {
    let span = first_source_span(source);
    builder.add_landmark_with_id(LandmarkInput {
        kind: SymbolKind::Resource,
        name: format!("{ecosystem} workspace"),
        identity: format!(
            "manifest-workspace-{ecosystem}::{}",
            manifest_identity_directory(builder.path())
        ),
        start: span.start,
        end: span.end,
        body_search_text: format!("{ecosystem} package workspace dependency manifest"),
        target: None,
    })
}

struct DependencyInput<'value> {
    owner: Option<&'value SymbolId>,
    ecosystem: &'value str,
    section: &'value str,
    name: &'value str,
    resolution_name: Option<&'value str>,
    span: Range<usize>,
}

fn add_dependency(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: DependencyInput<'_>,
) -> Result<(), ExtractError> {
    let DependencyInput {
        owner,
        ecosystem,
        section,
        name,
        resolution_name,
        span,
    } = input;
    builder.add_landmark(LandmarkInput {
        kind: SymbolKind::Resource,
        name: format!("{ecosystem} dependency {name}"),
        identity: format!("manifest-dependency-{ecosystem}::{section}::{name}"),
        start: span.start,
        end: span.end,
        body_search_text: format!("{ecosystem} {section} dependency {name}"),
        target: None,
    })?;
    builder.add_reference_with_resolution(FrameworkReferenceInput {
        owner: owner.cloned(),
        name,
        resolution_name,
        kind: ReferenceKind::References,
        start: span.start,
        end: span.end,
    })
}

fn add_workspace_pattern(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: ManifestSpanInput<'_>,
) -> Result<(), ExtractError> {
    add_workspace_entry(builder, input, WorkspaceEntryKind::Member)
}

fn add_workspace_exclusion(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: ManifestSpanInput<'_>,
) -> Result<(), ExtractError> {
    add_workspace_entry(builder, input, WorkspaceEntryKind::Exclusion)
}

#[derive(Clone, Copy)]
enum WorkspaceEntryKind {
    Member,
    Exclusion,
}

fn add_workspace_entry(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: ManifestSpanInput<'_>,
    kind: WorkspaceEntryKind,
) -> Result<(), ExtractError> {
    let ManifestSpanInput {
        ecosystem,
        value,
        span,
    } = input;
    let Some(pattern) = normalized_workspace_pattern(builder.path(), value) else {
        return Ok(());
    };
    let workspace_directory = manifest_directory(builder.path());
    let (label, identity_label, search_label) = match kind {
        WorkspaceEntryKind::Member => ("member", "member", "member package"),
        WorkspaceEntryKind::Exclusion => ("exclude", "exclude", "excluded package"),
    };
    builder.add_landmark(LandmarkInput {
        kind: SymbolKind::Resource,
        name: format!("{ecosystem} workspace {label} {pattern}"),
        identity: format!(
            "manifest-workspace-{identity_label}-{ecosystem}::{workspace_directory}::pattern::{pattern}",
        ),
        start: span.start,
        end: span.end,
        body_search_text: format!("{ecosystem} workspace {search_label} {pattern}"),
        target: None,
    })
}

fn normalized_workspace_pattern(manifest_path: &str, pattern: &str) -> Option<String> {
    if pattern.is_empty()
        || pattern.len() > 4_096
        || pattern.starts_with('/')
        || pattern.contains(['\\', '\0'])
    {
        return None;
    }
    let mut components = manifest_directory(manifest_path)
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect::<Vec<_>>();
    for component in pattern.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop()?;
            }
            value => components.push(value),
        }
    }
    (!components.is_empty()).then(|| components.join("/"))
}

fn manifest_directory(path: &str) -> &str {
    path.rsplit_once('/')
        .map_or(".", |(directory, _)| directory)
}

fn manifest_identity_directory(path: &str) -> &str {
    match manifest_directory(path) {
        "." => "__root__",
        directory => directory,
    }
}

fn first_source_span(source: &str) -> Range<usize> {
    let start = source
        .char_indices()
        .find_map(|(index, character)| (!character.is_whitespace()).then_some(index))
        .unwrap_or(0);
    let end = source
        .get(start..)
        .and_then(|tail| tail.chars().next())
        .map_or(start, |character| {
            start.saturating_add(character.len_utf8())
        });
    start..end
}

fn value_text_span(source: &str, outer: Range<usize>, value: &str) -> Option<Range<usize>> {
    let haystack = source.get(outer.clone())?;
    let offset = haystack.find(value)?;
    let start = outer.start.checked_add(offset)?;
    Some(start..start.checked_add(value.len())?)
}

fn safe_package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 1_024
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'/' | b'_' | b'-' | b'.' | b'+')
        })
}

#[derive(Clone)]
struct JsonMember<'source> {
    key: Option<&'source str>,
    key_span: Range<usize>,
    value: Range<usize>,
}

type JsonString<'source> = (Option<&'source str>, Range<usize>);

fn parse_json_object<'source>(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &'source str,
    range: Range<usize>,
) -> Result<Vec<JsonMember<'source>>, ExtractError> {
    let mut cancelled = || builder.check_cancelled();
    JsonScanner::new(source, range, &mut cancelled).object()
}

fn json_static_string(source: &str, range: Range<usize>) -> Option<(&str, Range<usize>)> {
    let bytes = source.as_bytes();
    if bytes.get(range.start) != Some(&b'"') || range.end <= range.start + 1 {
        return None;
    }
    let end_quote = range.end.checked_sub(1)?;
    if bytes.get(end_quote) != Some(&b'"') {
        return None;
    }
    let value = source.get(range.start + 1..end_quote)?;
    (!value.contains('\\')).then_some((value, range.start + 1..end_quote))
}

fn json_workspace_patterns<'source>(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &'source str,
    members: &[JsonMember<'source>],
) -> Result<Vec<(&'source str, Range<usize>)>, ExtractError> {
    let Some(workspaces) = members
        .iter()
        .find(|member| member.key == Some("workspaces"))
    else {
        return Ok(Vec::new());
    };
    let range = if source.as_bytes().get(workspaces.value.start) == Some(&b'{') {
        let nested = parse_json_object(builder, source, workspaces.value.clone())?;
        let Some(packages) = nested.iter().find(|member| member.key == Some("packages")) else {
            return Ok(Vec::new());
        };
        packages.value.clone()
    } else {
        workspaces.value.clone()
    };
    let mut cancelled = || builder.check_cancelled();
    JsonScanner::new(source, range, &mut cancelled).string_array()
}

struct JsonScanner<'source, 'cancel> {
    source: &'source str,
    bytes: &'source [u8],
    cursor: usize,
    end: usize,
    next_poll: usize,
    cancelled: &'cancel mut dyn FnMut() -> Result<(), ExtractError>,
}

impl<'source, 'cancel> JsonScanner<'source, 'cancel> {
    fn new(
        source: &'source str,
        range: Range<usize>,
        cancelled: &'cancel mut dyn FnMut() -> Result<(), ExtractError>,
    ) -> Self {
        Self {
            source,
            bytes: source.as_bytes(),
            cursor: range.start,
            end: range.end.min(source.len()),
            next_poll: range.start.saturating_add(JSON_CANCEL_BYTES),
            cancelled,
        }
    }

    fn object(mut self) -> Result<Vec<JsonMember<'source>>, ExtractError> {
        self.skip_ws()?;
        if !self.take(b'{')? {
            return Ok(Vec::new());
        }
        let mut members = Vec::new();
        loop {
            self.skip_ws()?;
            if self.take(b'}')? {
                self.skip_ws()?;
                return Ok(if self.cursor == self.end {
                    members
                } else {
                    Vec::new()
                });
            }
            if members.len() >= MAX_MANIFEST_ENTRIES {
                return Ok(Vec::new());
            }
            let Some((key, key_span)) = self.string()? else {
                return Ok(Vec::new());
            };
            self.skip_ws()?;
            if !self.take(b':')? {
                return Ok(Vec::new());
            }
            self.skip_ws()?;
            let value_start = self.cursor;
            if !self.value(0)? {
                return Ok(Vec::new());
            }
            members
                .try_reserve(1)
                .map_err(|_| ExtractError::OutputLimit)?;
            members.push(JsonMember {
                key,
                key_span,
                value: value_start..self.cursor,
            });
            self.skip_ws()?;
            if self.take(b',')? {
                continue;
            }
            if self.take(b'}')? {
                self.skip_ws()?;
                return Ok(if self.cursor == self.end {
                    members
                } else {
                    Vec::new()
                });
            }
            return Ok(Vec::new());
        }
    }

    fn string_array(mut self) -> Result<Vec<(&'source str, Range<usize>)>, ExtractError> {
        self.skip_ws()?;
        if !self.take(b'[')? {
            return Ok(Vec::new());
        }
        let mut values = Vec::new();
        loop {
            self.skip_ws()?;
            if self.take(b']')? {
                self.skip_ws()?;
                return Ok(if self.cursor == self.end {
                    values
                } else {
                    Vec::new()
                });
            }
            if values.len() >= MAX_MANIFEST_ENTRIES {
                return Ok(Vec::new());
            }
            let Some((value, span)) = self.string()? else {
                return Ok(Vec::new());
            };
            if let Some(value) = value {
                values
                    .try_reserve(1)
                    .map_err(|_| ExtractError::OutputLimit)?;
                values.push((value, span));
            }
            self.skip_ws()?;
            if self.take(b',')? {
                continue;
            }
            if self.take(b']')? {
                self.skip_ws()?;
                return Ok(if self.cursor == self.end {
                    values
                } else {
                    Vec::new()
                });
            }
            return Ok(Vec::new());
        }
    }

    fn value(&mut self, depth: usize) -> Result<bool, ExtractError> {
        if depth >= MAX_JSON_NESTING {
            return Ok(false);
        }
        self.skip_ws()?;
        match self.bytes.get(self.cursor).copied() {
            Some(b'"') => Ok(self.string()?.is_some()),
            Some(b'{') => self.compound(JsonCompound {
                opening: b'{',
                closing: b'}',
                depth,
            }),
            Some(b'[') => self.compound(JsonCompound {
                opening: b'[',
                closing: b']',
                depth,
            }),
            Some(_) => self.primitive(),
            None => Ok(false),
        }
    }

    fn compound(&mut self, input: JsonCompound) -> Result<bool, ExtractError> {
        if !self.take(input.opening)? {
            return Ok(false);
        }
        loop {
            self.skip_ws()?;
            if self.take(input.closing)? {
                return Ok(true);
            }
            if input.opening == b'{' && !self.object_member_prefix()? {
                return Ok(false);
            }
            if !self.value(input.depth.saturating_add(1))? {
                return Ok(false);
            }
            self.skip_ws()?;
            if self.take(b',')? {
                continue;
            }
            return self.take(input.closing);
        }
    }

    fn object_member_prefix(&mut self) -> Result<bool, ExtractError> {
        if self.string()?.is_none() {
            return Ok(false);
        }
        self.skip_ws()?;
        self.take(b':')
    }

    fn primitive(&mut self) -> Result<bool, ExtractError> {
        let start = self.cursor;
        while let Some(byte) = self.bytes.get(self.cursor).copied() {
            if self.cursor >= self.end
                || matches!(byte, b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n')
            {
                break;
            }
            self.advance()?;
        }
        let value = self.source.get(start..self.cursor).unwrap_or_default();
        Ok(!value.is_empty()
            && (matches!(value, "true" | "false" | "null") || value.parse::<f64>().is_ok()))
    }

    fn string(&mut self) -> Result<Option<JsonString<'source>>, ExtractError> {
        if !self.take(b'"')? {
            return Ok(None);
        }
        let start = self.cursor;
        let mut escaped = false;
        let mut has_escape = false;
        while self.cursor < self.end {
            let byte = self.bytes[self.cursor];
            self.advance()?;
            if escaped {
                escaped = false;
                has_escape = true;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                let end = self.cursor.saturating_sub(1);
                let value = (!has_escape).then(|| self.source.get(start..end)).flatten();
                return Ok(Some((value, start..end)));
            } else if byte.is_ascii_control() {
                return Ok(None);
            }
        }
        Ok(None)
    }

    fn skip_ws(&mut self) -> Result<(), ExtractError> {
        while self.cursor < self.end
            && self
                .bytes
                .get(self.cursor)
                .is_some_and(u8::is_ascii_whitespace)
        {
            self.advance()?;
        }
        Ok(())
    }

    fn take(&mut self, expected: u8) -> Result<bool, ExtractError> {
        if self.cursor < self.end && self.bytes.get(self.cursor) == Some(&expected) {
            self.advance()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn advance(&mut self) -> Result<(), ExtractError> {
        self.cursor = self.cursor.saturating_add(1);
        if self.cursor >= self.next_poll {
            (self.cancelled)()?;
            self.next_poll = self.cursor.saturating_add(JSON_CANCEL_BYTES);
        }
        Ok(())
    }
}
