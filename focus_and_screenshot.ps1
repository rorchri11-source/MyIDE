Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
}
"@

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Porta Electron in primo piano
$processes = Get-Process -Name "electron" -ErrorAction SilentlyContinue
foreach ($p in $processes) {
    if ($p.MainWindowHandle -ne 0) {
        [Win32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null  # SW_RESTORE
        [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
        Write-Output "Finestra trovata: $($p.MainWindowTitle)"
    }
}

Start-Sleep -Milliseconds 1500

# Screenshot
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$outPath = "C:\Users\rorch\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\local-agent-mode-sessions\014587b1-aa4e-4c2f-a543-69ebdb818b24\a40a73ec-b7ac-4d8b-ac8f-56f00d991308\local_45149d82-5199-4bbf-a80e-799bc4115ceb\outputs\myide_focused.png"
$bmp.Save($outPath)
$g.Dispose()
$bmp.Dispose()
Write-Output "Screenshot: $outPath"
