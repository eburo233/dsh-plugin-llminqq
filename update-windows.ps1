# =============================================================================
#  LLMinQQ plugin updater for Windows  (v2: writes BOTH locations)
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File update-windows.ps1
#    powershell -ExecutionPolicy Bypass -File update-windows.ps1 -Profile web
#    powershell -ExecutionPolicy Bypass -File update-windows.ps1 -DshHome D:\dsh-home
#
#  WHY BOTH LOCATIONS:
#    pnpm normally makes node_modules\<pkg> a POINTER (junction on Windows)
#    into node_modules\.pnpm\<pkg>@<ver>\node_modules\<pkg>\, and THAT .pnpm
#    copy is what dsh loads. Editing only the top-level folder changes nothing
#    and reports no error at all.
#
#  WHY THIS FILE IS PURE ASCII / ENGLISH ONLY:
#    Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on zh-CN) unless the file
#    has a UTF-8 BOM. UTF-8 Chinese without BOM becomes mojibake, corrupts
#    quote pairing, and the parser then reports nonsense like
#    "redirect operator missing file specification". English-only avoids it.
# =============================================================================
param(
    [string]$Profile = 'web',
    [string]$DshHome = '',
    [string]$Source = ''
)

$ErrorActionPreference = 'Continue'

function Line($t)  { Write-Host $t }
function Head($t)  { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Bad($t)   { Write-Host "  [BAD]  $t" -ForegroundColor Red }
function Warn2($t) { Write-Host "  [WARN] $t" -ForegroundColor Yellow }
function Info($t)  { Write-Host "         $t" -ForegroundColor Gray }

$src = $Source
if (-not $src) { $src = $PSScriptRoot }
if (-not $src) { $src = (Get-Location).Path }
$src = (Resolve-Path $src).Path

Line ''
Line '========================================================='
Line '  LLMinQQ plugin updater v2'
Line '========================================================='
Line ("  source  : " + $src)
Line ("  profile : " + $Profile)

$srcPkg = Join-Path $src 'package.json'
if (-not (Test-Path $srcPkg)) {
    Bad ("no package.json in source dir: " + $srcPkg)
    Line ''
    exit 1
}
$expectedVer = (Get-Content $srcPkg -Raw | ConvertFrom-Json).version
Line ("  version : " + $expectedVer)

if (-not (Test-Path (Join-Path $src 'lib\env.js'))) {
    Warn2 'source is missing lib\env.js -- your source copy may be outdated'
}

$files = @(
    'lib\index.js',
    'lib\store.js',
    'lib\napcat.js',
    'lib\models.js',
    'lib\env.js',
    'client.js',
    'package.json'
)
$bridgeDir = Join-Path $src 'lib\bridge'
if (Test-Path $bridgeDir) {
    Get-ChildItem $bridgeDir -Filter '*.js' | ForEach-Object {
        $files += ("lib\bridge\" + $_.Name)
    }
}

$missingSrc = @()
foreach ($f in $files) {
    if (-not (Test-Path (Join-Path $src $f))) { $missingSrc += $f }
}
if ($missingSrc.Count -gt 0) {
    Warn2 'these source files are missing (will be skipped):'
    foreach ($m in $missingSrc) { Info $m }
}

$homes = @()
if ($DshHome) {
    $homes += $DshHome
} else {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.dsh'),
        'D:\dsh-home',
        (Join-Path $env:LOCALAPPDATA 'dsh')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c ("profiles\" + $Profile)))) { $homes += $c }
    }
}

if ($homes.Count -eq 0) {
    Bad ("no dsh home found for profile " + $Profile)
    Info 'specify manually: -DshHome C:\Users\you\.dsh'
    exit 1
}
Line ''
Line ("  dsh home(s): " + ($homes -join ' ; '))
Line ''

$script:totalTargets = 0

function Sync-Target($dest, $label) {
    Line ("  [" + $label + "]")
    Info ("  " + $dest)

    $destBridge = Join-Path $dest 'lib\bridge'
    if (-not (Test-Path $destBridge)) {
        New-Item -ItemType Directory -Force -Path $destBridge | Out-Null
    }

    $copied = 0
    foreach ($rel in $files) {
        $from = Join-Path $src $rel
        if (-not (Test-Path $from)) { continue }
        $to = Join-Path $dest $rel
        $toDir = Split-Path $to -Parent
        if (-not (Test-Path $toDir)) {
            New-Item -ItemType Directory -Force -Path $toDir | Out-Null
        }
        try {
            Copy-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop
            $copied++
        } catch {
            Bad ("  copy failed for " + $rel + " : " + $_.Exception.Message)
        }
    }
    Info ("  copied " + $copied + " / " + $files.Count + " files")

    $destEnv = Join-Path $dest 'lib\env.js'
    if (Test-Path $destEnv) {
        Ok '  lib\env.js present'
    } else {
        Bad '  lib\env.js MISSING -- write did not land'
    }

    $destPkg = Join-Path $dest 'package.json'
    $gotVer = $null
    if (Test-Path $destPkg) {
        try { $gotVer = (Get-Content $destPkg -Raw | ConvertFrom-Json).version } catch { }
    }
    if ($gotVer -eq $expectedVer) {
        Ok ("  version " + $gotVer)
    } else {
        Bad ("  version mismatch: expected " + $expectedVer + ", got " + $gotVer)
    }
    Line ''
}

foreach ($home in $homes) {
    Head ("DSH_HOME = " + $home)
    $nm = Join-Path $home ("profiles\" + $Profile + "\node_modules")
    if (-not (Test-Path $nm)) {
        Warn2 '  this home has no such profile, skipping'
        Line ''
        continue
    }

    $top = Join-Path $nm 'dsh-plugin-llminqq'
    if (Test-Path (Join-Path $top 'package.json')) {
        Sync-Target $top 'top-level node_modules'
        $script:totalTargets++
    } else {
        Info '[top-level node_modules] not present, skipping'
        Line ''
    }

    $pnpm = Join-Path $nm '.pnpm'
    $pnpmHits = 0
    if (Test-Path $pnpm) {
        $dirs = Get-ChildItem $pnpm -Directory -Filter 'dsh-plugin-llminqq@*' -ErrorAction SilentlyContinue
        foreach ($d in $dirs) {
            $real = Join-Path $d.FullName 'node_modules\dsh-plugin-llminqq'
            if (Test-Path (Join-Path $real 'package.json')) {
                Sync-Target $real (".pnpm real copy (" + $d.Name + ")")
                $pnpmHits++
                $script:totalTargets++
            }
        }
    }
    if ($pnpmHits -eq 0) {
        Info 'no .pnpm copy (not installed from store)'
        Line ''
    }
}

Line '========================================================='
if ($script:totalTargets -eq 0) {
    Bad 'no target found -- plugin may not be installed in this profile'
    Info ("install it first: dsh plugin --profile " + $Profile + " add file:" + $src)
} else {
    Ok ("updated " + $script:totalTargets + " location(s)")
    Line ''
    Line '  Next steps:'
    Line '    1. FULLY quit dsh (Task Manager: no dsh/node process, tray icon counts too)'
    Line '    2. start dsh again'
    Line '    3. hard-refresh browser: Ctrl+Shift+R'
    Line '    4. Settings - QQ Channel - Login tab shows the environment card on top'
    Line ''
    Line ("  Startup log prints: [llminqq] v" + $expectedVer + " loaded ... code at <path>")
}
Line '========================================================='
Line ''
