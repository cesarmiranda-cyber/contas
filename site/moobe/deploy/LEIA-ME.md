# Publicar o site Moobe

Servidor com **Traefik (Docker)** na frente de vários apps. Nada aqui altera os contêineres existentes.

- Arquivos do site: `/var/www/http/moobe` (enviados com `publicar.ps1` ou `pscp`).
- Contêiner nginx do site: `deploy/server/` (compose + nginx.conf), instalado em `/var/www/http/moobe-server`.
- HTTPS: pelo Traefik, resolvedor `tenants` (só emite depois que o DNS de `moobe.com.br` apontar para o servidor).
- DNS: só trocar quando o site novo estiver aprovado, pois o domínio hoje mostra o site antigo.
