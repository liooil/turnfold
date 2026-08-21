use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use reqwest::{
    Client, Method, Url,
    header::{self, HeaderMap, HeaderName, HeaderValue},
};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    identity::ChatIdentity,
    vault::{ProviderExecutionConfig, VaultStore},
};

const MAX_PROVIDER_REQUEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct ProviderAgent {
    vault: VaultStore,
    client: Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderExecuteRequest {
    pub provider_id: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    pub operation: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub body: Option<Value>,
}

impl ProviderAgent {
    pub fn new(vault: VaultStore) -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!("turnfold/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .context("unable to initialize Provider HTTP client")?;
        Ok(Self { vault, client })
    }

    pub fn vault(&self) -> &VaultStore {
        &self.vault
    }

    pub async fn execute(
        &self,
        identity: &ChatIdentity,
        input: ProviderExecuteRequest,
    ) -> Result<reqwest::Response> {
        let operation = input.operation.as_str();
        if !matches!(operation, "stream" | "discover") {
            bail!("unsupported Provider operation");
        }
        let execution = self.vault.execution_config(
            identity,
            &input.provider_id,
            input.credential_id.as_deref(),
            if operation == "stream" {
                "provider.execute"
            } else {
                "provider.discover"
            },
        )?;
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static(if operation == "discover" {
                "application/json"
            } else {
                "text/event-stream"
            }),
        );
        let mut request = if operation == "discover" {
            if input.model.is_some() || input.body.is_some() {
                bail!("discover does not accept model or body");
            }
            self.client.request(Method::GET, discovery_url(&execution)?)
        } else {
            let model = input.model.as_deref().unwrap_or_default();
            if model.is_empty()
                || model.chars().count() > 256
                || model.chars().any(char::is_control)
            {
                bail!("stream requires a valid model");
            }
            let mut body = input
                .body
                .ok_or_else(|| anyhow!("stream requires a JSON body"))?;
            let body_object = body
                .as_object_mut()
                .ok_or_else(|| anyhow!("Provider request body must be a JSON object"))?;
            if execution.profile.protocol != "google" {
                body_object.insert("model".to_owned(), Value::String(model.to_owned()));
                body_object.insert("stream".to_owned(), Value::Bool(true));
            }
            let body = serde_json::to_vec(&body)?;
            if body.len() > MAX_PROVIDER_REQUEST_BYTES {
                bail!("Provider request exceeds {MAX_PROVIDER_REQUEST_BYTES} bytes");
            }
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            self.client
                .request(Method::POST, stream_url(&execution, model)?)
                .body(body)
        };
        for (name, value) in &execution.profile.headers {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(value)?,
            );
        }
        for (name, value) in &execution.secret.headers {
            let mut value = HeaderValue::from_str(value)?;
            value.set_sensitive(true);
            headers.insert(HeaderName::from_bytes(name.as_bytes())?, value);
        }
        if execution.profile.auth.kind == "bearer" {
            let api_key = execution
                .secret
                .api_key
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Vault credential does not contain an API key"))?;
            let mut value = HeaderValue::from_str(&format!("Bearer {api_key}"))?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        } else if execution.profile.auth.kind == "header" {
            let name = execution
                .profile
                .auth
                .header
                .as_deref()
                .ok_or_else(|| anyhow!("Provider auth header is unavailable"))?;
            let api_key = execution
                .secret
                .api_key
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Vault credential does not contain an API key"))?;
            let mut value = HeaderValue::from_str(api_key)?;
            value.set_sensitive(true);
            headers.insert(HeaderName::from_bytes(name.as_bytes())?, value);
        }
        if execution.profile.protocol == "anthropic"
            && !execution
                .profile
                .headers
                .keys()
                .any(|name| name.eq_ignore_ascii_case("anthropic-version"))
        {
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
        }
        request = request.headers(headers);
        request
            .send()
            .await
            .with_context(|| format!("Provider {} request failed", input.provider_id))
    }
}

fn stream_url(execution: &ProviderExecutionConfig, model: &str) -> Result<Url> {
    let profile = &execution.profile;
    match profile.protocol.as_str() {
        "openai-chat" => endpoint(&profile.base_url, &["chat", "completions"]),
        "openai-responses" => endpoint(&profile.base_url, &["responses"]),
        "anthropic" => endpoint(&profile.base_url, &["messages"]),
        "google" => endpoint(
            &profile.base_url,
            &["models", &format!("{model}:streamGenerateContent")],
        )
        .map(|mut url| {
            url.query_pairs_mut().append_pair("alt", "sse");
            url
        }),
        _ => bail!("unsupported Provider protocol"),
    }
}

fn discovery_url(execution: &ProviderExecutionConfig) -> Result<Url> {
    let profile = &execution.profile;
    if !profile.discovery_url.is_empty() {
        return Url::parse(&profile.discovery_url).context("registered discovery URL is invalid");
    }
    match profile.protocol.as_str() {
        "anthropic" => endpoint(&profile.base_url, &["models"]).map(|mut url| {
            url.query_pairs_mut().append_pair("limit", "200");
            url
        }),
        "google" => endpoint(&profile.base_url, &["models"]).map(|mut url| {
            url.query_pairs_mut().append_pair("pageSize", "50");
            url
        }),
        "openai-chat" | "openai-responses" => endpoint(&profile.base_url, &["models"]),
        _ => bail!("unsupported Provider protocol"),
    }
}

fn endpoint(base_url: &str, segments: &[&str]) -> Result<Url> {
    let mut url = Url::parse(base_url).context("registered Provider base URL is invalid")?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| anyhow!("registered Provider base URL cannot be a base"))?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };

    use axum::{Json, Router, extract::State, http::HeaderMap as AxumHeaderMap, routing::post};
    use serde_json::json;
    use tempfile::TempDir;

    use crate::{
        identity::ChatIdentity,
        vault::{
            CredentialInput, ProviderAuth, ProviderProfile, ProviderProfileInput, ProviderSecret,
        },
    };

    use super::*;

    fn execution(protocol: &str, base_url: &str) -> ProviderExecutionConfig {
        ProviderExecutionConfig {
            profile: ProviderProfile {
                id: "provider".to_owned(),
                name: "Provider".to_owned(),
                protocol: protocol.to_owned(),
                base_url: base_url.to_owned(),
                auth: ProviderAuth {
                    kind: "none".to_owned(),
                    header: None,
                },
                headers: BTreeMap::new(),
                discovery_url: String::new(),
                created_at: String::new(),
                updated_at: String::new(),
            },
            secret: Default::default(),
        }
    }

    #[test]
    fn derives_only_protocol_owned_stream_paths() {
        assert_eq!(
            stream_url(
                &execution("openai-responses", "https://api.example/v1"),
                "gpt"
            )
            .unwrap()
            .as_str(),
            "https://api.example/v1/responses"
        );
        assert_eq!(
            stream_url(
                &execution("google", "https://api.example/v1beta"),
                "gemini/a"
            )
            .unwrap()
            .as_str(),
            "https://api.example/v1beta/models/gemini%2Fa:streamGenerateContent?alt=sse"
        );
    }

    #[tokio::test]
    async fn injects_vault_auth_and_forces_the_registered_stream_operation() {
        type Observation = Arc<Mutex<Option<(String, Value)>>>;
        async fn upstream(
            State(observation): State<Observation>,
            headers: AxumHeaderMap,
            Json(body): Json<Value>,
        ) -> ([(HeaderName, &'static str); 1], &'static str) {
            let authorization = headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            *observation.lock().unwrap() = Some((authorization, body));
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                "data: [DONE]\n\n",
            )
        }

        let observation: Observation = Arc::new(Mutex::new(None));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream_app = Router::new()
            .route("/v1/chat/completions", post(upstream))
            .with_state(observation.clone());
        let server =
            tokio::spawn(async move { axum::serve(listener, upstream_app).await.unwrap() });

        let directory = TempDir::new().unwrap();
        let vault = VaultStore::open(
            &directory.path().join("turnfold.db"),
            &directory.path().join("vault.key"),
        )
        .unwrap();
        let identity = ChatIdentity {
            issuer: "test".to_owned(),
            sub: "alice".to_owned(),
            username: "alice".to_owned(),
            name: "Alice".to_owned(),
            email: String::new(),
        };
        vault
            .save_profile(
                &identity,
                "openai",
                ProviderProfileInput {
                    name: "OpenAI-compatible".to_owned(),
                    protocol: "openai-chat".to_owned(),
                    base_url: format!("http://{address}/v1"),
                    auth: ProviderAuth {
                        kind: "bearer".to_owned(),
                        header: None,
                    },
                    headers: BTreeMap::new(),
                    discovery_url: String::new(),
                },
            )
            .unwrap();
        let credential = vault
            .save_credential(
                &identity,
                CredentialInput {
                    provider_id: "openai".to_owned(),
                    name: "default".to_owned(),
                    secret: ProviderSecret {
                        api_key: Some("secret-key".to_owned()),
                        headers: BTreeMap::new(),
                    },
                },
            )
            .unwrap();
        let response = ProviderAgent::new(vault)
            .unwrap()
            .execute(
                &identity,
                ProviderExecuteRequest {
                    provider_id: "openai".to_owned(),
                    credential_id: Some(credential.id),
                    operation: "stream".to_owned(),
                    model: Some("approved-model".to_owned()),
                    body: Some(json!({"model": "caller-model", "stream": false, "messages": []})),
                },
            )
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "data: [DONE]\n\n");
        let observed = observation.lock().unwrap().clone().unwrap();
        assert_eq!(observed.0, "Bearer secret-key");
        assert_eq!(observed.1["model"], "approved-model");
        assert_eq!(observed.1["stream"], true);
        server.abort();
    }
}
