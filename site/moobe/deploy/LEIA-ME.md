# Publicar o site Moobe

Pasta de destino no servidor: `/var/www/http/moobe`. O servidor já tem o manda4.com.br e outros apps atrás de um proxy: **nada aqui altera o que já existe**.

1. **Inspecionar (somente leitura)** – ver qual proxy roda e como os sites atuais estão configurados:
   `ss -ltnp | grep -E ':80|:443'`  e  `ls /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null`
2. **Enviar os arquivos** com `deploy/publicar.ps1` (PowerShell, PuTTY instalado).
3. **Proxy**: criar um bloco novo para `moobe.com.br` (exemplo em `nginx-moobe.conf`), testar com `sudo nginx -t` e recarregar com `sudo systemctl reload nginx`.
4. **DNS**: apontar `moobe.com.br` e `www` (registro A) para o IP do servidor. **Só faça isso quando o site estiver pronto**, pois o domínio atual hospeda o site antigo.
5. **HTTPS**: `certbot` depois que o DNS propagar.
