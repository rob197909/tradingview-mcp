<#
  launch_msix_debug.ps1

  Launch the Microsoft Store / MSIX TradingView Desktop with the Chrome DevTools
  Protocol debug port enabled.

  Why this works when the .bat / .vbs don't: `Start-Process <exe>` and
  `explorer.exe shell:AppsFolder\<AUMID>` do NOT forward command-line arguments to
  a packaged (MSIX/UWP) app, so --remote-debugging-port never reaches the Electron
  process. The Windows shell COM interface IApplicationActivationManager's
  ActivateApplication() DOES forward the argument string, so the flag takes effect.

  Adapted from https://github.com/emremigh/tradingview-mcp-windows-msix-fix
  (launch_msix_debug.ps1). The COM activation logic is unchanged; the interactive
  Clear-Host / ReadKey were removed and Port / Aumid were parameterized so it can
  run non-interactively (e.g. called from launch_tv_debug.bat). See TV_MCP_OVERVIEW.md section 7.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch_msix_debug.ps1 [-Port 9222]
  Exit codes: 0 = CDP up, 1 = launch failed, 2 = launched but CDP not detected.
#>
param(
    [int]$Port = 9222,
    [string]$Aumid = "TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop",
    [int]$WaitSeconds = 120
)

$ErrorActionPreference = "Stop"

# --- COM: IApplicationActivationManager (verbatim GUIDs from the Windows SDK) ---
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TVLauncher {
    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager {
        int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
                                [MarshalAs(UnmanagedType.LPWStr)] string arguments,
                                int options, out uint processId);
    }

    [ComImport]
    [Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c")]
    public class ApplicationActivationManager { }

    public static uint Launch(string aumid, string args) {
        var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid = 0;
        int hr = mgr.ActivateApplication(aumid, args, 0, out pid);
        if (hr != 0) { throw new Exception("ActivateApplication failed. HRESULT: " + hr); }
        return pid;
    }
}
"@

Write-Host "Killing existing TradingView processes..." -ForegroundColor Gray
Get-Process -Name "TradingView" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "Activating $Aumid with --remote-debugging-port=$Port ..." -ForegroundColor Green
try {
    $procId = [TVLauncher]::Launch($Aumid, "--remote-debugging-port=$Port")
    Write-Host "Activated (pid $procId)." -ForegroundColor Gray
} catch {
    Write-Host "Launch failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "Polling http://localhost:$Port/json/version (up to ${WaitSeconds}s)..." -ForegroundColor Yellow
# MSIX cold-start + Electron init can take ~45-95s (observed) before the debug port opens.
$elapsed = 0
while ($elapsed -lt $WaitSeconds) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) {
            Write-Host "=== CDP UP after ~${elapsed}s ===" -ForegroundColor Green
            Write-Host $r.Content
            exit 0
        }
    } catch {}
    Start-Sleep -Seconds 2
    $elapsed += 2
}
Write-Host "TradingView launched but CDP not detected on port $Port after ${WaitSeconds}s." -ForegroundColor Red
exit 2
