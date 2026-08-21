use anyhow::{Result, anyhow};
use axum::{
    body::{Body, to_bytes},
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use crate::{
    identity::ChatIdentity,
    repository::{DavDeleteResult, DavPrecondition, DavWriteResult, RepositoryStore, dav_etag},
};

const MAX_DAV_BODY_BYTES: usize = 4 * 1024 * 1024;
const DESCRIPTOR_NAME: &str = ".turnfold-repository.json";

enum DavResource {
    Root,
    Descriptor,
    Objects,
    Object(String),
    Refs,
    Ref(String),
    Working,
    WorkingSnapshot(String),
    Missing,
}

struct DavEntry {
    href: String,
    collection: bool,
    etag: Option<String>,
    content_type: Option<&'static str>,
}

pub async fn handle(
    repository: RepositoryStore,
    identity: ChatIdentity,
    request: Request,
    mount: &'static str,
) -> Response {
    match handle_request(repository, identity, request, mount).await {
        Ok(response) => response,
        Err(error) => dav_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

async fn handle_request(
    repository: RepositoryStore,
    identity: ChatIdentity,
    request: Request,
    mount: &'static str,
) -> Result<Response> {
    let resource = parse_resource(request.uri().path(), mount);
    let method = request.method().clone();
    if method == Method::OPTIONS {
        return Ok(options_response());
    }
    if method.as_str() == "PROPFIND" {
        return propfind(&repository, &identity, &resource, request.headers(), mount);
    }
    if method.as_str() == "MKCOL" {
        return Ok(match resource {
            DavResource::Root | DavResource::Objects | DavResource::Refs | DavResource::Working => {
                status_response(StatusCode::METHOD_NOT_ALLOWED)
            }
            _ => status_response(StatusCode::CONFLICT),
        });
    }
    if method == Method::GET || method == Method::HEAD {
        return get_resource(&repository, &identity, resource, method == Method::HEAD);
    }
    if method == Method::PUT {
        let headers = request.headers().clone();
        let body = to_bytes(request.into_body(), MAX_DAV_BODY_BYTES)
            .await
            .map_err(|error| anyhow!("unable to read WebDAV request body: {error}"))?;
        let value: Value = serde_json::from_slice(&body)
            .map_err(|error| anyhow!("WebDAV request body is invalid JSON: {error}"))?;
        return put_resource(&repository, &identity, resource, &headers, &value);
    }
    if method == Method::DELETE {
        return delete_resource(&repository, &identity, resource, request.headers());
    }
    Ok(method_not_allowed())
}

fn get_resource(
    repository: &RepositoryStore,
    identity: &ChatIdentity,
    resource: DavResource,
    head_only: bool,
) -> Result<Response> {
    let result = match resource {
        DavResource::Root | DavResource::Descriptor => {
            let value = descriptor(identity);
            Some((value.clone(), dav_etag(&value)?))
        }
        DavResource::Object(id) => repository
            .dav_object(identity, &id)?
            .map(|stored| -> Result<(Value, String)> {
                let value = json!({
                    "type": "turnfold-message-object",
                    "version": 1,
                    "repositoryId": stored.repository_id,
                    "object": stored.object,
                });
                let etag = dav_etag(&value)?;
                Ok((value, etag))
            })
            .transpose()?,
        DavResource::Ref(id) => repository
            .dav_ref(identity, &id)?
            .map(|value| -> Result<(Value, String)> {
                let etag = dav_etag(&value)?;
                Ok((
                    json!({"type": "turnfold-conversation-ref", "version": 1, "ref": value}),
                    etag,
                ))
            })
            .transpose()?,
        DavResource::WorkingSnapshot(device_id) => repository
            .dav_working(identity, &device_id)?
            .map(|value| -> Result<(Value, String)> {
                let etag = dav_etag(&value)?;
                Ok((
                    json!({"type": "turnfold-working-snapshot", "version": 1, "snapshot": value}),
                    etag,
                ))
            })
            .transpose()?,
        DavResource::Objects | DavResource::Refs | DavResource::Working => {
            return Ok(status_response(StatusCode::METHOD_NOT_ALLOWED));
        }
        DavResource::Missing => None,
    };
    let Some((value, etag)) = result else {
        return Ok(status_response(StatusCode::NOT_FOUND));
    };
    json_response(StatusCode::OK, &value, &etag, head_only)
}

fn put_resource(
    repository: &RepositoryStore,
    identity: &ChatIdentity,
    resource: DavResource,
    headers: &HeaderMap,
    value: &Value,
) -> Result<Response> {
    match resource {
        DavResource::Descriptor => Ok(status_response(StatusCode::PRECONDITION_FAILED)),
        DavResource::Object(id) => {
            if header_text(headers, header::IF_NONE_MATCH) != Some("*") {
                return Ok(status_response(StatusCode::PRECONDITION_REQUIRED));
            }
            let envelope = value
                .as_object()
                .ok_or_else(|| anyhow!("WebDAV message envelope is invalid"))?;
            if envelope.get("type").and_then(Value::as_str) != Some("turnfold-message-object")
                || envelope.get("version").and_then(Value::as_i64) != Some(1)
            {
                return Ok(dav_error(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "WebDAV message envelope is invalid",
                ));
            }
            let repository_id = envelope
                .get("repositoryId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("WebDAV message repositoryId is required"))?;
            let object = envelope
                .get("object")
                .ok_or_else(|| anyhow!("WebDAV message object is required"))?;
            if object.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                return Ok(dav_error(
                    StatusCode::CONFLICT,
                    "WebDAV object id does not match its path",
                ));
            }
            if !repository.dav_put_object(identity, repository_id, object)? {
                return Ok(status_response(StatusCode::PRECONDITION_FAILED));
            }
            let etag = dav_etag(value)?;
            Ok(created_response(&etag))
        }
        DavResource::Ref(id) => {
            let Some(precondition) = write_precondition(headers) else {
                return Ok(status_response(StatusCode::PRECONDITION_REQUIRED));
            };
            let object = value
                .as_object()
                .filter(|value| {
                    value.get("type").and_then(Value::as_str) == Some("turnfold-conversation-ref")
                        && value.get("version").and_then(Value::as_i64) == Some(1)
                })
                .ok_or_else(|| anyhow!("WebDAV ref envelope is invalid"))?;
            let state = object
                .get("ref")
                .ok_or_else(|| anyhow!("WebDAV ref is required"))?;
            Ok(write_result(repository.dav_put_ref(
                identity,
                &id,
                state,
                &precondition,
            )?))
        }
        DavResource::WorkingSnapshot(device_id) => {
            let Some(precondition) = write_precondition(headers) else {
                return Ok(status_response(StatusCode::PRECONDITION_REQUIRED));
            };
            let object = value
                .as_object()
                .filter(|value| {
                    value.get("type").and_then(Value::as_str) == Some("turnfold-working-snapshot")
                        && value.get("version").and_then(Value::as_i64) == Some(1)
                })
                .ok_or_else(|| anyhow!("WebDAV working envelope is invalid"))?;
            let snapshot = object
                .get("snapshot")
                .ok_or_else(|| anyhow!("WebDAV working snapshot is required"))?;
            Ok(write_result(repository.dav_put_working(
                identity,
                &device_id,
                snapshot,
                &precondition,
            )?))
        }
        DavResource::Root | DavResource::Objects | DavResource::Refs | DavResource::Working => {
            Ok(status_response(StatusCode::METHOD_NOT_ALLOWED))
        }
        DavResource::Missing => Ok(status_response(StatusCode::CONFLICT)),
    }
}

fn delete_resource(
    repository: &RepositoryStore,
    identity: &ChatIdentity,
    resource: DavResource,
    headers: &HeaderMap,
) -> Result<Response> {
    let Some(precondition) = delete_precondition(headers) else {
        return Ok(status_response(StatusCode::PRECONDITION_REQUIRED));
    };
    let outcome = match resource {
        DavResource::Ref(id) => repository.dav_delete_ref(identity, &id, &precondition)?,
        DavResource::WorkingSnapshot(device_id) => {
            repository.dav_delete_working(identity, &device_id, &precondition)?
        }
        DavResource::Missing => DavDeleteResult::NotFound,
        _ => return Ok(status_response(StatusCode::METHOD_NOT_ALLOWED)),
    };
    Ok(match outcome {
        DavDeleteResult::Deleted => status_response(StatusCode::NO_CONTENT),
        DavDeleteResult::NotFound => status_response(StatusCode::NOT_FOUND),
        DavDeleteResult::PreconditionFailed => status_response(StatusCode::PRECONDITION_FAILED),
    })
}

fn propfind(
    repository: &RepositoryStore,
    identity: &ChatIdentity,
    resource: &DavResource,
    headers: &HeaderMap,
    mount: &str,
) -> Result<Response> {
    let depth = header_text(headers, "depth").unwrap_or("infinity");
    if !matches!(depth, "0" | "1") {
        return Ok(status_response(StatusCode::FORBIDDEN));
    }
    let mut entries = resource_entry(repository, identity, resource, mount)?;
    if entries.is_empty() {
        return Ok(status_response(StatusCode::NOT_FOUND));
    }
    if depth == "1" {
        entries.extend(resource_children(repository, identity, resource, mount)?);
    }
    let mut xml =
        String::from(r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">"#);
    for entry in entries {
        xml.push_str("<d:response><d:href>");
        xml.push_str(&xml_escape(&entry.href));
        xml.push_str("</d:href><d:propstat><d:prop><d:resourcetype>");
        if entry.collection {
            xml.push_str("<d:collection/>");
        }
        xml.push_str("</d:resourcetype>");
        if let Some(etag) = entry.etag {
            xml.push_str("<d:getetag>");
            xml.push_str(&xml_escape(&etag));
            xml.push_str("</d:getetag>");
        }
        if let Some(content_type) = entry.content_type {
            xml.push_str("<d:getcontenttype>");
            xml.push_str(content_type);
            xml.push_str("</d:getcontenttype>");
        }
        xml.push_str("</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>");
    }
    xml.push_str("</d:multistatus>");
    let mut response = (StatusCode::MULTI_STATUS, xml).into_response();
    dav_headers(response.headers_mut());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/xml; charset=utf-8"),
    );
    Ok(response)
}

fn resource_entry(
    repository: &RepositoryStore,
    identity: &ChatIdentity,
    resource: &DavResource,
    mount: &str,
) -> Result<Vec<DavEntry>> {
    let root = collection_href(mount, "");
    let entry = match resource {
        DavResource::Root => Some(collection_entry(root)),
        DavResource::Descriptor => {
            let value = descriptor(identity);
            Some(file_entry(
                resource_href(mount, DESCRIPTOR_NAME),
                dav_etag(&value)?,
            ))
        }
        DavResource::Objects => Some(collection_entry(collection_href(mount, "objects"))),
        DavResource::Object(id) => repository
            .dav_object(identity, id)?
            .map(|object| -> Result<DavEntry> {
                let value = json!({"type": "turnfold-message-object", "version": 1, "repositoryId": object.repository_id, "object": object.object});
                Ok(file_entry(
                    resource_href(mount, &format!("objects/{}.json", &id[7..])),
                    dav_etag(&value)?,
                ))
            })
            .transpose()?,
        DavResource::Refs => Some(collection_entry(collection_href(mount, "refs"))),
        DavResource::Ref(id) => repository
            .dav_ref(identity, id)?
            .map(|value| -> Result<DavEntry> {
                Ok(file_entry(
                    resource_href(mount, &format!("refs/{}.json", encode_name(id))),
                    dav_etag(&value)?,
                ))
            })
            .transpose()?,
        DavResource::Working => Some(collection_entry(collection_href(mount, "working"))),
        DavResource::WorkingSnapshot(device_id) => repository
            .dav_working(identity, device_id)?
            .map(|value| -> Result<DavEntry> {
                Ok(file_entry(
                    resource_href(
                        mount,
                        &format!("working/{}.json", encode_name(device_id)),
                    ),
                    dav_etag(&value)?,
                ))
            })
            .transpose()?,
        DavResource::Missing => None,
    };
    Ok(entry.into_iter().collect())
}

fn resource_children(
    repository: &RepositoryStore,
    identity: &ChatIdentity,
    resource: &DavResource,
    mount: &str,
) -> Result<Vec<DavEntry>> {
    match resource {
        DavResource::Root => {
            let value = descriptor(identity);
            Ok(vec![
                file_entry(resource_href(mount, DESCRIPTOR_NAME), dav_etag(&value)?),
                collection_entry(collection_href(mount, "objects")),
                collection_entry(collection_href(mount, "refs")),
                collection_entry(collection_href(mount, "working")),
            ])
        }
        DavResource::Objects => repository
            .dav_object_ids(identity)?
            .into_iter()
            .map(|id| {
                let object = repository
                    .dav_object(identity, &id)?
                    .ok_or_else(|| anyhow!("WebDAV object disappeared while listing"))?;
                let value = json!({"type": "turnfold-message-object", "version": 1, "repositoryId": object.repository_id, "object": object.object});
                Ok(file_entry(
                    resource_href(mount, &format!("objects/{}.json", &id[7..])),
                    dav_etag(&value)?,
                ))
            })
            .collect(),
        DavResource::Refs => repository
            .dav_refs(identity)?
            .into_iter()
            .map(|value| {
                let id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("stored WebDAV ref id is invalid"))?;
                Ok(file_entry(
                    resource_href(mount, &format!("refs/{}.json", encode_name(id))),
                    dav_etag(&value)?,
                ))
            })
            .collect(),
        DavResource::Working => repository
            .dav_working_ids(identity)?
            .into_iter()
            .map(|device_id| {
                let value = repository
                    .dav_working(identity, &device_id)?
                    .ok_or_else(|| anyhow!("WebDAV working snapshot disappeared while listing"))?;
                Ok(file_entry(
                    resource_href(
                        mount,
                        &format!("working/{}.json", encode_name(&device_id)),
                    ),
                    dav_etag(&value)?,
                ))
            })
            .collect(),
        _ => Ok(Vec::new()),
    }
}

fn parse_resource(path: &str, mount: &str) -> DavResource {
    let relative = if mount.is_empty() {
        path.trim_start_matches('/')
    } else if path == mount {
        ""
    } else if let Some(relative) = path.strip_prefix(&format!("{mount}/")) {
        relative
    } else {
        return DavResource::Missing;
    };
    let relative = relative.trim_end_matches('/');
    match relative {
        "" => DavResource::Root,
        DESCRIPTOR_NAME => DavResource::Descriptor,
        "objects" => DavResource::Objects,
        "refs" => DavResource::Refs,
        "working" => DavResource::Working,
        _ => {
            let Some((collection, filename)) = relative.split_once('/') else {
                return DavResource::Missing;
            };
            if filename.contains('/') || !filename.ends_with(".json") {
                return DavResource::Missing;
            }
            let stem = &filename[..filename.len() - 5];
            match collection {
                "objects"
                    if stem.len() == 64 && stem.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
                {
                    DavResource::Object(format!("sha256:{}", stem.to_ascii_lowercase()))
                }
                "refs" => decode_name(stem).map_or(DavResource::Missing, DavResource::Ref),
                "working" => {
                    decode_name(stem).map_or(DavResource::Missing, DavResource::WorkingSnapshot)
                }
                _ => DavResource::Missing,
            }
        }
    }
}

fn descriptor(identity: &ChatIdentity) -> Value {
    json!({
        "type": "turnfold-webdav-repository",
        "version": 1,
        "id": format!("turnfold-{}", identity.key()),
    })
}

fn write_precondition(headers: &HeaderMap) -> Option<DavPrecondition> {
    if header_text(headers, header::IF_NONE_MATCH) == Some("*") {
        return Some(DavPrecondition::Create);
    }
    header_text(headers, header::IF_MATCH)
        .filter(|value| !value.is_empty() && *value != "*")
        .map(|value| DavPrecondition::Match(value.to_owned()))
}

fn delete_precondition(headers: &HeaderMap) -> Option<DavPrecondition> {
    header_text(headers, header::IF_MATCH)
        .filter(|value| !value.is_empty() && *value != "*")
        .map(|value| DavPrecondition::Match(value.to_owned()))
}

fn write_result(result: DavWriteResult) -> Response {
    match result {
        DavWriteResult::Created { etag } => created_response(&etag),
        DavWriteResult::Updated { etag } => empty_etag_response(StatusCode::NO_CONTENT, &etag),
        DavWriteResult::PreconditionFailed => status_response(StatusCode::PRECONDITION_FAILED),
    }
}

fn json_response(
    status: StatusCode,
    value: &Value,
    etag: &str,
    head_only: bool,
) -> Result<Response> {
    let encoded = serde_json::to_vec(value)?;
    let body = if head_only {
        Body::empty()
    } else {
        Body::from(encoded.clone())
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ETAG, etag)
        .header(header::CONTENT_LENGTH, encoded.len())
        .body(body)?;
    dav_headers(response.headers_mut());
    Ok(response)
}

fn created_response(etag: &str) -> Response {
    empty_etag_response(StatusCode::CREATED, etag)
}

fn empty_etag_response(status: StatusCode, etag: &str) -> Response {
    let mut response = status_response(status);
    if let Ok(value) = HeaderValue::from_str(etag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

fn method_not_allowed() -> Response {
    let mut response = status_response(StatusCode::METHOD_NOT_ALLOWED);
    response.headers_mut().insert(
        header::ALLOW,
        HeaderValue::from_static("OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL"),
    );
    response
}

fn options_response() -> Response {
    let mut response = status_response(StatusCode::NO_CONTENT);
    response.headers_mut().insert(
        header::ALLOW,
        HeaderValue::from_static("OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL"),
    );
    response
}

fn status_response(status: StatusCode) -> Response {
    let mut response = status.into_response();
    dav_headers(response.headers_mut());
    response
}

fn dav_error(status: StatusCode, message: impl Into<String>) -> Response {
    let mut response = (status, axum::Json(json!({"error": message.into()}))).into_response();
    dav_headers(response.headers_mut());
    response
}

fn dav_headers(headers: &mut HeaderMap) {
    headers.insert("dav", HeaderValue::from_static("1"));
    headers.insert("ms-author-via", HeaderValue::from_static("DAV"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

fn collection_entry(href: String) -> DavEntry {
    DavEntry {
        href,
        collection: true,
        etag: None,
        content_type: None,
    }
}

fn file_entry(href: String, etag: String) -> DavEntry {
    DavEntry {
        href,
        collection: false,
        etag: Some(etag),
        content_type: Some("application/json"),
    }
}

fn collection_href(mount: &str, relative: &str) -> String {
    let root = if mount.is_empty() { "" } else { mount };
    if relative.is_empty() {
        format!("{root}/")
    } else {
        format!("{root}/{relative}/")
    }
}

fn resource_href(mount: &str, relative: &str) -> String {
    let root = if mount.is_empty() { "" } else { mount };
    format!("{root}/{relative}")
}

fn encode_name(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(value.as_bytes())
}

fn decode_name(value: &str) -> Option<String> {
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    (encode_name(&decoded) == value && !decoded.trim().is_empty()).then_some(decoded)
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn header_text(headers: &HeaderMap, name: impl axum::http::header::AsHeaderName) -> Option<&str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_canonical_virtual_paths() {
        assert!(matches!(parse_resource("/dav/", "/dav"), DavResource::Root));
        assert!(matches!(
            parse_resource(
                "/dav/objects/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
                "/dav"
            ),
            DavResource::Object(_)
        ));
        let encoded = encode_name("conversation/one");
        assert!(matches!(
            parse_resource(&format!("/dav/refs/{encoded}.json"), "/dav"),
            DavResource::Ref(id) if id == "conversation/one"
        ));
        assert!(matches!(
            parse_resource("/dav/refs/not canonical=.json", "/dav"),
            DavResource::Missing
        ));
    }
}
