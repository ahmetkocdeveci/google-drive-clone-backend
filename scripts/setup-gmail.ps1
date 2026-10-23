function Set-GmailEnvironment {
    param([string]$Email, [Security.SecureString]$AppPassword, [string]$EnvPath)
    $Email = $Email.Trim().ToLowerInvariant()
    if ($Email.Length -gt 254 -or $Email -cnotmatch '^[a-z0-9][a-z0-9._%+-]*@(gmail|googlemail)\.com$') { throw 'Gonderici Gmail adresini kullan.' }
    if (!$AppPassword -or !$AppPassword.Length) { throw 'Google uygulama sifresi gerekli.' }
    if (!(Test-Path -LiteralPath $EnvPath -PathType Leaf)) { throw 'Backend .env dosyasi bulunamadi.' }
    if ((Get-Item -LiteralPath $EnvPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Normal .env dosyasi gerekli.' }
    $passwordPointer = [IntPtr]::Zero
    $temporary = "$EnvPath.gmail-write-$([guid]::NewGuid().ToString('N'))"
    try {
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AppPassword)
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer).Trim() -replace '[ \t]', ''
        if ($password -cnotmatch '^[A-Za-z0-9]{16}$') { throw 'Google tarafindan uretilen 16 karakterli uygulama sifresini kullan.' }
        $settings = [ordered]@{
            SMTP_HOST = 'smtp.gmail.com'
            SMTP_PORT = '465'
            SMTP_SECURE = 'true'
            SMTP_USER = $Email
            SMTP_PASSWORD = $password
            MAIL_FROM = "Ortak Drive <$Email>"
        }
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
        if ($passwordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        $password = $null; $settings = $null; $setting = $null; $source = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
        $email = Read-Host 'Gonderici Gmail adresi'
        $appPassword = Read-Host 'Google uygulama sifresi (16 karakter, gizli giris)' -AsSecureString
        Set-GmailEnvironment -Email $email -AppPassword $appPassword -EnvPath $envPath
        Write-Host 'Gmail SMTP ayarlari .env dosyasina kaydedildi. Atlas, R2 ve Google giris ayarlari korundu.'
        Write-Host 'Sifre yazdirilmadi. Baglanti ve gercek e-posta teslimati henuz test edilmedi.'
        Write-Host 'Calisan backend yeni ayarlari yeniden baslatilinca kullanir.'
    } catch {
        $safeMessages = @(
            'Gonderici Gmail adresini kullan.', 'Google uygulama sifresi gerekli.',
            'Backend .env dosyasi bulunamadi.', 'Normal .env dosyasi gerekli.',
            'Google tarafindan uretilen 16 karakterli uygulama sifresini kullan.',
            'Tekrarlanan ayar bulundu; dosya degistirilmedi.'
        )
        Write-Host 'Kayit basarisiz.'
        if ($safeMessages -ccontains $_.Exception.Message) { Write-Host $_.Exception.Message }
        else { Write-Host 'Dosya islemi tamamlanamadi. Hata turu:' $_.Exception.GetType().Name }
        exit 1
    } finally { if ($appPassword) { $appPassword.Dispose() } }
}
