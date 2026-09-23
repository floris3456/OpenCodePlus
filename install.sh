#!/usr/bin/env bash
# This is a bash script. Piped into another shell (`curl ... | sh` runs dash on
# Debian), it has to stop with instructions before the first bash construct.
if [ -z "${BASH_VERSION:-}" ]; then
    echo "Error: install.sh requires bash. Run: curl -fsSL <install.sh URL> | bash -s -- --version <version>" >&2
    exit 1
fi
# bash started as `sh` runs in POSIX mode; bash before 5.1 (macOS /bin/sh is
# bash 3.2) then rejects the process substitution used below.
set +o posix
set -euo pipefail

APP="opencodeplus"

usage() {
    cat <<EOF
OpenCode Plus Installer

Usage: install.sh [options]

Options:
    -h, --help               Display this help message
    -v, --version <version>  Install a specific version (e.g. 1.0.0)
    -p, --prefix <path>      Installation prefix (default: \$HOME/.opencodeplus)
        --stage, --staging   Stage release directory only; do not link binary into PATH
        --no-modify-path     Do not modify shell profile config files (.bashrc, .zshrc, etc.)
        --offline            Install from local/offline release assets without network access
        --asset-dir <path>   Directory containing offline release assets (release.json, archives)
        --archive <path>     Explicit path to a pre-downloaded target archive
        --manifest <path>    Explicit path to a release manifest (release.json)
        --base-url <url>     Base URL for downloading release assets
EOF
}

requested_version="${VERSION:-}"
prefix="${PREFIX:-$HOME/.opencodeplus}"
stage_mode=false
no_modify_path=false
offline=false
asset_dir=""
archive_path=""
manifest_path=""
# Releases are GitHub release assets: <base>/v<version>/<asset>.
base_url="${OPENCODE_RELEASE_BASE_URL:-https://github.com/floris3456/OpenCodePlus/releases/download}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            if [[ -n "${2:-}" ]]; then
                requested_version="${2#v}"
                shift 2
            else
                echo "Error: --version requires a version argument" >&2
                exit 1
            fi
            ;;
        -p|--prefix)
            if [[ -n "${2:-}" ]]; then
                prefix="$2"
                shift 2
            else
                echo "Error: --prefix requires a directory path" >&2
                exit 1
            fi
            ;;
        --stage|--staging)
            stage_mode=true
            shift
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        --offline)
            offline=true
            shift
            ;;
        --asset-dir)
            if [[ -n "${2:-}" ]]; then
                asset_dir="$2"
                offline=true
                shift 2
            else
                echo "Error: --asset-dir requires a directory path" >&2
                exit 1
            fi
            ;;
        --archive)
            if [[ -n "${2:-}" ]]; then
                archive_path="$2"
                offline=true
                shift 2
            else
                echo "Error: --archive requires an archive file path" >&2
                exit 1
            fi
            ;;
        --manifest)
            if [[ -n "${2:-}" ]]; then
                manifest_path="$2"
                shift 2
            else
                echo "Error: --manifest requires a manifest file path" >&2
                exit 1
            fi
            ;;
        --base-url)
            if [[ -n "${2:-}" ]]; then
                base_url="$2"
                shift 2
            else
                echo "Error: --base-url requires a URL argument" >&2
                exit 1
            fi
            ;;
        *)
            echo "Error: Unknown option '$1'" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# Temporary staging workspace - trap guarantees no partial install on error
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/opencodeplus_install_XXXXXX")
cleanup() {
    rm -rf "$tmp_dir"
}
trap cleanup EXIT

compute_sha256() {
    local target_file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$target_file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$target_file" | awk '{print $1}'
    else
        echo "Error: sha256sum or shasum is required but not installed" >&2
        exit 1
    fi
}

verify_url_origin() {
    local url="$1"
    if [[ "$url" =~ ^file:// ]]; then
        return 0
    fi
    if ! [[ "$url" =~ ^https:// ]]; then
        echo "Error: Untrusted release protocol (must be https): $url" >&2
        exit 1
    fi
    local host
    host=$(echo "$url" | sed -e 's|^https://||' -e 's|/.*$||' -e 's|:[0-9]*$||')
    case "$host" in
        github.com|*.github.com|*.githubusercontent.com|opencode.ai|*.opencode.ai)
            return 0
            ;;
        *)
            if [ -n "${OPENCODE_ALLOW_CUSTOM_ORIGIN:-}" ]; then
                return 0
            fi
            echo "Error: Untrusted release origin host '$host' for URL: $url" >&2
            exit 1
            ;;
    esac
}

# 1. Target platform resolution
raw_os=$(uname -s)
case "$raw_os" in
    Darwin*) os="darwin" ;;
    Linux*) os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win32" ;;
    *)
        echo "Error: Unsupported operating system: $raw_os" >&2
        exit 1
        ;;
esac

arch=$(uname -m)
case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
        echo "Error: Unsupported architecture: $arch" >&2
        exit 1
        ;;
esac

if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
    if [ "$rosetta_flag" = "1" ]; then
        arch="arm64"
    fi
fi

if [ "$os" = "win32" ]; then
    echo "Error: Windows is explicitly not qualified for OpenCode Plus releases." >&2
    exit 1
fi

target="$os-$arch"
case "$target" in
    linux-arm64|linux-x64|darwin-arm64|darwin-x64)
        ;;
    *)
        echo "Error: Target '$target' is not a qualified release target." >&2
        exit 1
        ;;
esac

# 2. Manifest resolution
if [ -z "$manifest_path" ]; then
    if [ -n "$asset_dir" ]; then
        manifest_path="$asset_dir/release.json"
    elif [ "$offline" = "true" ]; then
        if [ -f "release.json" ]; then
            manifest_path="release.json"
        else
            echo "Error: Offline installation specified but release.json not found" >&2
            exit 1
        fi
    else
        # A download installs exactly one fixed release per invocation; there is
        # no implicit "latest" (releases are prereleases, never marked Latest).
        if [ -z "$requested_version" ]; then
            echo "Error: a download needs a release version, e.g. --version v0.0.0-plus-r4.1 (releases: https://github.com/floris3456/OpenCodePlus/releases)" >&2
            exit 1
        fi
        manifest_url="$base_url/v$requested_version/release.json"
        verify_url_origin "$manifest_url"
        manifest_path="$tmp_dir/release.json"
        curl -fsSL "$manifest_url" -o "$manifest_path" || {
            echo "Error: Failed to download release manifest from $manifest_url" >&2
            exit 1
        }
    fi
fi

if [ ! -f "$manifest_path" ]; then
    echo "Error: Release manifest not found at $manifest_path" >&2
    exit 1
fi

# 3. Parse manifest fields
manifest_version=""
manifest_installer_sha=""
expected_archive_name=""
expected_archive_sha=""
expected_binary_sha=""
expected_bytes=""

if command -v jq >/dev/null 2>&1; then
    manifest_version=$(jq -r '.release.version // empty' "$manifest_path")
    manifest_installer_sha=$(jq -r '.installerSha256 // empty' "$manifest_path")
    expected_archive_name=$(jq -r --arg t "$target" '.artifacts[] | select(.target == $t) | .archiveName // empty' "$manifest_path")
    expected_archive_sha=$(jq -r --arg t "$target" '.artifacts[] | select(.target == $t) | .archiveSha256 // empty' "$manifest_path")
    expected_binary_sha=$(jq -r --arg t "$target" '.artifacts[] | select(.target == $t) | .binarySha256 // empty' "$manifest_path")
    expected_bytes=$(jq -r --arg t "$target" '.artifacts[] | select(.target == $t) | .bytes // empty' "$manifest_path")
elif command -v python3 >/dev/null 2>&1; then
    parsed_meta=$(python3 -c "
import json, sys
try:
    with open('$manifest_path', 'r', encoding='utf-8') as f:
        data = json.load(f)
    v = data.get('release', {}).get('version', '')
    inst = data.get('installerSha256', '')
    target = '$target'
    art = next((a for a in data.get('artifacts', []) if a.get('target') == target), None)
    if art:
        print(f\"{v}|{inst}|{art.get('archiveName', '')}|{art.get('archiveSha256', '')}|{art.get('binarySha256', '')}|{art.get('bytes', '')}\")
except Exception as e:
    sys.exit(1)
" 2>/dev/null || true)
    if [ -n "$parsed_meta" ]; then
        IFS='|' read -r manifest_version manifest_installer_sha expected_archive_name expected_archive_sha expected_binary_sha expected_bytes <<< "$parsed_meta"
    fi
fi

# Fallback parser if jq/python3 absent
if [ -z "$expected_archive_name" ]; then
    manifest_version=$(grep -o '"version":"[^"]*"' "$manifest_path" | head -1 | cut -d'"' -f4)
    manifest_installer_sha=$(grep -o '"installerSha256":"[^"]*"' "$manifest_path" | head -1 | cut -d'"' -f4)
    art_chunk=$(awk -v RS='\\{' -v t="\"target\":\"$target\"" '$0 ~ t' "$manifest_path" | head -1)
    expected_archive_name=$(echo "$art_chunk" | grep -o '"archiveName":"[^"]*"' | head -1 | cut -d'"' -f4)
    expected_archive_sha=$(echo "$art_chunk" | grep -o '"archiveSha256":"[^"]*"' | head -1 | cut -d'"' -f4)
    expected_binary_sha=$(echo "$art_chunk" | grep -o '"binarySha256":"[^"]*"' | head -1 | cut -d'"' -f4)
    expected_bytes=$(echo "$art_chunk" | grep -o '"bytes":[0-9]*' | head -1 | cut -d':' -f2)
fi

if [ -z "$expected_archive_name" ]; then
    echo "Error: Target '$target' is not available in the release manifest" >&2
    exit 1
fi

version="$manifest_version"
if [ -n "$requested_version" ] && [ "$requested_version" != "$version" ]; then
    echo "Error: Requested version '$requested_version' does not match manifest version '$version'" >&2
    exit 1
fi

# 4. Resolve Archive file
resolved_archive=""
if [ -n "$archive_path" ]; then
    resolved_archive="$archive_path"
elif [ -n "$asset_dir" ]; then
    resolved_archive="$asset_dir/$expected_archive_name"
elif [ "$offline" = "true" ]; then
    if [ -f "$expected_archive_name" ]; then
        resolved_archive="$expected_archive_name"
    else
        echo "Error: Offline archive not found: $expected_archive_name" >&2
        exit 1
    fi
else
    # The manifest version: equal to any requested version (checked above), and
    # still defined when --manifest supplied the manifest without --version.
    archive_url="$base_url/v$version/$expected_archive_name"
    verify_url_origin "$archive_url"
    resolved_archive="$tmp_dir/$expected_archive_name"
    curl -fsSL "$archive_url" -o "$resolved_archive" || {
        echo "Error: Failed to download archive from $archive_url" >&2
        exit 1
    }
fi

if [ ! -f "$resolved_archive" ]; then
    echo "Error: Archive file not found at $resolved_archive" >&2
    exit 1
fi

# 5. Verify archive SHA-256
actual_archive_sha=$(compute_sha256 "$resolved_archive")
if [ "$actual_archive_sha" != "$expected_archive_sha" ]; then
    echo "Error: Archive checksum mismatch: expected $expected_archive_sha, got $actual_archive_sha" >&2
    exit 1
fi

# 6. Archive safety verification before extraction
# Check for corruption / truncation first
tar_test_err="$tmp_dir/tar_test.log"
if ! tar -tzf "$resolved_archive" >/dev/null 2>"$tar_test_err"; then
    echo "Error: Corrupt or truncated archive: $(cat "$tar_test_err")" >&2
    exit 1
fi

allowed_contract_members="bin/opencodeplus metadata.json LICENSE NOTICE"
archive_members=()
while IFS= read -r member_line; do
    [ -n "$member_line" ] && archive_members+=("$member_line")
done < <(tar -tzf "$resolved_archive")

if [ ${#archive_members[@]} -eq 0 ]; then
    echo "Error: Archive is empty" >&2
    exit 1
fi

# Whitelist, path traversal, and duplicate detection
seen_list=""
for member in "${archive_members[@]}"; do
    # Traversal checks
    if [[ "$member" =~ ^/ ]] || [[ "$member" =~ ^\\ ]] || [[ "$member" =~ \.\. ]] || [[ "$member" =~ ^\./ ]]; then
        echo "Error: Hostile archive: path traversal detected in member '$member'" >&2
        exit 1
    fi

    # Whitelist check
    is_allowed=false
    for contract_member in $allowed_contract_members; do
        if [ "$member" = "$contract_member" ]; then
            is_allowed=true
            break
        fi
    done
    if [ "$is_allowed" != "true" ]; then
        echo "Error: Hostile archive: member '$member' is not in contract whitelist" >&2
        exit 1
    fi

    # Duplicate check
    case " $seen_list " in
        *" $member "*)
            echo "Error: Hostile archive: duplicate member '$member' detected" >&2
            exit 1
            ;;
        *)
            seen_list="$seen_list $member"
            ;;
    esac
done

# Non-regular member types and link checks
while IFS= read -r verbose_line; do
    [ -z "$verbose_line" ] && continue
    first_char="${verbose_line:0:1}"
    if [ "$first_char" != "-" ]; then
        echo "Error: Hostile archive: non-regular member type detected: $verbose_line" >&2
        exit 1
    fi
    if [[ "$verbose_line" =~ \ -\>\  ]] || [[ "$verbose_line" =~ \ link\ to\  ]]; then
        echo "Error: Hostile archive: link member detected: $verbose_line" >&2
        exit 1
    fi
done < <(tar -tvzf "$resolved_archive")

# 7. Safe extraction into isolated staging directory
sandbox="$tmp_dir/staged"
mkdir -p "$sandbox"
tar -xzf "$resolved_archive" -C "$sandbox"

# Size bounds check on extracted members
max_binary_bytes=524288000 # 500 MB
max_text_bytes=10485760    # 10 MB

for req in $allowed_contract_members; do
    file_path="$sandbox/$req"
    if [ ! -f "$file_path" ]; then
        echo "Error: Required contract member '$req' missing from extracted archive" >&2
        exit 1
    fi
    member_bytes=$(wc -c < "$file_path" | tr -d ' ')
    if [ "$req" = "bin/opencodeplus" ]; then
        if [ "$member_bytes" -gt "$max_binary_bytes" ]; then
            echo "Error: Binary member '$req' exceeds size bound ($member_bytes > $max_binary_bytes)" >&2
            exit 1
        fi
    else
        if [ "$member_bytes" -gt "$max_text_bytes" ]; then
            echo "Error: Text member '$req' exceeds size bound ($member_bytes > $max_text_bytes)" >&2
            exit 1
        fi
    fi
done

# 8. Re-verify extracted binary hash
actual_binary_sha=$(compute_sha256 "$sandbox/bin/opencodeplus")
if [ "$actual_binary_sha" != "$expected_binary_sha" ]; then
    echo "Error: Extracted binary checksum mismatch: expected $expected_binary_sha, got $actual_binary_sha" >&2
    exit 1
fi

# 9. Release directory immutability & Idempotent reinstall
release_dir="$prefix/releases/$version"
bin_dir="$prefix/bin"

if [ -d "$release_dir" ]; then
    echo "Release $version is already installed at $release_dir (existing releases are immutable)."
    if [ "$stage_mode" = "true" ]; then
        exit 0
    fi
    # If binary symlink doesn't exist, ensure active pointer exists
    if [ ! -e "$bin_dir/opencodeplus" ] && [ ! -L "$bin_dir/opencodeplus" ]; then
        mkdir -p "$bin_dir"
        ln -sf "../releases/$version/bin/opencodeplus" "$bin_dir/opencodeplus"
    fi
    exit 0
fi

# 10. Incumbent detection & Staging
has_incumbent=false
if [ -e "$bin_dir/opencodeplus" ] || [ -L "$bin_dir/opencodeplus" ]; then
    has_incumbent=true
elif [ -d "$prefix/releases" ] && [ -n "$(ls -A "$prefix/releases" 2>/dev/null)" ]; then
    has_incumbent=true
fi

mkdir -p "$prefix/releases"
mv "$sandbox" "$release_dir"
chmod -R a-w "$release_dir"
chmod 755 "$release_dir/bin/opencodeplus"

if [ "$stage_mode" = "true" ]; then
    echo "Staged release $version to $release_dir (staging mode requested)."
    exit 0
fi

if [ "$has_incumbent" = "true" ]; then
    echo "Incumbent release detected. Staged release $version to $release_dir without activating over incumbent."
    exit 0
fi

# 11. Initial activation into prefix/bin
mkdir -p "$bin_dir"
ln -sf "../releases/$version/bin/opencodeplus" "$bin_dir/opencodeplus"
chmod 755 "$bin_dir/opencodeplus"

# 12. Shell profile configuration
path_command="export PATH=\"$bin_dir:\$PATH\""
if [ "$no_modify_path" = "true" ]; then
    echo "To add $bin_dir to your PATH, run:"
    echo "  $path_command"
    exit 0
fi

# Candidate profiles
candidate_profiles=(
    "${HOME}/.bashrc"
    "${HOME}/.bash_profile"
    "${HOME}/.zshrc"
    "${HOME}/.profile"
)

profile_file=""
for p in "${candidate_profiles[@]}"; do
    if [ -f "$p" ]; then
        profile_file="$p"
        break
    fi
done

if [ -z "$profile_file" ]; then
    echo "No shell profile file found. Manually add $bin_dir to your PATH:"
    echo "  $path_command"
    exit 0
fi

if [[ ":$PATH:" == *":$bin_dir:"* ]]; then
    exit 0
fi

if [ ! -w "$profile_file" ]; then
    echo "Could not write to $profile_file (file is read-only)."
    echo "Manually add the directory to your PATH:"
    echo "  $path_command"
    exit 0
fi

if grep -Fqs "$bin_dir" "$profile_file"; then
    exit 0
fi

echo "" >> "$profile_file"
echo "# opencodeplus" >> "$profile_file"
echo "$path_command" >> "$profile_file"
echo "Added $bin_dir to PATH in $profile_file"
exit 0
