use super::protocol::{read_frame, write_frame};
use crate::sidecar::SidecarError;
use serde_json::{json, Value};
use tokio::net::{UnixListener, UnixStream};

pub(super) async fn accept_authenticated(
    control_listener: &UnixListener,
    event_listener: &UnixListener,
    token: &str,
) -> Result<(UnixStream, UnixStream), SidecarError> {
    let (control, events) =
        tokio::try_join!(accept_one(control_listener), accept_one(event_listener))?;
    let (mut control, mut events) = (control, events);
    tokio::try_join!(
        authenticate_stream(&mut control, "control", token),
        authenticate_stream(&mut events, "events", token)
    )?;
    write_frame(&mut control, &json!({"schemaVersion":1,"ready":true})).await?;
    Ok((control, events))
}

async fn authenticate_stream(
    stream: &mut UnixStream,
    role: &str,
    token: &str,
) -> Result<(), SidecarError> {
    validate_greeting(read_frame(stream).await?, role, token)
}

async fn accept_one(listener: &UnixListener) -> Result<UnixStream, SidecarError> {
    listener
        .accept()
        .await
        .map(|(stream, _)| stream)
        .map_err(|error| {
            SidecarError::Crashed(format!("managed child socket accept failed: {error}"))
        })
}

fn validate_greeting(
    greeting: Option<Value>,
    expected_role: &str,
    token: &str,
) -> Result<(), SidecarError> {
    let Some(greeting) = greeting else {
        return Err(SidecarError::Protocol(format!(
            "managed child {expected_role} socket closed before authentication"
        )));
    };
    let object = greeting.as_object().ok_or_else(|| {
        SidecarError::Protocol("managed child socket greeting must be an object".into())
    })?;
    if object.len() != 3
        || object.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || object.get("role").and_then(Value::as_str) != Some(expected_role)
        || object.get("token").and_then(Value::as_str) != Some(token)
    {
        return Err(SidecarError::Protocol(format!(
            "managed child {expected_role} socket authentication failed"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_greeting;
    use crate::sidecar::SidecarError;
    use serde_json::json;

    #[test]
    fn greetings_require_version_role_and_exact_token() {
        assert!(validate_greeting(
            Some(json!({
                "schemaVersion":1,"role":"control","token":"secret"
            })),
            "control",
            "secret"
        )
        .is_ok());
        assert!(matches!(
            validate_greeting(
                Some(json!({
                    "schemaVersion":1,"role":"events","token":"secret"
                })),
                "control",
                "secret"
            ),
            Err(SidecarError::Protocol(_))
        ));
        assert!(matches!(
            validate_greeting(
                Some(json!({
                    "schemaVersion":1,"role":"control","token":"wrong"
                })),
                "control",
                "secret"
            ),
            Err(SidecarError::Protocol(_))
        ));
    }
}
