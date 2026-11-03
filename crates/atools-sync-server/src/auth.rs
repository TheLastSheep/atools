use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bcrypt::{hash, verify};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::Store;

const BCRYPT_COST: u32 = 10;
const ACCESS_TOKEN_TTL_SECS: u64 = 48 * 60 * 60;
const REFRESH_TOKEN_TTL_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, Error)]
pub(crate) enum AuthError {
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("invalid refresh token")]
    InvalidRefreshToken,
    #[error("invalid access token")]
    InvalidAccessToken,
    #[error("password hashing failed")]
    PasswordHash,
    #[error("token signing failed")]
    TokenSigning,
    #[error("operating system random generator failed")]
    Randomness,
    #[error(transparent)]
    Store(#[from] crate::StoreError),
}

#[derive(Clone)]
pub(crate) struct AuthService {
    store: Store,
    secret: Vec<u8>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenPair {
    pub token: String,
    #[serde(rename = "refreshToken")]
    pub refresh_token: String,
}

#[derive(Serialize, Deserialize)]
struct Claims {
    uid: String,
    ver: i64,
    exp: u64,
    iat: u64,
}

impl AuthService {
    pub(crate) fn new(store: Store, secret: Vec<u8>) -> Self {
        Self { store, secret }
    }

    pub(crate) fn ensure_user(&self, uid: &str, password: &str) -> Result<bool, AuthError> {
        if self.store.user_exists(uid)? {
            return Ok(false);
        }
        self.create_user(uid, password)
    }

    pub(crate) fn create_user(&self, uid: &str, password: &str) -> Result<bool, AuthError> {
        if uid.trim().is_empty() || password.is_empty() {
            return Err(AuthError::InvalidCredentials);
        }
        let hash = hash(password, BCRYPT_COST).map_err(|_| AuthError::PasswordHash)?;
        self.store.create_user(uid, &hash).map_err(AuthError::from)
    }

    pub(crate) fn auth_or_create(
        &self,
        uid: &str,
        password: &str,
    ) -> Result<(TokenPair, bool), AuthError> {
        let is_new = if self.store.user_exists(uid)? {
            false
        } else {
            self.create_user(uid, password)?
        };
        self.login(uid, password).map(|tokens| (tokens, is_new))
    }

    pub(crate) fn login(&self, uid: &str, password: &str) -> Result<TokenPair, AuthError> {
        let Some(password_hash) = self.store.password_hash(uid)? else {
            return Err(AuthError::InvalidCredentials);
        };
        if !verify(password, &password_hash).map_err(|_| AuthError::PasswordHash)? {
            return Err(AuthError::InvalidCredentials);
        }
        self.issue_tokens(uid)
    }

    pub(crate) fn issue_tokens(&self, uid: &str) -> Result<TokenPair, AuthError> {
        let token = self.sign(uid)?;
        let refresh_token = new_refresh_token()?;
        self.store.insert_refresh_token(
            uid,
            &hash_refresh_token(&refresh_token),
            now_secs().saturating_add(REFRESH_TOKEN_TTL_SECS) as i64 * 1000,
        )?;
        Ok(TokenPair {
            token,
            refresh_token,
        })
    }

    pub(crate) fn refresh(&self, refresh_token: &str) -> Result<TokenPair, AuthError> {
        let old_hash = hash_refresh_token(refresh_token);
        let now = now_secs() as i64 * 1000;
        let uid = self
            .store
            .refresh_owner(&old_hash, now)?
            .ok_or(AuthError::InvalidRefreshToken)?;
        let token = self.sign(&uid)?;
        let next_refresh = new_refresh_token()?;
        let expires_at = (now_secs().saturating_add(REFRESH_TOKEN_TTL_SECS) as i64) * 1000;
        let rotated = self.store.rotate_refresh_token(
            &old_hash,
            &uid,
            &hash_refresh_token(&next_refresh),
            expires_at,
            now,
        )?;
        if !rotated {
            return Err(AuthError::InvalidRefreshToken);
        }
        Ok(TokenPair {
            token,
            refresh_token: next_refresh,
        })
    }

    pub(crate) fn verify(&self, token: &str) -> Result<String, AuthError> {
        let validation = Validation::new(Algorithm::HS256);
        let claims = decode::<Claims>(token, &DecodingKey::from_secret(&self.secret), &validation)
            .map_err(|_| AuthError::InvalidAccessToken)?
            .claims;
        if claims.uid.is_empty() || claims.ver != 0 || !self.store.user_exists(&claims.uid)? {
            return Err(AuthError::InvalidAccessToken);
        }
        Ok(claims.uid)
    }

    fn sign(&self, uid: &str) -> Result<String, AuthError> {
        let now = now_secs();
        let claims = Claims {
            uid: uid.to_owned(),
            ver: 0,
            exp: now.saturating_add(ACCESS_TOKEN_TTL_SECS),
            iat: now,
        };
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(&self.secret),
        )
        .map_err(|_| AuthError::TokenSigning)
    }
}

fn new_refresh_token() -> Result<String, AuthError> {
    let mut raw = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut raw)
        .map_err(|_| AuthError::Randomness)?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

fn hash_refresh_token(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
