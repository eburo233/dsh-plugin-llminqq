# =============================================================================
#  Find which copy of the LLMinQQ plugin dsh actually loads.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File where-is-loaded.ps1
#    powershell -ExecutionPolicy Bypass -File where-is-loaded.ps1 -Profile desktop
#
#  WHY THIS FILE IS PURE ASCII / ENGLISH ONLY:
#    Windows PowerShell 5.1 reads .ps1 files as ANSI (GBK on zh-CN) unless the
#    file starts with a UTF-8 BOM. UTF-8 Chinese without BOM becomes mojibake,
#    which corrupts quote pairing and the parser then reports nonsense such as
#    "redirect operator missing file specification" for those stray angle brackets.
#    English-only sidesteps the entire class of problem.
# =============================================================================
param(
    [string]$Profile = 'web',
    [string]$DshHome = ''
)

$ErrorActionPreference = 'Continue'

function Line($t)  { Write-Host $t }
function Head($t)  { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Bad($t)   { Write-Host "  [BAD]  $t" -ForegroundColor Red }
function Warn2($t) { Write-Host "  [WARN] $t" -ForegroundColor Yellow }
function Info($t)  { Write-Host "         $t" -ForegroundColor Gray }

function Get-PkgVersion($pkgPath) {
    if (-not (Test-Path $pkgPath)) { return $null }
    try {
        $j = Get-Content $pkgPath -Raw | ConvertFrom-Json
        return $j.version
    } catch {
        return 'unparsable'
    }
}

function Test-IsLink($p) {
    if (-not (Test-Path $p)) { return $false }
    $item = Get-Item $p -Force
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
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

Line ''
Line '========================================================='
Line '  Which copy of dsh-plugin-llminqq does dsh load?'
Line '========================================================='
Line ("  profile      : " + $Profile)
Line ("  dsh homes    : " + $homes.Count)

if ($homes.Count -eq 0) {
    Bad ("no dsh home found for profile " + $Profile)
    Info 'specify manually: -DshHome C:\Users\you\.dsh'
    exit 1
}

$findings = @()

foreach ($home in $homes) {
    Head ("DSH_HOME = " + $home)
    $nm = Join-Path $home ("profiles\" + $Profile + "\node_modules")

    $top = Join-Path $nm 'dsh-plugin-llminqq'
    $topPkg = Join-Path $top 'package.json'
    if (Test-Path $topPkg) {
        $ver = Get-PkgVersion $topPkg
        $hasEnv = Test-Path (Join-Path $top 'lib\env.js')
        $isLink = Test-IsLink $top
        Line '  [top-level node_modules]'
        Info ("path: " + $top)
        Info ("version: " + $ver)
        if ($hasEnv) { Info 'lib\env.js: yes' } else { Warn2 'lib\env.js: NO (old version)' }
        if ($isLink) { Warn2 'this directory is a junction/symlink' }
        $findings += New-Object PSObject -Property @{
            Where = 'top'; Path = $top; Version = $ver; HasEnv = $hasEnv; IsLink = $isLink
        }
    } else {
        Info '[top-level node_modules] not present'
    }

    Line ''
    Line '  [.pnpm real copy -- this is what dsh actually loads]'
    $pnpmDir = Join-Path $nm '.pnpm'
    $pnpmFound = $false
    if (Test-Path $pnpmDir) {
        $dirs = Get-ChildItem $pnpmDir -Directory -Filter 'dsh-plugin-llminqq@*' -ErrorAction SilentlyContinue
        foreach ($d in $dirs) {
            $real = Join-Path $d.FullName 'node_modules\dsh-plugin-llminqq'
            $realPkg = Join-Path $real 'package.json'
            if (Test-Path $realPkg) {
                $pnpmFound = $true
                $ver = Get-PkgVersion $realPkg
                $hasEnv = Test-Path (Join-Path $real 'lib\env.js')
                Info ("path: " + $real)
                Info ("version: " + $ver)
                if ($hasEnv) {
                    Ok 'lib\env.js: yes (new version)'
                } else {
                    Bad 'lib\env.js: NO -- THIS IS THE STALE ONE'
                }
                $findings += New-Object PSObject -Property @{
                    Where = 'pnpm'; Path = $real; Version = $ver; HasEnv = $hasEnv; IsLink = $false
                }
            }
        }
    }
    if (-not $pnpmFound) {
        Info 'no .pnpm copy (installed via file: link, not from store)'
    }
}

Head 'RESULT'

$stale = @($findings | Where-Object { -not $_.HasEnv })
$fresh = @($findings | Where-Object { $_.HasEnv })

if ($findings.Count -eq 0) {
    Bad 'plugin not found in any location -- it is not installed in this profile'
    Info ('install it: dsh plugin --profile ' + $Profile + ' add file:D:\DSH-WORKSPACE\LLMinQQ\dsh-plugin-llminqq')
} elseif ($stale.Count -gt 0) {
    Bad ("" + $stale.Count + " stale copy/copies found (missing lib\env.js):")
    foreach ($s in $stale) {
        Line ("    " + $s.Path) 
        Line ("      version " + $s.Version)
    }
    Line ''
    Info 'These are what dsh is loading. Two ways to fix:'
    Info '  A) run update-windows.ps1  (overwrites every location)'
    Info '  B) copy the new files into each path listed above'
} else {
    Ok ("" + $findings.Count + " location(s) all have the new version")
    Line ''
    Info 'Code is up to date. If the UI still looks old, it is BROWSER CACHE:'
    Info '  press Ctrl+Shift+R (plain F5 is not enough), or open an incognito window'
}

$versions = @($findings | Select-Object -ExpandProperty Version -Unique)
if ($versions.Count -gt 1) {
    Line ''
    Warn2 ("version mismatch across locations: " + ($versions -join ' / '))
}

Line ''
Line 'Authoritative answer (no script needed): open in browser'
Line '  http://127.0.0.1:3081/dsh-plugin-llminqq/api/version'
Line '  the pluginRoot field is the path dsh really loaded'
Line ''
