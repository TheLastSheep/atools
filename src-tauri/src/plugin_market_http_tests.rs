use super::{fetch_json_metadata_with_policy, is_allowed_redirect, MAX_BODY_BYTES};
use std::{future::Future, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use url::Url;

type Handler = Box<dyn Fn(&str) -> Vec<u8> + Send + Sync>;

async fn spawn_server(max_requests: usize, handler: Handler) -> (Url, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        for _ in 0..max_requests {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let request = read_request(&mut stream).await;
            let path = request.split_whitespace().nth(1).unwrap_or("/");
            let response = handler(path);
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
        }
    });
    (
        Url::parse(&format!("http://{address}/start")).unwrap(),
        task,
    )
}

async fn spawn_delayed_body_server() -> (Url, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let _ = read_request(&mut stream).await;
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n")
            .await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let _ = stream.write_all(b"{}").await;
    });
    (Url::parse(&format!("http://{address}/slow")).unwrap(), task)
}

async fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") && bytes.len() < 8192 {
        let Ok(read) = stream.read(&mut chunk).await else {
            break;
        };
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut result = format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    result.extend_from_slice(body);
    result
}

async fn run_with_server<F, Fut>(
    handler: Handler,
    request: F,
) -> (Result<serde_json::Value, String>, JoinHandle<()>)
where
    F: FnOnce(Url) -> Fut,
    Fut: Future<Output = Result<serde_json::Value, String>>,
{
    let (url, server) = spawn_server(6, handler).await;
    (request(url).await, server)
}

#[tokio::test]
async fn reads_json_body_split_into_http_chunks() {
    let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\n{\r\n1\r\n}\r\n0\r\n\r\n".to_vec();
    let (result, server) = run_with_server(Box::new(move |_| chunked.clone()), |url| async move {
        fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
    })
    .await;
    assert_eq!(result.unwrap(), serde_json::json!({}));
    server.abort();
}

#[tokio::test]
async fn rejects_declared_and_chunked_bodies_over_two_mib() {
    let too_large = response(
        "200 OK",
        "Content-Type: application/json\r\n",
        &vec![b' '; MAX_BODY_BYTES + 1],
    );
    let (result, server) =
        run_with_server(Box::new(move |_| too_large.clone()), |url| async move {
            fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
        })
        .await;
    assert!(result.unwrap_err().contains("exceeds 2097152 bytes"));
    server.abort();

    let mut chunked =
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
    for size in [1024 * 1024, 1024 * 1024, 1] {
        chunked.extend_from_slice(format!("{size:x}\r\n").as_bytes());
        chunked.extend(std::iter::repeat(b' ').take(size));
        chunked.extend_from_slice(b"\r\n");
    }
    chunked.extend_from_slice(b"0\r\n\r\n");
    let (result, server) = run_with_server(Box::new(move |_| chunked.clone()), |url| async move {
        fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
    })
    .await;
    assert!(result.unwrap_err().contains("exceeds 2097152 bytes"));
    server.abort();
}

#[tokio::test]
async fn follows_at_most_two_same_host_redirects() {
    let handler: Handler = Box::new(|path| match path {
        "/start" => response("302 Found", "Location: /second\r\n", b""),
        "/second" => response("307 Temporary Redirect", "Location: /third\r\n", b""),
        "/third" => response(
            "200 OK",
            "Content-Type: application/json\r\n",
            b"{\"ok\":true}",
        ),
        _ => response("302 Found", "Location: /extra\r\n", b""),
    });
    let (result, server) = run_with_server(handler, |url| async move {
        fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
    })
    .await;
    assert_eq!(result.unwrap(), serde_json::json!({"ok": true}));
    server.abort();

    let handler: Handler = Box::new(|path| {
        let next = match path {
            "/start" => "/second",
            "/second" => "/third",
            _ => "/fourth",
        };
        response("302 Found", &format!("Location: {next}\r\n"), b"")
    });
    let (result, server) = run_with_server(handler, |url| async move {
        fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
    })
    .await;
    assert!(result.unwrap_err().contains("redirect limit"));
    server.abort();
}

#[tokio::test]
async fn refuses_cross_host_redirect_without_following_it() {
    let handler: Handler = Box::new(|_| {
        response(
            "302 Found",
            "Location: http://example.invalid/metadata\r\n",
            b"",
        )
    });
    let (result, server) = run_with_server(handler, |url| async move {
        fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
    })
    .await;
    assert!(result.unwrap_err().contains("same host"));
    server.abort();
}

#[test]
fn redirect_policy_allows_https_upgrade_and_rejects_downgrade_or_port_switch() {
    let http = Url::parse("http://market.example/api").unwrap();
    let upgraded = Url::parse("https://market.example/api").unwrap();
    let downgraded = Url::parse("http://market.example/api").unwrap();
    let other_port = Url::parse("http://market.example:8080/api").unwrap();
    assert!(is_allowed_redirect(&http, &upgraded));
    assert!(!is_allowed_redirect(&upgraded, &downgraded));
    assert!(!is_allowed_redirect(&http, &other_port));
}

#[tokio::test]
async fn total_deadline_covers_waiting_for_body() {
    let (slow_url, server) = spawn_delayed_body_server().await;
    let result = fetch_json_metadata_with_policy(&slow_url, Duration::from_millis(30)).await;
    assert!(result.unwrap_err().contains("timed out"));
    server.abort();
}

#[tokio::test]
async fn rejects_non_http_or_userinfo_urls_and_treats_http_errors_as_failures() {
    let file_url = Url::parse("file:///tmp/catalog.json").unwrap();
    assert!(
        fetch_json_metadata_with_policy(&file_url, Duration::from_secs(1))
            .await
            .unwrap_err()
            .contains("http or https")
    );
    let userinfo_url = Url::parse("http://user:secret@example.com/metadata").unwrap();
    assert!(
        fetch_json_metadata_with_policy(&userinfo_url, Duration::from_secs(1))
            .await
            .unwrap_err()
            .contains("userinfo")
    );

    let long_url = Url::parse(&format!("http://example.com/{}", "x".repeat(2100))).unwrap();
    assert!(
        fetch_json_metadata_with_policy(&long_url, Duration::from_secs(1))
            .await
            .unwrap_err()
            .contains("exceeds 2048")
    );

    let handler: Handler = Box::new(|_| {
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            b"{\"error\":\"business failure\"}",
        )
    });
    let (result, server) = run_with_server(handler, |url| async move {
        fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
    })
    .await;
    assert_eq!(
        result.unwrap(),
        serde_json::json!({"error": "business failure"})
    );
    server.abort();

    let handler: Handler = Box::new(|_| response("503 Service Unavailable", "", b"{}"));
    let (result, server) = run_with_server(handler, |url| async move {
        fetch_json_metadata_with_policy(&url, Duration::from_secs(2)).await
    })
    .await;
    assert!(result.unwrap_err().contains("http status 503"));
    server.abort();
}
