use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use fs4::fs_std::FileExt;

pub struct DatabaseLock {
    _file: File,
}

impl DatabaseLock {
    pub fn acquire(database: &Path) -> Result<Self> {
        let lock_path = database_lock_path(database);
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("unable to open database lock {}", lock_path.display()))?;
        if !file
            .try_lock_exclusive()
            .with_context(|| format!("unable to lock database {}", database.display()))?
        {
            bail!(
                "database {} is already in use by another Turnfold process",
                database.display()
            );
        }
        file.set_len(0)
            .with_context(|| format!("unable to update database lock {}", lock_path.display()))?;
        writeln!(file, "pid={}", std::process::id())
            .with_context(|| format!("unable to update database lock {}", lock_path.display()))?;
        file.sync_data()
            .with_context(|| format!("unable to sync database lock {}", lock_path.display()))?;
        Ok(Self { _file: file })
    }
}

pub fn resolve_database_path(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .context("unable to read the current directory")?
            .join(path)
    };
    let file_name = absolute
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow::anyhow!("database path must name a file"))?;
    let parent = absolute
        .parent()
        .ok_or_else(|| anyhow::anyhow!("database path must have a parent directory"))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("unable to create database directory {}", parent.display()))?;
    let resolved = parent
        .canonicalize()
        .with_context(|| format!("unable to resolve database directory {}", parent.display()))?
        .join(file_name);
    if resolved.exists() {
        resolved
            .canonicalize()
            .with_context(|| format!("unable to resolve database {}", resolved.display()))
    } else {
        Ok(resolved)
    }
}

pub fn resolve_static_dir(path: &Path) -> Result<PathBuf> {
    if path.is_dir() {
        return canonical_static_dir(path);
    }
    if path == Path::new("dist") {
        let executable =
            std::env::current_exe().context("unable to locate the Turnfold executable")?;
        if let Some(parent) = executable.parent() {
            let packaged = parent.join("dist");
            if packaged.is_dir() {
                return canonical_static_dir(&packaged);
            }
        }
    }
    canonical_static_dir(path)
}

fn canonical_static_dir(path: &Path) -> Result<PathBuf> {
    path.canonicalize().with_context(|| {
        format!(
            "static directory {} is unavailable; run `bun run build` first or install a complete Turnfold package",
            path.display()
        )
    })
}

fn database_lock_path(database: &Path) -> PathBuf {
    let mut value = OsString::from(database.as_os_str());
    value.push(".lock");
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn resolves_a_database_to_a_stable_absolute_path() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("nested").join("turnfold.db");
        let resolved = resolve_database_path(&database).unwrap();
        assert!(resolved.is_absolute());
        assert_eq!(resolved.file_name().unwrap(), "turnfold.db");
        assert!(resolved.parent().unwrap().is_dir());
    }

    #[test]
    fn prevents_two_turnfold_processes_from_claiming_one_database() {
        let directory = TempDir::new().unwrap();
        let database = resolve_database_path(&directory.path().join("turnfold.db")).unwrap();
        let first = DatabaseLock::acquire(&database).unwrap();
        let error = DatabaseLock::acquire(&database).err().unwrap();
        assert!(error.to_string().contains("already in use"));
        drop(first);
        DatabaseLock::acquire(&database).unwrap();
    }
}
