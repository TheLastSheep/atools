const SERVICE: &str = "com.atools.pasteboardpro.sync";
pub const WEBDAV_ACCOUNT: &str = "webdav";
pub const VAULT_KEY_ACCOUNT: &str = "vault-key";

pub trait PasteboardSecretStore: Send + Sync {
    fn save(&self, account: &str, secret: &[u8]) -> Result<(), String>;
    fn load(&self, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MacOsPasteboardKeychain;

fn validate_account(account: &str) -> Result<&str, String> {
    match account {
        WEBDAV_ACCOUNT | VAULT_KEY_ACCOUNT => Ok(account),
        _ => Err("Unsupported PasteboardPro Keychain account".to_string()),
    }
}

#[cfg(target_os = "macos")]
impl PasteboardSecretStore for MacOsPasteboardKeychain {
    fn save(&self, account: &str, secret: &[u8]) -> Result<(), String> {
        let account = validate_account(account)?;
        if secret.is_empty() || secret.len() > 16 * 1024 {
            return Err("PasteboardPro secret must contain 1 to 16384 bytes".to_string());
        }
        security_framework::passwords::set_generic_password(SERVICE, account, secret)
            .map_err(|error| format!("Failed to save PasteboardPro Keychain secret: {error}"))
    }

    fn load(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        let account = validate_account(account)?;
        match security_framework::passwords::get_generic_password(SERVICE, account) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(error) => Err(format!(
                "Failed to load PasteboardPro Keychain secret: {error}"
            )),
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let account = validate_account(account)?;
        match security_framework::passwords::delete_generic_password(SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(format!(
                "Failed to delete PasteboardPro Keychain secret: {error}"
            )),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl PasteboardSecretStore for MacOsPasteboardKeychain {
    fn save(&self, account: &str, _secret: &[u8]) -> Result<(), String> {
        validate_account(account)?;
        Err("PasteboardPro Keychain is only available on macOS".to_string())
    }

    fn load(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        validate_account(account)?;
        Err("PasteboardPro Keychain is only available on macOS".to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        validate_account(account)?;
        Err("PasteboardPro Keychain is only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_accounts_are_accepted() {
        assert_eq!(validate_account(WEBDAV_ACCOUNT).unwrap(), WEBDAV_ACCOUNT);
        assert_eq!(
            validate_account(VAULT_KEY_ACCOUNT).unwrap(),
            VAULT_KEY_ACCOUNT
        );
        assert!(validate_account("other").is_err());
    }
}
