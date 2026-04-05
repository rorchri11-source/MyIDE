Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32b {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT lpRect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Trova finestra Electron (MyIDE)
$proc = Get-Process -Name "electron" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if (-not $proc) { Write-Output "Nessuna finestra Electron trovata!"; exit 1 }

$hwnd = $proc.MainWindowHandle
Write-Output "Titolo: $($proc.MainWindowTitle) | HWND: $hwnd"

# Ripristina e porta in primo piano
[Win32b]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
Start-Sleep -Milliseconds 300
[Win32b]::SetForegroundWindow($hwnd) | Out-Null
[Win32b]::BringWindowToTop($hwnd) | Out-Null
Start-Sleep -Milliseconds 1200

# Screenshot dell'intera finestra tramite PrintWindow
$rect = New-Object Win32b+RECT
[Win32b]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Output "Dimensioni finestra: ${w}x${h}"

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win32b]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()

$outPath = "C:\Users\rorch\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\local-agent-mode-sessions\014587b1-aa4e-4c2f-a543-69ebdb818b24\a40a73ec-b7ac-4d8b-ac8f-56f00d991308\local_45149d82-5199-4bbf-a80e-799bc4115ceb\outputs\myide_window.png"
$bmp.Save($outPath)
$bmp.Dispose()
Write-Output "Salvato: $outPath"
