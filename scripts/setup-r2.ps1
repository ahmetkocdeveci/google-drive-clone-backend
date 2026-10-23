function Set-R2Environment {
    param([Security.SecureString]$AccessKeyId, [Security.SecureString]$SecretAccessKey, [string]$EnvPath)
    if (!$AccessKeyId -or !$SecretAccessKey -or !$AccessKeyId.Length -or !$SecretAccessKey.Length) { throw 'Iki anahtar da gerekli.' }
    if (!(Test-Path -LiteralPath $EnvPath -PathType Leaf)) { throw 'Backend .env dosyasi bulunamadi.' }
    if ((Get-Item -LiteralPath $EnvPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Normal .env dosyasi gerekli.' }
    $idPointer = [IntPtr]::Zero
    $secretPointer = [IntPtr]::Zero
    $temporary = "$EnvPath.r2-write-$([guid]::NewGuid().ToString('N'))"
    try {
        $idPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AccessKeyId)
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecretAccessKey)
        $id = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($idPointer).Trim()
        $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
        if ($id -notmatch '^[a-fA-F0-9]{32}$' -or $secret -notmatch '^[a-fA-F0-9]{64}$') { throw 'R2 S3 Access Key ID ve Secret Access Key alanlarini kullan.' }
        $settings = [ordered]@{
            STORAGE_DRIVER = 's3'
            S3_REGION = 'auto'
            S3_ENDPOINT = 'https://d9664dd0f93cb0783865ff40b76b1dd7.r2.cloudflarestorage.com'
            S3_BUCKET = 'google-drive-clone-files'
            S3_ACCESS_KEY_ID = $id
            S3_SECRET_ACCESS_KEY = $secret
            S3_FORCE_PATH_STYLE = 'false'
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
        if ($idPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($idPointer) }
        if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        $id = $null; $secret = $null; $settings = $null; $setting = $null; $source = $null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
        $accessKey = Read-Host 'R2 Access Key ID (gizli giris)' -AsSecureString
        $secretKey = Read-Host 'R2 Secret Access Key (gizli giris)' -AsSecureString
        Set-R2Environment -AccessKeyId $accessKey -SecretAccessKey $secretKey -EnvPath $envPath
        Write-Host 'R2 ayari .env dosyasina kaydedildi. Atlas ve diger ayarlar korundu.'
        Write-Host 'Anahtarlar yazdirilmadi. Gercek R2 baglanti testi henuz yapilmadi.'
    } catch {
        Write-Host 'Kayit basarisiz. Access Key ID (32 hex), Secret Access Key (64 hex) ve backend .env dosyasini kontrol et.'
        exit 1
    } finally {
        if ($accessKey) { $accessKey.Dispose() }
        if ($secretKey) { $secretKey.Dispose() }
    }
}
