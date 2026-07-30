//! Process-level Rustls provider selection for Cartograph HTTP clients.

/// The process could not install or observe a Rustls cryptography provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TlsProviderUnavailable;

/// Ensure Rustls has one process-level cryptography provider before Reqwest
/// constructs a client.
///
/// Cartograph installs ring only when the embedding application has not
/// already selected a provider. A concurrent successful installation is also
/// accepted.
/// # Errors
///
/// Returns an error only when neither an existing default provider nor the
/// bundled ring provider can become rustls's process-wide default.
pub fn ensure_tls_crypto_provider() -> Result<(), TlsProviderUnavailable> {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return Ok(());
    }
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_ok()
        || rustls::crypto::CryptoProvider::get_default().is_some()
    {
        Ok(())
    } else {
        Err(TlsProviderUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_provider_before_provider_neutral_reqwest_client() {
        assert_eq!(ensure_tls_crypto_provider(), Ok(()));
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        assert!(reqwest::Client::builder().build().is_ok());
    }
}
