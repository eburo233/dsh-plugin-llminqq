# =============================================================================
#  Find EVERY copy of the LLMinQQ plugin on this machine, and say which is old.
#
#  Why this exists:
#    The previous suggestion was circular -- it asked you to open /api/version,
#    but that endpoint only exists in the NEW version. If you are on the old
#    version you just get 404, which tells you nothing you did not already know.
#
#    This script does not run any plugin code. It only walks the filesystem and
#    reads package.json, so it works no matter which version is loaded.
#
#  What it checks, per profile:
#    - every dsh home it can find
#    - every profile inside (web, desktop, headless, ...)
#    - the top-level node_modules copy AND every .pnpm copy
#    - version number, lib/env.js presence, lib/index.js timestamp
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File find-all-copies.ps1
#    powershell -ExecutionPolicy Bypass -File find-all-copies.ps1 -ExtraRoot D:\DSH-WORKSPACE
#
#  NOTE: pure ASCII / English only. Windows PowerShell 5.1 decodes .ps1 as ANSI
#        (GBK on zh-CN) unless the file has a UTF-8 BOM, so UTF-8 Chinese would
#        become mojibake and break the parser.
# =============================================================================
param(
    [string]$ExtraRoot = ''
)

$ErrorActionPreference = 'SilentlyContinue'

function Line($t) { Write-Host $t }
function Ok($t)   { Write-Host $t -ForegroundColor Green }
function Bad($t)  { Write-Host $t -ForegroundColor Red }
function Warn($t) { Write-Host $t -ForegroundColor Yellow }
function Dim($t)  { Write-Host $t -ForegroundColor Gray }

# Candidate dsh homes. The .dsh under USERPROFILE is often a junction to
# something like D:\dsh-home, but we list both so the truth is visible.
$homes = @()
foreach ($h in @(
    (Join-Path $env:USERPROFILE '.dsh'),
    'D:\dsh-home',
    (Join-Path $env:LOCALAPPDATA 'dsh'),
    (Join-Path $env:APPDATA 'dsh')
)) {
    if ($h -and (Test-Path (Join-Path $h 'profiles'))) { $homes += $h }
}
$homes = $homes | Select-Object -Unique

$rows = @()

function Add-Row($profileName, $kind, $path) {
    $pkg = Join-Path $path 'package.json'
    if (-not (Test-Path $pkg)) { return }
    $ver = 'unparsable'
    try { $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch { }
    $hasEnv = Test-Path (Join-Path $path 'lib\env.js')
    $idx = Join-Path $path 'lib\index.js'
    $mtime = $null
    if (Test-Path $idx) { $mtime = (Get-Item $idx).LastWriteTime }
    $script:rows += New-Object PSObject -Property @{
        Profile = $profileName
        Kind    = $kind
        Path    = $path
        Version = $ver
        HasEnv  = $hasEnv
        MTime   = $mtime
    }
}

foreach ($home in $homes) {
    $profRoot = Join-Path $home 'profiles'
    $profiles = Get-ChildItem $profRoot -Directory
    foreach ($p in $profiles) {
        $nm = Join-Path $p.FullName 'node_modules'
        if (-not (Test-Path $nm)) { continue }

        # top-level copy
        $top = Join-Path $nm 'dsh-plugin-llminqq'
        if (Test-Path (Join-Path $top 'package.json')) {
            Add-Row $p.Name 'top-level' $top
        }

        # real copies under .pnpm
        $pnpm = Join-Path $nm '.pnpm'
        if (Test-Path $pnpm) {
            Get-ChildItem $pnpm -Directory -Filter 'dsh-plugin-llminqq@*' | ForEach-Object {
                $real = Join-Path $_.FullName 'node_modules\dsh-plugin-llminqq'
                if (Test-Path (Join-Path $real 'package.json')) {
                    Add-Row $p.Name ('.pnpm\' + $_.Name) $real
                }
            }
        }
    }
}

# Also scan the workspace source dir if given, to compare against installed
if ($ExtraRoot -and (Test-Path $ExtraRoot)) {
    Get-ChildItem $ExtraRoot -Directory -Filter 'dsh-plugin-llminqq' -Recurse -Depth 3 |
        ForEach-Object {
            if (Test-Path (Join-Path $_.FullName 'package.json')) {
                Add-Row '(source)' 'workspace' $_.FullName
            }
        }
}

Line ''
Line '=================================================================='
Line '  All copies of dsh-plugin-llminqq found on this machine'
Line '=================================================================='
Line ''
Line ('  dsh homes searched: ' + $homes.Count)
foreach ($h in $homes) { Dim ('    ' + $h) }
if ($ExtraRoot) { Dim ('    (extra) ' + $ExtraRoot) }
Line ''

if ($rows.Count -eq 0) {
    Bad 'Nothing found. The plugin is not installed anywhere I can see.'
    Line ''
    exit 1
}

# Group by profile for readability
$byProfile = $rows | Group-Object Profile
foreach ($g in $byProfile) {
    Line ('--- profile: ' + $g.Name + ' ---')
    foreach ($r in ($g.Group | Sort-Object Kind)) {
        $tag = 'OLD'
        if ($r.HasEnv) { $tag = 'NEW' }
        $line = '  [' + $tag + '] ' + $r.Kind.PadRight(34) + ' ver=' + $r.Version + ' env.js=' + $r.HasEnv
        if ($r.HasEnv) { Ok $line } else { Bad $line }
        Dim ('        ' + $r.Path)
    }
    Line ''
}

Line '=================================================================='
Line '  Which one does dsh load?'
Line '=================================================================='
Line ''
$topRows  = @($rows | Where-Object { $_.Kind -eq 'top-level' })
$pnpmRows = @($rows | Where-Object { $_.Kind -like '.pnpm*' })

if ($pnpmRows.Count -gt 0) {
    Line '  pnpm made .pnpm copies, so dsh loads THOSE (not the top-level folder).'
    Line ''
    $stalePnpm = @($pnpmRows | Where-Object { -not $_.HasEnv })
    if ($stalePnpm.Count -gt 0) {
        Bad ('  ' + $stalePnpm.Count + ' STALE .pnpm copy/copies -- these are what dsh loads:')
        foreach ($r in $stalePnpm) {
            Bad ('    profile ' + $r.Profile + '  ->  ' + $r.Path)
        }
        Line ''
        Line '  Fix: overwrite the files listed above with the new ones.'
        Line '  Or run: update-windows.ps1 (it writes every location)'
    } else {
        Ok '  All .pnpm copies already have lib\env.js (new version).'
        Line ''
        Warn '  If the UI still looks old, it is browser cache or wrong port/profile:'
        Dim  '    - Ctrl+Shift+R (plain F5 is not enough)'
        Dim  '    - make sure the page you are looking at is served by THIS dsh'
    }
} else {
    Line '  No .pnpm copies -- dsh loads the top-level folder directly.'
    Line ''
    $staleTop = @($topRows | Where-Object { -not $_.HasEnv })
    if ($staleTop.Count -gt 0) {
        Bad ('  ' + $staleTop.Count + ' STALE top-level copy/copies:')
        foreach ($r in $staleTop) { Bad ('    profile ' + $r.Profile + '  ->  ' + $r.Path) }
    } else {
        Ok '  All top-level copies have lib\env.js (new version).'
    }
}

Line ''
Line '=================================================================='
Line '  Profile reminder'
Line '=================================================================='
Line ''
Line '  Each profile has its OWN node_modules. Installing into "web" does NOT'
Line '  install into "desktop". If the page you open is served by the desktop'
Line '  app, then the DESKTOP profile copy is the one that matters.'
Line ''
Line '  Startup log tells you which version is live:'
Line '    old:  [llminqq] <chinese text only, no version number>'
Line '    new:  [llminqq] v0.2.0 loaded ... code at <path>'
Line ''
