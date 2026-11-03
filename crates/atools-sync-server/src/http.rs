use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{ws::WebSocketUpgrade, DefaultBodyLimit, FromRequestParts, Request, State},
    http::{header::UPGRADE, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;

use crate::{
    auth::{AuthError, AuthService, TokenPair},
    budgets::run_bounded,
    websocket, AppState,
};

const AUTH_BODY_MAX_BYTES: usize = 64 * 1024;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", any(root))
        .route("/health", any(health))
        .route("/api/auth", any(auth))
        .route("/api/auth/captcha-config", any(captcha_config))
        .route("/api/auth/refresh", any(refresh))
        .route("/api/login", any(login))
        .route("/api/register", any(register))
        .route("/ws", any(ws))
        .layer(DefaultBodyLimit::max(AUTH_BODY_MAX_BYTES))
        .with_state(state)
}

async fn root(State(state): State<AppState>, request: Request) -> Response {
    let is_websocket_upgrade = request
        .headers()
        .get(UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if is_websocket_upgrade {
        return websocket_upgrade(request, state).await;
    }
    Json(json!({
        "name": "ZTools Sync Server",
        "edition": "standalone",
        "protocolVersion": 2
    }))
    .into_response()
}

async fn ws(State(state): State<AppState>, request: Request) -> Response {
    websocket_upgrade(request, state).await
}

async fn websocket_upgrade(request: Request, state: AppState) -> Response {
    let (mut parts, _) = request.into_parts();
    match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(upgrade) => {
            let connection_permit = match state
                .budgets
                .websocket_connections
                .clone()
                .try_acquire_owned()
            {
                Ok(permit) => permit,
                Err(_) => return busy_response(),
            };
            upgrade
                .max_message_size(websocket::max_message_size())
                .on_upgrade(move |socket| websocket::serve(socket, state, connection_permit))
                .into_response()
        }
        Err(rejection) => rejection.into_response(),
    }
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "edition": "standalone",
        "connections": state.active_connections.load(std::sync::atomic::Ordering::Relaxed)
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    uid: String,
    password: String,
    #[serde(default)]
    captcha_verify_param: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshRequest {
    refresh_token: String,
}

async fn auth(State(state): State<AppState>, method: Method, body: Bytes) -> Response {
    if method != Method::POST {
        return not_found();
    }
    let Ok(credentials) = parse_body::<Credentials>(&body) else {
        return error(StatusCode::BAD_REQUEST, "uid and password required");
    };
    if credentials.uid.trim().is_empty() || credentials.password.is_empty() {
        return error(StatusCode::BAD_REQUEST, "uid and password required");
    }
    let _captcha = credentials.captcha_verify_param;
    let uid = credentials.uid;
    let password = credentials.password;
    let allow_registration = state.config.allow_registration;
    let result = run_auth(&state, move |auth| {
        if allow_registration {
            auth.auth_or_create(&uid, &password)
        } else {
            auth.login(&uid, &password).map(|tokens| (tokens, false))
        }
    })
    .await;
    let (tokens, is_new) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => return auth_error(error, "密码错误"),
        Err(()) => return busy_response(),
    };
    Json(json!({ "token": tokens.token, "refreshToken": tokens.refresh_token, "isNew": is_new }))
        .into_response()
}

async fn login(State(state): State<AppState>, method: Method, body: Bytes) -> Response {
    if method != Method::POST {
        return not_found();
    }
    let Ok(credentials) = parse_body::<Credentials>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    };
    if credentials.uid.trim().is_empty() || credentials.password.is_empty() {
        return error(StatusCode::BAD_REQUEST, "uid and password required");
    }
    let _captcha = credentials.captcha_verify_param;
    let uid = credentials.uid;
    let password = credentials.password;
    match run_auth(&state, move |auth| auth.login(&uid, &password)).await {
        Ok(Ok(tokens)) => token_response(tokens),
        Ok(Err(error)) => auth_error(error, "Invalid credentials"),
        Err(()) => busy_response(),
    }
}

async fn refresh(State(state): State<AppState>, method: Method, body: Bytes) -> Response {
    if method != Method::POST {
        return not_found();
    }
    let Ok(request) = parse_body::<RefreshRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "refreshToken required");
    };
    if request.refresh_token.is_empty() {
        return error(StatusCode::BAD_REQUEST, "refreshToken required");
    }
    let refresh_token = request.refresh_token;
    match run_auth(&state, move |auth| auth.refresh(&refresh_token)).await {
        Ok(Ok(tokens)) => token_response(tokens),
        Ok(Err(AuthError::InvalidRefreshToken)) => {
            error(StatusCode::UNAUTHORIZED, "Invalid refresh token")
        }
        Ok(Err(error)) => auth_error(error, "Invalid refresh token"),
        Err(()) => busy_response(),
    }
}

async fn captcha_config(method: Method) -> Response {
    if method != Method::GET {
        return not_found();
    }
    Json(json!({ "enabled": false })).into_response()
}

async fn register(State(state): State<AppState>, method: Method, body: Bytes) -> Response {
    if !state.config.allow_registration || method != Method::POST {
        return not_found();
    }
    let Ok(credentials) = parse_body::<Credentials>(&body) else {
        return error(StatusCode::BAD_REQUEST, "uid and password required");
    };
    if credentials.uid.trim().is_empty() || credentials.password.is_empty() {
        return error(StatusCode::BAD_REQUEST, "uid and password required");
    }
    let _captcha = credentials.captcha_verify_param;
    let uid = credentials.uid;
    let password = credentials.password;
    match run_auth(&state, move |auth| {
        if auth.create_user(&uid, &password)? {
            auth.login(&uid, &password).map(Some)
        } else {
            Ok(None)
        }
    })
    .await
    {
        Ok(Ok(Some(tokens))) => token_response(tokens),
        Ok(Ok(None)) => error(StatusCode::BAD_REQUEST, "account already exists"),
        Ok(Err(error)) => auth_error(error, "account creation failed"),
        Err(()) => busy_response(),
    }
}

async fn run_auth<T, F>(state: &AppState, operation: F) -> Result<Result<T, AuthError>, ()>
where
    T: Send + 'static,
    F: FnOnce(Arc<AuthService>) -> Result<T, AuthError> + Send + 'static,
{
    let auth = Arc::clone(&state.auth);
    run_bounded(state.budgets.auth_work.clone(), move || operation(auth))
        .await
        .map_err(|_| ())
}

fn parse_body<T: DeserializeOwned>(body: &[u8]) -> Result<T, ()> {
    if body.len() > AUTH_BODY_MAX_BYTES {
        return Err(());
    }
    serde_json::from_slice(body).map_err(|_| ())
}

fn auth_error(cause: AuthError, public_message: &str) -> Response {
    let status = match cause {
        AuthError::InvalidCredentials
        | AuthError::InvalidRefreshToken
        | AuthError::InvalidAccessToken => StatusCode::UNAUTHORIZED,
        AuthError::PasswordHash
        | AuthError::TokenSigning
        | AuthError::Randomness
        | AuthError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error(status, public_message)
}

fn token_response(tokens: TokenPair) -> Response {
    Json(json!({ "token": tokens.token, "refreshToken": tokens.refresh_token })).into_response()
}

fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "Not found")
}

fn busy_response() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "Sync server is busy")
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
