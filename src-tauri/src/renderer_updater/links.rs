//! An accepted changelog click owns immutable parameters; view revocation only revokes its reply.
use super::{error, protocol, Error};
use std::future::Future;
pub(super) struct Accepted {
    window: String,
    candidate: String,
    href: String,
}
pub(super) struct Completed {
    pub window: String,
    pub candidate: String,
}
impl Accepted {
    pub fn accept(
        window: &str,
        candidate: &str,
        raw: &str,
        authorize: impl FnOnce() -> Result<(), Error>,
    ) -> Result<Self, Error> {
        if !crate::updater::entry::valid_id(window) || !crate::updater::entry::valid_id(candidate) {
            return Err(error("invalid_request"));
        }
        let href = protocol::link(raw)?;
        authorize()?; // Linearization: source+displayed/current candidate checked after URL normalization.
        Ok(Self {
            window: window.into(),
            candidate: candidate.into(),
            href,
        })
    }
    // Consuming the token prevents retry/repointing of this accepted action.
    pub async fn execute<F: Future<Output = Result<(), Error>>>(
        self,
        open: impl FnOnce(String) -> F,
    ) -> Result<Completed, Error> {
        let Self {
            window,
            candidate,
            href,
        } = self;
        open(href).await?;
        Ok(Completed { window, candidate })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer_updater::{
        bundle::Bundle,
        runtime::{Runtime, Session},
    };
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn accepted_click_survives_close_with_original_url_once_but_new_click_and_reply_are_denied(
    ) {
        let runtime = Runtime::default();
        let window = "a".repeat(32);
        let candidate = "b".repeat(32);
        let mut session = Session::new(
            window.clone(),
            Arc::new(Bundle {
                assets: Default::default(),
            }),
            true,
            candidate.clone(),
        );
        session.ready = true;
        *runtime.session.lock() = Some(session.clone());
        let current = Mutex::new((candidate.clone(), "1.0.1".to_string()));
        let mut href = "https://example.com/first".to_string();
        let accepted = Accepted::accept(&window, &candidate, &href, || {
            runtime
                .authorize_displayed(&window, &candidate, || Ok(current.lock().unwrap().clone()))
                .map(|_| ())
        })
        .unwrap();
        runtime.invalidate(&window);
        *current.lock().unwrap() = ("c".repeat(32), "1.0.2".into());
        href = "https://example.com/replaced".into();
        let opened = Mutex::new(Vec::new());
        let observed = &opened;
        let completed = accepted
            .execute(|url| async move {
                observed.lock().unwrap().push(url);
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(*opened.lock().unwrap(), ["https://example.com/first"]);
        assert_eq!(completed.window, window);
        assert_eq!(completed.candidate, candidate);
        assert!(runtime
            .authorize_displayed(&completed.window, &completed.candidate, || Ok(current
                .lock()
                .unwrap()
                .clone()))
            .is_err());
        assert!(Accepted::accept(&window, &candidate, &href, || runtime
            .authorize_displayed(&window, &candidate, || Ok(current.lock().unwrap().clone()))
            .map(|_| ()))
        .is_err());
        assert_eq!(opened.lock().unwrap().len(), 1);
    }
}
