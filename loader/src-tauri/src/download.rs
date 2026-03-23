use bytes::Bytes;
use std::io::Cursor;
use std::path::{Component, PathBuf};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    name: String,
    size: Option<u64>,
    download_url: String,
    is_source: bool,
}

fn parse_github_url(url: &str) -> Result<(&str, &str), String> {
    let path = url
        .trim()
        .trim_end_matches('/')
        .strip_prefix("https://github.com/")
        .ok_or("URL must start with https://github.com/")?;

    let mut parts = path.splitn(3, '/');
    let owner = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or("Missing owner in URL")?;
    let repo = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or("Missing repository name in URL")?;

    Ok((owner, repo))
}

fn make_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("PenguLoader")
        .build()
        .map_err(|e| e.to_string())
}

async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<Bytes, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Returns true if every zip entry shares the same first path component.
fn zip_has_common_prefix(bytes: &Bytes) -> bool {
    let Ok(mut archive) = zip::ZipArchive::new(Cursor::new(bytes.clone())) else {
        return false;
    };
    let mut prefix: Option<String> = None;
    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index(i) {
            if let Some(p) = file.enclosed_name() {
                let first: Option<String> = p
                    .components()
                    .next()
                    .map(|c: Component| c.as_os_str().to_string_lossy().to_string());
                match (&prefix, first) {
                    (None, Some(comp)) => prefix = Some(comp),
                    (Some(existing), Some(comp)) if *existing == comp => {}
                    _ => return false,
                }
            }
        }
    }
    prefix.is_some()
}

fn extract_zip(bytes: Bytes, dest: &PathBuf, skip_first: bool) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid zip: {}", e))?;

    let skip = if skip_first { 1 } else { 0 };

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;

        let rel_path: PathBuf = match file.enclosed_name() {
            Some(p) => p.components().skip(skip).collect(),
            None => continue,
        };

        if rel_path.as_os_str().is_empty() {
            continue;
        }

        let outpath = dest.join(&rel_path);

        if file.is_dir() {
            std::fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            let mut outfile = std::fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }
    }

    Ok(())
}

/// Fetches the latest release assets for a GitHub repo.
/// Returns all .zip assets plus a "Source code" fallback entry.
#[tauri::command]
async fn fetch_release_assets(url: String) -> Result<Vec<AssetInfo>, String> {
    let (owner, repo) = parse_github_url(&url)?;
    let client = make_client()?;

    let api_url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );

    let release: serde_json::Value = client
        .get(&api_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?
        .json()
        .await
        .map_err(|_| {
            format!(
                "No releases found for {}/{}. Try installing from source instead.",
                owner, repo
            )
        })?;

    if release["message"].as_str() == Some("Not Found") {
        return Err(format!(
            "{}/{} has no releases. Try installing from source instead.",
            owner, repo
        ));
    }

    let empty = vec![];
    let mut assets: Vec<AssetInfo> = release["assets"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter(|a| {
            a["name"]
                .as_str()
                .map(|n| n.to_lowercase().ends_with(".zip"))
                .unwrap_or(false)
        })
        .filter_map(|a| {
            let name = a["name"].as_str()?.to_string();
            let download_url = a["browser_download_url"].as_str()?.to_string();
            let size = a["size"].as_u64();
            Some(AssetInfo {
                name,
                size,
                download_url,
                is_source: false,
            })
        })
        .collect();

    // Always append the GitHub-generated source archive as a fallback option
    if let Some(zipball_url) = release["zipball_url"].as_str() {
        assets.push(AssetInfo {
            name: "Source code".to_string(),
            size: None,
            download_url: zipball_url.to_string(),
            is_source: true,
        });
    }

    Ok(assets)
}

/// Installs a plugin from a GitHub repo URL.
/// - from_source=true: downloads the main branch zip directly
/// - from_source=false: downloads the given asset_url (a chosen release asset)
#[tauri::command]
async fn install_plugin(
    url: String,
    plugins_dir: String,
    from_source: bool,
    asset_url: Option<String>,
    is_source_asset: bool,
) -> Result<String, String> {
    let (owner, repo) = parse_github_url(&url)?;
    let client = make_client()?;

    let dest = PathBuf::from(&plugins_dir).join(repo);
    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("Failed to create plugin directory: {}", e))?;

    if from_source {
        let zip_url = format!(
            "https://github.com/{}/{}/archive/refs/heads/main.zip",
            owner, repo
        );
        let bytes: Bytes = download_bytes(&client, &zip_url).await.map_err(|_| {
            "Could not download source. Make sure the repo exists and has a main branch."
                .to_string()
        })?;
        extract_zip(bytes, &dest, true)?;
    } else {
        let dl_url = asset_url.ok_or("No asset URL provided")?;
        let bytes: Bytes = download_bytes(&client, &dl_url)
            .await
            .map_err(|e| format!("Could not download asset: {}", e))?;
        let skip = is_source_asset || zip_has_common_prefix(&bytes);
        extract_zip(bytes, &dest, skip)?;
    }

    Ok(repo.to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("download")
        .invoke_handler(tauri::generate_handler![fetch_release_assets, install_plugin])
        .build()
}
