# Publica o site estatico da Moobe no servidor via PuTTY (pscp/plink).
# Uso (PowerShell, dentro da pasta site\moobe):
#   .\deploy\publicar.ps1 -Server <IP> -User <usuario> -Key "C:\caminho\chave.ppk" -Dest /var/www/http/moobe
# Requer PuTTY instalado (pscp.exe e plink.exe no PATH). Nenhum segredo fica neste arquivo.
param(
  [Parameter(Mandatory)][string]$Server,
  [Parameter(Mandatory)][string]$User,
  [Parameter(Mandatory)][string]$Key,
  [string]$Dest = "/var/www/http/moobe"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$files = @("index.html","logo.png","favicon.svg") | ForEach-Object { Join-Path $root $_ }
foreach ($f in $files) { if (-not (Test-Path $f)) { throw "Arquivo nao encontrado: $f" } }

Write-Host "1/3 Conferindo a pasta de destino (nao cria nem apaga nada fora dela)..."
plink -i $Key "$User@$Server" "test -d '$Dest' && ls -ld '$Dest' || echo 'PASTA NAO EXISTE: $Dest'"

Write-Host "2/3 Enviando index.html, logo.png e favicon.svg para $Dest ..."
pscp -i $Key @files "$User@${Server}:$Dest/"
if ($LASTEXITCODE -ne 0) { throw "Falha no envio (pscp). Nada foi publicado. Confira a senha da chave e tente de novo." }

Write-Host "3/3 Conferindo os arquivos publicados..."
plink -i $Key "$User@$Server" "ls -l '$Dest'"
Write-Host "Pronto. Falta o proxy apontar moobe.com.br para $Dest (veja deploy/nginx-moobe.conf)."
