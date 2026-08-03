import "policy_helpers" as helpers;

export const DEFAULT_RETRIES = 3;

private fn normalize_score(score) {
    score.clamp(0, 100)
}

fn evaluate_policy(subject, score) {
    let normalized = normalize_score(score);
    helpers::allowed(subject, normalized)
}
