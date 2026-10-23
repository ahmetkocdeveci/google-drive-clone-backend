function Set-AtlasEnvironment {
    param([string]$Address, [Security.SecureString]$Password, [string]$EnvPath)
    $cluster = $Address.Trim()
    if ($cluster -match '^mongodb\+srv://[^@\r\n]+@(?<cluster>[a-zA-Z0-9.-]+\.mongodb\.net)(?:/[^#\r\n]*)?$') { $cluster = $Matches.cluster }
    if ($cluster -notmatch '^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+\.mongodb\.net$') { throw 'Atlas adresi gecersiz.' }
    if (!$Password -or !$Password.Length) { throw 'Sifre bos olamaz.' }
    if (!(Test-Path -LiteralPath $EnvPath -PathType Leaf)) { throw 'Once backend klasorunde pnpm setup calistir.' }
    if ((Get-Item -LiteralPath $EnvPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Baglanti dosyasi yerine normal .env dosyasi gerekli.' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    $temporary = "$EnvPath.atlas-write-$([guid]::NewGuid().ToString('N'))"
    try {
        $encoded = [Uri]::EscapeDataString([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
        $setting = 'MONGODB_URI=mongodb+srv://drive_app:' + $encoded + '@' + $cluster + '/ortak_drive?retryWrites=true&w=majority&authSource=admin&appName=drive-cluster'
        $source = [IO.File]::ReadAllText($EnvPath)
        $pattern = [regex]::new('(?m)^MONGODB_URI=[^\r\n]*')
        if ($pattern.Matches($source).Count -gt 1) { throw 'Birden fazla MONGODB_URI ayari bulundu.' }
        if ($pattern.IsMatch($source)) { $updated = $pattern.Replace($source, [Text.RegularExpressions.MatchEvaluator]{ param($match) $setting }) }
        else { $updated = $source.TrimEnd() + "`n" + $setting + "`n" }
        [IO.File]::WriteAllText($temporary, $updated, [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($temporary, $EnvPath, [NullString]::Value)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        $encoded = $null; $setting = $null; $updated = $null; $source = $null
    }
}

# Dot sourcing exposes only the function for isolated verification; it never prompts or updates .env.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
        $address = Read-Host 'Atlas ekranindaki <db_password> iceren baglanti adresini yapistir (sifreyi ekleme)'
        $password = Read-Host 'drive_app kullanicisinin sifresi (gizli giris)' -AsSecureString
        Set-AtlasEnvironment -Address $address -Password $password -EnvPath $envPath
        Write-Host 'Atlas ayari .env dosyasina kaydedildi. Sifre ve baglanti adresi yazdirilmadi.'
        Write-Host 'Veritabani: ortak_drive. Baglanti testi henuz yapilmadi.'
    } catch {
        Write-Host 'Ayar kaydedilemedi. Atlas adresini, sifrenin dolu oldugunu ve backend .env dosyasini kontrol et.'
        exit 1
    } finally { if ($password) { $password.Dispose() } }
}
