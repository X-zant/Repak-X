pub fn extract_zip(zip_path: &str, output_dir: &str) -> io::Result<()> {
    let file = File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = Path::new(output_dir).join(file.mangled_name());

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p)?;
                }
            }
            let mut outfile = File::create(&outpath)?;
            io::copy(&mut file, &mut outfile)?;
        }
    }

    Ok(())
}

use std::fs::File;
use std::io;
use std::path::Path;
use unrar::Archive;
use zip::ZipArchive;

pub fn extract_rar(rar_path: &str, output_dir: &str) -> Result<(), unrar::error::UnrarError> {
    let output_dir = Path::new(output_dir);
    let mut archive = Archive::new(rar_path).open_for_processing()?;
    while let Some(header) = archive.read_header()? {
        let filename = header.entry().filename.clone();
        // Entry names come from the archive - skip any that would leave output_dir
        archive = if header.entry().is_file() && is_safe_entry_path(&filename) {
            header.extract_to(output_dir.join(filename))?
        } else {
            header.skip()?
        };
    }
    Ok(())
}

/// True when `path` stays inside the folder it is joined to: no "..", root or drive.
fn is_safe_entry_path(path: &Path) -> bool {
    path.components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_entries_that_escape() {
        assert!(is_safe_entry_path(Path::new("Mods/a.pak")));
        for bad in ["../a.pak", "Mods/../../a.pak", "/a.pak"] {
            assert!(!is_safe_entry_path(Path::new(bad)), "{bad}");
        }
        #[cfg(windows)]
        assert!(!is_safe_entry_path(Path::new("C:\\a.pak")));
    }
}

pub fn extract_7z(archive_path: &str, output_dir: &str) -> io::Result<()> {
    let output_path = Path::new(output_dir);
    std::fs::create_dir_all(output_path)?;

    // Use sevenz_rust2's decompress_file utility for simple extraction
    sevenz_rust2::decompress_file(archive_path, output_path).map_err(|e| {
        io::Error::new(
            io::ErrorKind::Other,
            format!("Failed to extract 7z archive: {}", e),
        )
    })?;

    Ok(())
}
