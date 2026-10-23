param([switch]$FromJson)

function Set-GoogleEnvironment {
    param([Security.SecureString]$ClientId, [Security.SecureString]$ClientSecret, [string]$EnvPath)
    if (!$ClientId -or !$ClientSecret -or !$ClientId.Length -or !$ClientSecret.Length) { throw 'Iki deger de gerekli.' }
    if (!(Test-Path -LiteralPath $EnvPath -PathType Leaf)) { throw 'Backend .env dosyasi bulunamadi.' }
    if ((Get-Item -LiteralPath $EnvPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Normal .env dosyasi gerekli.' }
    $idPointer = [IntPtr]::Zero
    $secretPointer = [IntPtr]::Zero
    $temporary = "$EnvPath.google-write-$([guid]::NewGuid().ToString('N'))"
    try {
        $idPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ClientId)
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ClientSecret)
        $id = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($idPointer).Trim()
        $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
        # Case-sensitive ASCII matching avoids Turkish-culture I/i folding.
        if ($id -cnotmatch '^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$' -or $id.Length -gt 256) { throw 'Google Client ID alanini kullan.' }
        if ($secret -cnotmatch '^[A-Za-z0-9_-]{16,256}$') { throw 'Google Client Secret alanini kullan.' }
        $settings = [ordered]@{ GOOGLE_CLIENT_ID = $id; GOOGLE_CLIENT_SECRET = $secret }
        $source = [IO.File]::ReadAllText($EnvPath)
        foreach ($name in $settings.Keys) {
            $pattern = [regex]::new('(?m)^' + [regex]::Escape($name) + '=[^\r\n]*')
            if ($pattern.Matches($source).Count -gt 1) { throw 'Tekrarlanan ayar bulundu; dosya degistirilmedi.' }
            $setting = $name + '=' + $settings[$name]
            if ($pattern.IsMatch($source)) { $source = $pattern.Replace($source, [Text.RegularExpressions.MatchEvaluator]{ param($match) $setting }) }
            else { $source = $source.TrimEnd() + "`n" + $setting + "`n" }
        }
        [IO.File]::WriteAllText($temporary, $source, [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($temporary, $EnvPath, [NullString]::Value)
    } finally {
        if ($idPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($idPointer) }
        if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        $id = $null; $secret = $null; $settings = $null; $setting = $null; $source = $null
    }
}

function Import-GoogleEnvironment {
    param([string]$JsonPath, [string]$EnvPath)
    if (!(Test-Path -LiteralPath $JsonPath -PathType Leaf)) { throw 'JSON dosyasi bulunamadi.' }
    if ((Get-Item -LiteralPath $JsonPath).Length -gt 65536) { throw 'Google istemci JSON dosyasini sec.' }
    try { $document = [IO.File]::ReadAllText($JsonPath) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'JSON okunamadi; Google Download JSON dosyasini sec.' }
    if (!$document.web -or !$document.web.client_id -or !$document.web.client_secret) { throw 'Web application istemcisinin Download JSON dosyasini sec.' }
    $expectedCallback = 'http://127.0.0.1:4100/api/v1/auth/google/callback'
    if (@($document.web.redirect_uris) -cnotcontains $expectedCallback) { throw 'JSON icinde beklenen yerel callback adresi yok. Google istemcisini kontrol et ve JSON dosyasini yeniden indir.' }
    $importId = $null
    $importSecret = $null
    try {
        $importId = ConvertTo-SecureString ([string]$document.web.client_id) -AsPlainText -Force
        $importSecret = ConvertTo-SecureString ([string]$document.web.client_secret) -AsPlainText -Force
        Set-GoogleEnvironment -ClientId $importId -ClientSecret $importSecret -EnvPath $EnvPath
    } finally {
        if ($importId) { $importId.Dispose() }
        if ($importSecret) { $importSecret.Dispose() }
        $document = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
        if ($FromJson) {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            $dialog = New-Object System.Windows.Forms.OpenFileDialog
            try {
                $dialog.Title = 'Google Cloud Download JSON dosyasini sec'
                $dialog.Filter = 'Google OAuth JSON (*.json)|*.json'
                $dialog.InitialDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'
                if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Write-Host 'Dosya secilmedi; ayarlar degistirilmedi.'; exit 0 }
                Import-GoogleEnvironment -JsonPath $dialog.FileName -EnvPath $envPath
            } finally { $dialog.Dispose() }
        } else {
            $clientId = Read-Host 'Google Client ID (gizli giris)' -AsSecureString
            $clientSecret = Read-Host 'Google Client Secret (gizli giris)' -AsSecureString
            Set-GoogleEnvironment -ClientId $clientId -ClientSecret $clientSecret -EnvPath $envPath
        }
        Write-Host 'Google ayarlari .env dosyasina kaydedildi. Atlas ve R2 ayarlari korundu.'
        Write-Host 'Degerler yazdirilmadi. Gercek Google giris testi henuz yapilmadi.'
    } catch {
        $safeMessages = @(
            'Iki deger de gerekli.', 'Backend .env dosyasi bulunamadi.', 'Normal .env dosyasi gerekli.',
            'Google Client ID alanini kullan.', 'Google Client Secret alanini kullan.',
            'Tekrarlanan ayar bulundu; dosya degistirilmedi.', 'JSON dosyasi bulunamadi.',
            'Google istemci JSON dosyasini sec.', 'JSON okunamadi; Google Download JSON dosyasini sec.',
            'Web application istemcisinin Download JSON dosyasini sec.',
            'JSON icinde beklenen yerel callback adresi yok. Google istemcisini kontrol et ve JSON dosyasini yeniden indir.'
        )
        Write-Host 'Kayit basarisiz.'
        if ($safeMessages -ccontains $_.Exception.Message) { Write-Host $_.Exception.Message }
        elseif ($_.Exception -is [UnauthorizedAccessException]) { Write-Host 'Dosya erisimi reddedildi; .env dosyasinin yazilabilir oldugunu kontrol et.' }
        else { Write-Host 'Dosya islemi veya secim penceresi acilamadi. Hata turu:' $_.Exception.GetType().Name }
        exit 1
    } finally {
        if ($clientId) { $clientId.Dispose() }
        if ($clientSecret) { $clientSecret.Dispose() }
    }
}
