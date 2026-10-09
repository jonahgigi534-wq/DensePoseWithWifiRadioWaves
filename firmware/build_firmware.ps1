# Builds the ESP32-S3 firmware with ESP-IDF, and optionally flashes it.
#
# Load the ESP-IDF environment first (the "ESP-IDF PowerShell" shortcut, or
# export.ps1 from your ESP-IDF install), then:
#   .\build_firmware.ps1              build only
#   .\build_firmware.ps1 -Port COM7   build, then flash to COM7
param(
    [string]$Port
)

if (-not $env:IDF_PATH) {
    Write-Error "IDF_PATH is not set. Load the ESP-IDF environment (export.ps1) first."
    exit 1
}

# idf.py quits if it sees MSYS/MinGW variables, which are set when PowerShell
# is started from Git Bash. Clear them for this process only.
$msysVars = "MSYSTEM", "MSYSTEM_CARCH", "MSYSTEM_CHOST", "MSYSTEM_PREFIX",
            "MINGW_CHOST", "MINGW_PACKAGE_PREFIX", "MINGW_PREFIX"
foreach ($name in $msysVars) {
    Remove-Item "env:$name" -ErrorAction SilentlyContinue
}

$python = "python"
if ($env:IDF_PYTHON_ENV_PATH) {
    $python = Join-Path $env:IDF_PYTHON_ENV_PATH "Scripts\python.exe"
}
$idf = Join-Path $env:IDF_PATH "tools\idf.py"

# Start as a failure so that if Python can't be launched at all, the script
# doesn't report success. The idf.py calls overwrite it with their exit code.
$code = 1
Push-Location $PSScriptRoot
try {
    & $python $idf build
    $code = $LASTEXITCODE
    if ($code -eq 0 -and $Port) {
        & $python $idf -p $Port flash
        $code = $LASTEXITCODE
    }
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Error "idf.py failed with exit code $code."
}
exit $code
