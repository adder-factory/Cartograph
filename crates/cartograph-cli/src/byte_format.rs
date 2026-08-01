//! Human-readable formatting for exact byte quantities.

const KIBIBYTE: u64 = 1 << 10;
const MEBIBYTE: u64 = 1 << 20;
const GIBIBYTE: u64 = 1 << 30;
const TEBIBYTE: u64 = 1 << 40;
const PEBIBYTE: u64 = 1 << 50;
const EXBIBYTE: u64 = 1 << 60;
const HUNDREDTHS_PER_UNIT: u128 = 100;
const HALF_UNIT_ROUNDING_DIVISOR: u128 = 2;
const TENTHS_PER_UNIT: u128 = 10;

const BINARY_UNITS: [(u64, &str); 6] = [
    (EXBIBYTE, "EiB"),
    (PEBIBYTE, "PiB"),
    (TEBIBYTE, "TiB"),
    (GIBIBYTE, "GiB"),
    (MEBIBYTE, "MiB"),
    (KIBIBYTE, "KiB"),
];

/// Format exact bytes as a compact IEC binary quantity with at most two decimals.
pub(crate) fn format_binary_bytes(bytes: u64) -> String {
    let Some((unit_bytes, unit)) = BINARY_UNITS
        .into_iter()
        .find(|(unit_bytes, _)| bytes >= *unit_bytes)
    else {
        return format!("{bytes} B");
    };
    let hundredths = (u128::from(bytes) * HUNDREDTHS_PER_UNIT
        + u128::from(unit_bytes) / HALF_UNIT_ROUNDING_DIVISOR)
        / u128::from(unit_bytes);
    let whole = hundredths / HUNDREDTHS_PER_UNIT;
    let fraction = hundredths % HUNDREDTHS_PER_UNIT;
    if fraction == 0 {
        format!("{whole} {unit}")
    } else if fraction.is_multiple_of(TENTHS_PER_UNIT) {
        format!("{whole}.{} {unit}", fraction / TENTHS_PER_UNIT)
    } else {
        format!("{whole}.{fraction:02} {unit}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_quantities_scale_and_round_without_losing_exact_source_values() {
        assert_eq!(format_binary_bytes(0), "0 B");
        assert_eq!(format_binary_bytes(1_023), "1023 B");
        assert_eq!(format_binary_bytes(1_024), "1 KiB");
        assert_eq!(format_binary_bytes(1_536), "1.5 KiB");
        assert_eq!(format_binary_bytes(1_048_576), "1 MiB");
        assert_eq!(format_binary_bytes(1_610_613_145), "1.5 GiB");
        assert_eq!(format_binary_bytes(u64::MAX), "16 EiB");
    }

    #[test]
    fn byte_quantities_keep_two_useful_decimal_places_for_status_storage() {
        assert_eq!(format_binary_bytes(2_175_776_447), "2.03 GiB");
        assert_eq!(format_binary_bytes(2_028_986_368), "1.89 GiB");
        assert_eq!(format_binary_bytes(951_353_344), "907.28 MiB");
        assert_eq!(format_binary_bytes(993_681_408), "947.65 MiB");
        assert_eq!(format_binary_bytes(875_233_280), "834.69 MiB");
        assert_eq!(format_binary_bytes(83_951_616), "80.06 MiB");
    }
}
