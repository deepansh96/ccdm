# First-run setup on Windows. From a fresh clone, in Windows Terminal:
#
#   pwsh -NoProfile -File setup.ps1
#
# This file only finds a real Python 3.11 or newer and hands over to `ccdm setup`
# (scripts/ccdmlib/cli/setup.py), which does the work. Python is found by the same
# rules as scripts/ccdm, scripts/ccdm.cmd and python() in
# scripts/ccdmlib/platform/exe.py. Keep the four in step.
$env:PYTHONUTF8 = "1"

# A .cmd or .bat needs a shell, and anything under \WindowsApps\ is the Microsoft
# Store stub, which opens the Store instead of running Python.
function Test-Usable([string]$Candidate) {
    return [bool]$Candidate -and ($Candidate -notmatch '\.(cmd|bat)$') -and ($Candidate -notmatch '[\\/]WindowsApps[\\/]')
}

function Find-Python {
    foreach ($name in "CCDM_PYTHON", "CCDM_REMINDER_PYTHON") {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not $value) { continue }
        if (Test-Usable $value) { return $value }
        [Console]::Error.WriteLine("setup: ignoring $name=${value}: it is a .cmd, a .bat or the Microsoft Store stub, not Python")
    }
    # Only absolute PATH entries, so the choice cannot depend on the current directory.
    $directories = @($env:PATH -split ';' | ForEach-Object { $_.Trim('"') } |
        Where-Object { $_ -match '^([a-zA-Z]:[\\/]|[\\/]{2}[^\\/])' })
    # The launcher only finds the interpreter, which then runs without it.
    foreach ($directory in $directories) {
        $launcher = Join-Path $directory "py.exe"
        if (-not (Test-Usable $launcher) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) { continue }
        try {
            $found = [string](& $launcher -3 -c "import sys; sys.stdout.write(sys.executable)" 2>$null)
            if ($LASTEXITCODE -eq 0 -and (Test-Usable $found)) { return $found }
        } catch { }
    }
    foreach ($directory in $directories) {
        $interpreter = Join-Path $directory "python.exe"
        if ((Test-Usable $interpreter) -and (Test-Path -LiteralPath $interpreter -PathType Leaf)) { return $interpreter }
    }
    return $null
}

function Stop-WithPythonHelp([string]$Problem) {
    [Console]::Error.WriteLine("setup: $Problem")
    [Console]::Error.WriteLine("Install Python 3.11 or newer, for example with")
    [Console]::Error.WriteLine("  winget install Python.Python.3.12")
    [Console]::Error.WriteLine("or from https://www.python.org/downloads/, then open a new terminal and run setup again.")
    [Console]::Error.WriteLine("If Python is installed but not found, set CCDM_PYTHON to the full path of its python.exe.")
    exit 1
}

$python = Find-Python
if (-not $python) {
    Stop-WithPythonHelp "No usable Python was found. The Microsoft Store stub under WindowsApps is not Python."
}
$recent = $false
try {
    & $python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
    $recent = ($LASTEXITCODE -eq 0)
} catch { }
if (-not $recent) {
    Stop-WithPythonHelp "$python did not run, or is older than Python 3.11."
}

& $python (Join-Path $PSScriptRoot "scripts\ccdm.py") setup @args
exit $LASTEXITCODE
