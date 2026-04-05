Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32c {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT lpRect);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type -AssemblyName System.Drawing

$proc = Get-Process -Name "electron" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$hwnd = $proc.MainWindowHandle

$rect = New-Object Win32c+RECT
[Win32c]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win32c]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()

# Crop solo la barra superiore (primi 60px)
$cropH = 60
$crop = $bmp.Clone([System.Drawing.Rectangle]::FromLTRB(0, 0, $w, $cropH), $bmp.PixelFormat)
$outPath = "C:\Users\rorch\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\local-agent-mode-sessions\014587b1-aa4e-4c2f-a543-69ebdb818b24\a40a73ec-b7ac-4d8b-ac8f-56f00d991308\local_45149d82-5199-4bbf-a80e-799bc4115ceb\outputs\myide_header.png"
$crop.Save($outPath)
$bmp.Dispose()
$crop.Dispose()
Write-Output "Salvato header: $outPath"
