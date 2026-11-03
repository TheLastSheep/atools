use rusqlite::{params, OptionalExtension};

use super::{Store, StoreError};
use crate::store::sync::now_ms;

impl Store {
    pub(crate) fn create_user(&self, uid: &str, password_hash: &str) -> Result<bool, StoreError> {
        let changed = self.lock()?.execute(
            "INSERT OR IGNORE INTO users(uid,nickname,password_hash,created_at) VALUES(?1,?1,?2,?3)",
            params![uid, password_hash, now_ms()],
        )?;
        Ok(changed == 1)
    }

    pub(crate) fn password_hash(&self, uid: &str) -> Result<Option<String>, StoreError> {
        self.lock()?
            .query_row(
                "SELECT password_hash FROM users WHERE uid=?1",
                [uid],
                |row| row.get(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub(crate) fn user_exists(&self, uid: &str) -> Result<bool, StoreError> {
        let count: i64 = self.lock()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM users WHERE uid=?1)",
            [uid],
            |row| row.get(0),
        )?;
        Ok(count != 0)
    }

    pub(crate) fn insert_refresh_token(
        &self,
        uid: &str,
        token_hash: &str,
        expires_at: i64,
    ) -> Result<(), StoreError> {
        self.lock()?.execute(
            "INSERT INTO refresh_tokens(token_hash,uid,expires_at,created_at) VALUES(?1,?2,?3,?4)",
            params![token_hash, uid, expires_at, now_ms()],
        )?;
        Ok(())
    }

    pub(crate) fn refresh_owner(
        &self,
        token_hash: &str,
        now: i64,
    ) -> Result<Option<String>, StoreError> {
        self.lock()?.query_row(
            "SELECT uid FROM refresh_tokens WHERE token_hash=?1 AND expires_at>?2 AND used_at=0 AND revoked_at=0",
            params![token_hash, now],
            |row| row.get(0),
        ).optional().map_err(StoreError::from)
    }

    pub(crate) fn rotate_refresh_token(
        &self,
        old_hash: &str,
        uid: &str,
        new_hash: &str,
        expires_at: i64,
        now: i64,
    ) -> Result<bool, StoreError> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let changed = tx.execute(
            "UPDATE refresh_tokens SET used_at=?1 WHERE token_hash=?2 AND uid=?3 AND used_at=0 AND revoked_at=0 AND expires_at>?1",
            params![now, old_hash, uid],
        )?;
        if changed != 1 {
            tx.rollback()?;
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO refresh_tokens(token_hash,uid,expires_at,created_at) VALUES(?1,?2,?3,?4)",
            params![new_hash, uid, expires_at, now],
        )?;
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::OptionalExtension;

    use super::*;
    use crate::auth::AuthService;

    #[test]
    fn refresh_tokens_are_hashed_and_single_use() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("sync.db")).unwrap();
        let auth = AuthService::new(store.clone(), vec![0x42; 32]);
        assert!(auth.create_user("alice", "secret").unwrap());
        let first = auth.login("alice", "secret").unwrap();
        assert_eq!(auth.verify(&first.token).unwrap(), "alice");
        let rotated = auth.refresh(&first.refresh_token).unwrap();
        assert!(auth.refresh(&first.refresh_token).is_err());
        assert_eq!(auth.verify(&rotated.token).unwrap(), "alice");

        let connection = store.lock().unwrap();
        let stored: String = connection.query_row(
            "SELECT token_hash FROM refresh_tokens WHERE uid='alice' ORDER BY created_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        ).optional().unwrap().unwrap();
        assert!(stored != rotated.refresh_token);
        assert_eq!(stored.len(), 64);
    }
}
