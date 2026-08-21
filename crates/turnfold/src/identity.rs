use axum::http::HeaderMap;
use clap::ValueEnum;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, ValueEnum)]
pub enum AuthMode {
    SingleUser,
    ForwardAuth,
}

#[derive(Clone, Debug)]
pub struct IdentityConfig {
    pub mode: AuthMode,
    pub single_user_name: String,
    pub issuer: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatIdentity {
    pub issuer: String,
    pub sub: String,
    pub username: String,
    pub name: String,
    pub email: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatProfile {
    pub username: String,
    pub name: String,
    pub email: String,
}

#[derive(Debug)]
pub struct IdentityError;

impl std::fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Authenticated user context is required")
    }
}

impl std::error::Error for IdentityError {}

impl IdentityConfig {
    pub fn identity(&self, headers: &HeaderMap) -> Result<ChatIdentity, IdentityError> {
        if matches!(self.mode, AuthMode::SingleUser) {
            let username = self.single_user_name.trim();
            let username = if username.is_empty() {
                "local"
            } else {
                username
            };
            return Ok(ChatIdentity {
                issuer: "turnfold:single-user".to_owned(),
                sub: "default".to_owned(),
                username: username.to_owned(),
                name: username.to_owned(),
                email: String::new(),
            });
        }

        let username = first_header(
            headers,
            &[
                "x-turnfold-username",
                "x-authentik-username",
                "x-forwarded-user",
            ],
        );
        if username.is_empty() {
            return Err(IdentityError);
        }
        let sub = first_header(
            headers,
            &["x-turnfold-sub", "x-authentik-uid", "x-forwarded-sub"],
        );
        let sub = if sub.is_empty() {
            username.clone()
        } else {
            sub
        };
        Ok(ChatIdentity {
            issuer: header(headers, "x-turnfold-issuer")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| self.issuer.clone()),
            sub,
            name: header(headers, "x-authentik-name")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| username.clone()),
            email: header(headers, "x-authentik-email").unwrap_or_default(),
            username,
        })
    }
}

impl ChatIdentity {
    pub fn key(&self) -> String {
        let digest = Sha256::digest(format!("{}\0{}", self.issuer, self.sub).as_bytes());
        hex(&digest)[..32].to_owned()
    }

    pub fn profile(&self) -> ChatProfile {
        ChatProfile {
            username: self.username.clone(),
            name: if self.name.trim().is_empty() {
                self.username.clone()
            } else {
                self.name.clone()
            },
            email: self.email.clone(),
        }
    }
}

fn first_header(headers: &HeaderMap, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| header(headers, name).filter(|value| !value.is_empty()))
        .unwrap_or_default()
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .map(str::to_owned)
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn single_user_identity_is_stable() {
        let config = IdentityConfig {
            mode: AuthMode::SingleUser,
            single_user_name: "alice".to_owned(),
            issuer: "ignored".to_owned(),
        };
        let identity = config.identity(&HeaderMap::new()).unwrap();
        assert_eq!(identity.issuer, "turnfold:single-user");
        assert_eq!(identity.sub, "default");
        assert_eq!(identity.key(), "8daac02ed9a886768394ae58c97a63b9");
    }

    #[test]
    fn forward_auth_requires_and_scopes_an_identity() {
        let config = IdentityConfig {
            mode: AuthMode::ForwardAuth,
            single_user_name: "local".to_owned(),
            issuer: "https://issuer.example".to_owned(),
        };
        assert!(config.identity(&HeaderMap::new()).is_err());

        let mut headers = HeaderMap::new();
        headers.insert("x-authentik-username", HeaderValue::from_static("alice"));
        headers.insert("x-authentik-uid", HeaderValue::from_static("user-1"));
        let identity = config.identity(&headers).unwrap();
        assert_eq!(identity.username, "alice");
        assert_eq!(identity.sub, "user-1");
        assert_eq!(identity.issuer, "https://issuer.example");
    }
}
