$src = "C:\Game\MyIDE\screenshot_ide.png"
$dst = "C:\Users\rorch\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\local-agent-mode-sessions\014587b1-aa4e-4c2f-a543-69ebdb818b24\a40a73ec-b7ac-4d8b-ac8f-56f00d991308\local_45149d82-5199-4bbf-a80e-799bc4115ceb\outputs\screenshot_ide.png"
Copy-Item -Path $src -Destination $dst -Force
Write-Output "Copiato: $((Get-Item $dst).Length) byte"
