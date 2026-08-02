use cartograph_domain::{ContentDigest, SourceLanguage};
use tree_sitter::Node;

use crate::{
    ExtractError, ExtractedNumericalSite, budget::numerical_site_budget_bytes,
    identity::numerical_site_id,
};

use super::{ExtractionBuilder, owner_for_node, syntax};

const PROVENANCE: &str = "rust_ast_v1";
const EXACT_CONFIDENCE_PPM: u32 = 1_000_000;
const STRONG_HEURISTIC_CONFIDENCE_PPM: u32 = 900_000;
const BOUNDED_HEURISTIC_CONFIDENCE_PPM: u32 = 650_000;

pub(super) fn enrich(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    if builder.context.snapshot.language() != SourceLanguage::Rust {
        return Ok(());
    }
    for node in syntax::descendants_including_root(root) {
        builder.context.ensure_active()?;
        match node.kind() {
            "binary_expression" => capture_binary(builder, node)?,
            "type_cast_expression" => capture_narrowing_cast(builder, node)?,
            "call_expression" => capture_call(builder, node)?,
            _ => {}
        }
    }
    Ok(())
}

fn capture_binary(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(operator) = node.child_by_field_name("operator") else {
        return Ok(());
    };
    let operator = builder.context.text(operator);
    if matches!(operator, "<" | "<=" | ">" | ">=") && absolute_tolerance_shape(builder, node) {
        return push_site(
            builder,
            node,
            SiteClassification {
                operation: "tolerance_comparison",
                hazard: "absolute_only_tolerance",
                precision: classify_precision(builder.context.text(node)),
                confidence_ppm: STRONG_HEURISTIC_CONFIDENCE_PPM,
                unknowns: "relative_scale,input_range",
            },
        );
    }
    let operation = match operator {
        "+" => "addition",
        "-" => "subtraction",
        "*" => "multiplication",
        "/" => "division",
        "%" => "remainder",
        _ => return Ok(()),
    };
    let widening = widening_cast_precision(builder, node);
    let (hazard, precision, confidence_ppm, unknowns) = if let Some(precision) = widening {
        (
            "arithmetic_before_widening",
            precision,
            STRONG_HEURISTIC_CONFIDENCE_PPM,
            "operand_precision,overflow_or_rounding",
        )
    } else if operation == "division" {
        (
            "none_observed",
            classify_precision(builder.context.text(node)),
            EXACT_CONFIDENCE_PPM,
            "operand_precision,zero_denominator,finite_result",
        )
    } else {
        (
            "none_observed",
            classify_precision(builder.context.text(node)),
            EXACT_CONFIDENCE_PPM,
            "operand_precision,overflow_or_rounding",
        )
    };
    push_site(
        builder,
        node,
        SiteClassification {
            operation,
            hazard,
            precision,
            confidence_ppm,
            unknowns,
        },
    )
}

fn capture_narrowing_cast(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(target) = node.child_by_field_name("type") else {
        return Ok(());
    };
    let precision = classify_precision(builder.context.text(target));
    if !matches!(precision, "f16" | "bf16") || !feeds_accumulation(node) {
        return Ok(());
    }
    push_site(
        builder,
        node,
        SiteClassification {
            operation: "narrowing_cast",
            hazard: "narrowing_before_accumulation",
            precision,
            confidence_ppm: STRONG_HEURISTIC_CONFIDENCE_PPM,
            unknowns: "accumulator_precision,acceptable_error",
        },
    )
}

fn capture_call(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(function) = node.child_by_field_name("function") else {
        return Ok(());
    };
    let raw_function = builder.context.text(function);
    let compact = raw_function
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let Ok(compact) = std::str::from_utf8(&compact) else {
        return Ok(());
    };
    let precision = classify_precision(compact);
    if is_method(compact, "sum") {
        let (hazard, confidence_ppm, unknowns) = if matches!(precision, "f16" | "bf16") {
            (
                "low_precision_reduction",
                STRONG_HEURISTIC_CONFIDENCE_PPM,
                "reduction_order,acceptable_error",
            )
        } else {
            (
                "none_observed",
                EXACT_CONFIDENCE_PPM,
                "accumulator_precision,reduction_order",
            )
        };
        return push_site(
            builder,
            node,
            SiteClassification {
                operation: "reduction",
                hazard,
                precision,
                confidence_ppm,
                unknowns,
            },
        );
    }
    if ["sqrt", "ln", "log", "log2", "log10", "acos", "asin"]
        .iter()
        .any(|name| is_method(compact, name))
    {
        return push_site(
            builder,
            node,
            SiteClassification {
                operation: "domain_sensitive_function",
                hazard: "domain_precondition_unknown",
                precision,
                confidence_ppm: BOUNDED_HEURISTIC_CONFIDENCE_PPM,
                unknowns: "input_domain,nonfinite_handling",
            },
        );
    }
    if ["min", "max", "clamp"]
        .iter()
        .any(|name| is_method(compact, name))
    {
        return push_site(
            builder,
            node,
            SiteClassification {
                operation: "ordering_selection",
                hazard: "nan_ordering_unknown",
                precision,
                confidence_ppm: BOUNDED_HEURISTIC_CONFIDENCE_PPM,
                unknowns: "finite_inputs,nan_policy",
            },
        );
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct SiteClassification<'a> {
    operation: &'a str,
    hazard: &'a str,
    precision: &'a str,
    confidence_ppm: u32,
    unknowns: &'a str,
}

fn push_site(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    classification: SiteClassification<'_>,
) -> Result<(), ExtractError> {
    let span = syntax::span_for(node)?;
    let site = ExtractedNumericalSite {
        id: numerical_site_id(
            builder.context.snapshot.file_id(),
            &span,
            [classification.operation, classification.hazard],
        ),
        owner: owner_for_node(builder, node),
        span,
        operation: classification.operation.to_owned(),
        hazard: classification.hazard.to_owned(),
        precision: classification.precision.to_owned(),
        expression_digest: site_expression_digest(builder, node, &classification),
        confidence_ppm: classification.confidence_ppm,
        provenance: PROVENANCE.to_owned(),
        unknowns: classification.unknowns.to_owned(),
    };
    builder.context.budget.reserve_fact(
        numerical_site_budget_bytes(&site),
        [
            site.operation.as_str(),
            site.hazard.as_str(),
            site.precision.as_str(),
            site.provenance.as_str(),
            site.unknowns.as_str(),
        ],
    )?;
    builder.facts.numerical_sites.push(site);
    Ok(())
}

fn site_expression_digest(
    builder: &ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    classification: &SiteClassification<'_>,
) -> ContentDigest {
    let mut hasher =
        blake3::Hasher::new_derive_key("cartograph.v2.numerical-expression-site.2026-08-01");
    hasher.update(builder.context.snapshot.content_hash().as_str().as_bytes());
    let start = u64::try_from(node.start_byte()).unwrap_or(u64::MAX);
    let end = u64::try_from(node.end_byte()).unwrap_or(u64::MAX);
    hasher.update(&start.to_be_bytes());
    hasher.update(&end.to_be_bytes());
    hasher.update(classification.operation.as_bytes());
    hasher.update(classification.hazard.as_bytes());
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

fn widening_cast_precision(
    builder: &ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Option<&'static str> {
    let mut parent = node.parent()?;
    if parent.kind() == "parenthesized_expression" {
        parent = parent.parent()?;
    }
    if parent.kind() != "type_cast_expression" {
        return None;
    }
    let target = parent.child_by_field_name("type")?;
    let precision = classify_precision(builder.context.text(target));
    matches!(precision, "f32" | "f64").then_some(precision)
}

fn feeds_accumulation(node: Node<'_>) -> bool {
    let mut current = node.parent();
    for _ in 0..3 {
        let Some(parent) = current else {
            return false;
        };
        if parent.kind() == "compound_assignment_expr"
            && parent
                .child_by_field_name("operator")
                .is_some_and(|operator| operator.kind() == "+=")
        {
            return true;
        }
        if parent.kind() == "binary_expression"
            && parent
                .child_by_field_name("operator")
                .is_some_and(|operator| operator.kind() == "+")
        {
            return true;
        }
        if !matches!(
            parent.kind(),
            "parenthesized_expression" | "binary_expression"
        ) {
            return false;
        }
        current = parent.parent();
    }
    false
}

fn absolute_tolerance_shape(builder: &ExtractionBuilder<'_, '_>, node: Node<'_>) -> bool {
    let left = node
        .child_by_field_name("left")
        .map(|child| builder.context.text(child))
        .unwrap_or_default();
    let right = node
        .child_by_field_name("right")
        .map(|child| builder.context.text(child))
        .unwrap_or_default();
    contains_abs_call(left) ^ contains_abs_call(right)
}

fn contains_abs_call(raw: &str) -> bool {
    let compact = raw
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    compact.windows(5).any(|window| window == b".abs(")
}

fn is_method(raw: &str, name: &str) -> bool {
    let method = format!(".{name}");
    let associated = format!("::{name}");
    let generic_method = format!(".{name}::<");
    let generic_associated = format!("::{name}::<");
    raw == name
        || raw.ends_with(&method)
        || raw.ends_with(&associated)
        || raw.contains(&generic_method)
        || raw.contains(&generic_associated)
}

fn classify_precision(raw: &str) -> &'static str {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("bf16") {
        "bf16"
    } else if lower.contains("f16") {
        "f16"
    } else if lower.contains("f32") {
        "f32"
    } else if lower.contains("f64") {
        "f64"
    } else if [
        "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
    ]
    .iter()
    .any(|candidate| lower.contains(candidate))
    {
        "integer"
    } else {
        "unknown"
    }
}
