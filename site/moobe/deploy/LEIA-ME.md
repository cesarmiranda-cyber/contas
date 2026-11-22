# Publicar o site Moobe

Servidor com **Traefik (Docker)** na frente de vários apps. Nada aqui altera os contêineres existentes.

- Arquivos do site: `/var/www/http/moobe` (enviados com `publicar.ps1` ou `pscp`).
- Contêiner nginx do site: `deploy/server/` (compose + nginx.conf), instalado em `/var/www/http/moobe-server`.
- HTTPS: pelo Traefik, resolvedor `le` (validação por DNS via Cloudflare, funciona com o proxy da Cloudflare ligado).
- DNS: só trocar quando o site novo estiver aprovado, pois o domínio hoje mostra o site antigo.
