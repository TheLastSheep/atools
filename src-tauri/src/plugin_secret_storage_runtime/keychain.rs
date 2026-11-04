use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use std::{fs, io::Write, path::Path};
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
use core_foundation::data::CFData;
#[cfg(target_os = "macos")]
use security_framework::os::macos::keychain::SecKeychain;
#[cfg(target_os = "macos")]
use security_framework::{
    base::Error,
    item::{ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, Location, SearchResult},
};

#[cfg(target_os = "macos")]
pub(super) fn load_or_create(plugin: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    load_or_create_in(plugin, None)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn load_or_create(plugin: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let root = dirs::data_local_dir()
        .or_else(dirs::config_dir)
        .ok_or_else(|| "KEYCHAIN_UNAVAILABLE".to_string())?
        .join("com.atools.desktop")
        .join("safe-storage-keys");
    load_or_create_in_file_store(plugin, &root)
}

#[allow(dead_code)]
pub(super) fn load_or_create_in_file_store(
    plugin: &str,
    root: &Path,
) -> Result<Zeroizing<[u8; 32]>, String> {
    fs::create_dir_all(root).map_err(|_| "KEYCHAIN_UNAVAILABLE".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(root, fs::Permissions::from_mode(0o700));
    }

    let key_path = root.join(format!("{}.key", account(plugin)));
    if let Some(existing) = read_file_store_key(&key_path)? {
        return Ok(existing);
    }

    let key = super::crypto::new_key();
    let encoded = BASE64_STANDARD.encode(key.as_ref());
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&key_path) {
        Ok(mut file) => {
            file.write_all(encoded.as_bytes())
                .map_err(|_| "KEYCHAIN_UNAVAILABLE".to_string())?;
            Ok(key)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            read_file_store_key(&key_path)?.ok_or_else(|| "KEYCHAIN_UNAVAILABLE".into())
        }
        Err(_) => Err("KEYCHAIN_UNAVAILABLE".into()),
    }
}

fn read_file_store_key(key_path: &Path) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
    let raw = match fs::read_to_string(key_path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("KEYCHAIN_UNAVAILABLE".into()),
    };
    let decoded = Zeroizing::new(
        BASE64_STANDARD
            .decode(raw.trim().as_bytes())
            .map_err(|_| "KEYCHAIN_ITEM_INVALID".to_string())?,
    );
    let key: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "KEYCHAIN_ITEM_INVALID".to_string())?;
    Ok(Some(Zeroizing::new(key)))
}

#[cfg(target_os = "macos")]
const SEC_ITEM_NOT_FOUND: i32 = -25300;
#[cfg(target_os = "macos")]
const SEC_DUPLICATE_ITEM: i32 = -25299;

#[cfg(target_os = "macos")]
fn is_item_not_found(error: Error) -> bool {
    error.code() == SEC_ITEM_NOT_FOUND
}

#[cfg(target_os = "macos")]
fn is_duplicate_item(error: Error) -> bool {
    error.code() == SEC_DUPLICATE_ITEM
}

#[cfg(target_os = "macos")]
fn lookup(
    plugin: &str,
    keychains: Option<&[SecKeychain]>,
) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
    let mut query = ItemSearchOptions::new();
    query
        .class(ItemClass::generic_password())
        .service("com.atools.safeStorage.v1")
        .account(&account(plugin))
        .load_data(true)
        .limit(1);
    if let Some(items) = keychains {
        query.keychains(items);
    }
    let found = match query.search() {
        Ok(found) => found,
        Err(error) if is_item_not_found(error) => return Ok(None),
        Err(_) => return Err("KEYCHAIN_UNAVAILABLE".into()),
    };
    let Some(item) = found.into_iter().next() else {
        return Ok(None);
    };
    let SearchResult::Data(data) = item else {
        return Err("KEYCHAIN_ITEM_INVALID".into());
    };
    let key: [u8; 32] = data
        .as_slice()
        .try_into()
        .map_err(|_| "KEYCHAIN_ITEM_INVALID")?;
    Ok(Some(Zeroizing::new(key)))
}

#[cfg(target_os = "macos")]
fn load_or_create_in(
    plugin: &str,
    keychains: Option<&[SecKeychain]>,
) -> Result<Zeroizing<[u8; 32]>, String> {
    if let Some(key) = lookup(plugin, keychains)? {
        return Ok(key);
    }
    let key = super::crypto::new_key();
    let data = CFData::from_buffer(key.as_ref());
    let mut add = ItemAddOptions::new(ItemAddValue::Data {
        class: ItemClass::generic_password(),
        data,
    });
    add.set_service("com.atools.safeStorage.v1")
        .set_account_name(account(plugin));
    if let Some(items) = keychains {
        let Some(item) = items.first() else {
            return Err("KEYCHAIN_UNAVAILABLE".into());
        };
        add.set_location(Location::FileKeychain(item.clone()));
    }
    match add.add() {
        Ok(()) => Ok(key),
        Err(error) if is_duplicate_item(error) => {
            // A concurrent opener may have won SecItemAdd. Only that race may re-read.
            lookup(plugin, keychains)?.ok_or_else(|| "KEYCHAIN_UNAVAILABLE".into())
        }
        Err(_) => Err("KEYCHAIN_UNAVAILABLE".into()),
    }
}

fn account(plugin: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(plugin.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod file_store_tests {
    use super::*;

    #[test]
    fn file_backed_key_store_creates_reuses_and_validates_keys() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("keys");
        let first = load_or_create_in_file_store("plugin-alpha", &root).unwrap();
        let second = load_or_create_in_file_store("plugin-alpha", &root).unwrap();
        assert_eq!(first.as_ref(), second.as_ref());

        let other = load_or_create_in_file_store("plugin-beta", &root).unwrap();
        assert_ne!(first.as_ref(), other.as_ref());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let key_path = root.join(format!("{}.key", account("plugin-alpha")));
            let mode = fs::metadata(key_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let broken_path = root.join(format!("{}.key", account("plugin-broken")));
        fs::write(&broken_path, "not-valid-32-byte-key").unwrap();
        assert_eq!(
            load_or_create_in_file_store("plugin-broken", &root).unwrap_err(),
            "KEYCHAIN_ITEM_INVALID"
        );
    }
}

/// Root-run fixture owns a private temporary keychain and never changes global keychain state.
#[cfg(all(test, target_os = "macos"))]
mod keychain_fixture {
    use super::*;
    use core_foundation::base::TCFType;
    use security_framework::os::macos::keychain::{CreateOptions, SecKeychain};
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
    };

    struct OwnedKeychain {
        keychain: Option<SecKeychain>,
        directory: PathBuf,
        path: PathBuf,
        delete_error: Option<String>,
        cleaned: bool,
    }

    impl OwnedKeychain {
        fn create() -> Self {
            let directory =
                std::env::temp_dir().join(format!("atools-safe-storage-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&directory).expect("create private keychain fixture directory");
            let path = directory.join("fixture.keychain-db");
            let mut guard = Self {
                keychain: None,
                directory,
                path,
                delete_error: None,
                cleaned: false,
            };
            fs::set_permissions(&guard.directory, fs::Permissions::from_mode(0o700))
                .expect("restrict keychain fixture directory");
            let password = uuid::Uuid::new_v4().to_string();
            let mut options = CreateOptions::new();
            options.password(&password).prompt_user(false);
            let keychain = options
                .create(&guard.path)
                .expect("create isolated temporary keychain");
            guard.keychain = Some(keychain);
            guard
                .keychain_mut()
                .unlock(Some(&password))
                .expect("unlock isolated temporary keychain");
            guard
        }

        fn keychain(&self) -> &SecKeychain {
            self.keychain.as_ref().expect("fixture keychain is present")
        }

        fn keychain_mut(&mut self) -> &mut SecKeychain {
            self.keychain.as_mut().expect("fixture keychain is present")
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn delete_owned(&mut self) -> Result<(), String> {
            if self.cleaned {
                return Ok(());
            }
            if let Some(error) = &self.delete_error {
                return Err(error.clone());
            }
            if let Some(keychain) = self.keychain.take() {
                let status = unsafe { SecKeychainDelete(keychain.as_concrete_TypeRef().cast()) };
                drop(keychain);
                if status != 0 {
                    let error = format!(
                        "SecKeychainDelete returned OSStatus {status}; owned path retained at {}",
                        self.path.display()
                    );
                    self.delete_error = Some(error.clone());
                    return Err(error);
                }
            }
            fs::remove_dir_all(&self.directory).map_err(|error| {
                let message = format!(
                    "temporary keychain directory cleanup failed; owned path retained at {} ({error})",
                    self.path.display()
                );
                self.delete_error = Some(message.clone());
                message
            })?;
            self.cleaned = true;
            Ok(())
        }
    }

    impl Drop for OwnedKeychain {
        fn drop(&mut self) {
            if let Err(error) = self.delete_owned() {
                eprintln!("owned test keychain cleanup failed: {error}");
                if !std::thread::panicking() {
                    panic!("{error}");
                }
            }
        }
    }

    #[test]
    #[ignore = "root must explicitly run this isolated macOS Keychain fixture"]
    fn isolated_temp_keychain_add_only_round_trip_and_reuse() {
        let mut fixture = OwnedKeychain::create();
        let items = [fixture.keychain().clone()];
        let first = load_or_create_in("fixture-plugin", Some(&items)).unwrap();
        let second = load_or_create_in("fixture-plugin", Some(&items)).unwrap();
        assert_eq!(first.as_ref(), second.as_ref());
        let other = load_or_create_in("another-plugin", Some(&items)).unwrap();
        assert_ne!(first.as_ref(), other.as_ref());
        drop(items);
        let owned_path = fixture.path().display().to_string();
        fixture
            .delete_owned()
            .unwrap_or_else(|error| panic!("failed to delete {owned_path}: {error}"));
    }

    #[test]
    fn only_not_found_and_duplicate_statuses_are_special() {
        assert!(is_item_not_found(Error::from_code(SEC_ITEM_NOT_FOUND)));
        assert!(!is_item_not_found(Error::from_code(SEC_DUPLICATE_ITEM)));
        assert!(is_duplicate_item(Error::from_code(SEC_DUPLICATE_ITEM)));
        assert!(!is_duplicate_item(Error::from_code(SEC_ITEM_NOT_FOUND)));
    }
}

#[cfg(all(test, target_os = "macos"))]
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SecKeychainDelete(keychain: *mut std::ffi::c_void) -> i32;
}
