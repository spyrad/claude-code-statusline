# Builds the stand-alone install.ps1 from the sources in src/.
# Run after changing anything in src/:
#   powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
param(
    [string]$OutFile = (Join-Path $PSScriptRoot 'install.ps1')
)

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'src'
$template = [IO.File]::ReadAllText((Join-Path $src 'install-template.ps1'), [Text.Encoding]::UTF8)
$statusline = [IO.File]::ReadAllText((Join-Path $src 'statusline.mjs'), [Text.Encoding]::UTF8).TrimEnd()

if ($statusline -match "(?m)^'@") { throw "statusline.mjs contains a line starting with '@ - it would end the here-string." }

$installer = $template.Replace('__STATUSLINE_SCRIPT__', $statusline).Replace("`r`n", "`n")

# ASCII only: the one-liner (irm | scriptblock) must not depend on a BOM or code page.
# statusline.mjs therefore writes every glyph as a \uXXXX escape - see GLYPHS there.
$nonAscii = [regex]::Matches($installer, '[^\x00-\x7F]')
if ($nonAscii.Count -gt 0) {
    $line = ($installer.Substring(0, $nonAscii[0].Index) -split "`n").Count
    throw "install.ps1 would contain $($nonAscii.Count) non-ASCII character(s), first on line $line."
}

$errors = $null
[void][Management.Automation.Language.Parser]::ParseInput($installer, [ref]$null, [ref]$errors)
if ($errors.Count -gt 0) { throw "install.ps1 does not parse: $($errors[0].Message) (line $($errors[0].Extent.StartLineNumber))" }

# The embedded script must still be valid JavaScript after the round trip.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("statusline-build-{0}.mjs" -f [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($tmp, $statusline, (New-Object Text.UTF8Encoding($false)))
        & $node.Source --check $tmp
        if ($LASTEXITCODE -ne 0) { throw "statusline.mjs does not parse as JavaScript." }
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Warning "node not found - skipped the JavaScript syntax check."
}

[IO.File]::WriteAllText($OutFile, $installer, (New-Object Text.UTF8Encoding($false)))
Write-Host "Built: $OutFile"
