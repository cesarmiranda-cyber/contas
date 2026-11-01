#!/usr/bin/env python3
"""
Extrai marca / modelo / ano / combustivel da Tabela FIPE para CSV, usando os
endpoints do site oficial (veiculos.fipe.org.br). Nao precisa de token.

Gera um CSV por marca na pasta de saida e PULA marcas cujo CSV ja existe,
entao se for interrompido basta rodar de novo para retomar.

Uso:
  python fipe_csv.py --tipo carros --saida fipe_carros
  python fipe_csv.py --tipo carros --marca toyota --saida fipe_carros
  python fipe_csv.py --tipo carros --juntar fipe_carros.csv --saida fipe_carros

Tipos: carros, motos, caminhoes.
Obs.: nao inclui preco (exigiria 1 requisicao extra por modelo/ano).
"""
import argparse
import csv
import glob
import os
import re
import sys
import time

import requests

BASE = "https://veiculos.fipe.org.br/api/veiculos"
TIPOS = {"carros": 1, "motos": 2, "caminhoes": 3}


def post(sessao, rota, dados, tentativas=5):
    for i in range(1, tentativas + 1):
        try:
            r = sessao.post(f"{BASE}/{rota}", data=dados, timeout=30)
            if r.status_code in (429, 503):
                raise requests.RequestException(f"HTTP {r.status_code}")
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            if i == tentativas:
                raise
            espera = 3 * 2 ** (i - 1)
            print(f"  aviso: {e}; nova tentativa em {espera}s", file=sys.stderr)
            time.sleep(espera)


def combustivel(rotulo):
    m = re.match(r"^\d+\s+(.*)$", rotulo.strip())
    return m.group(1) if m else ""


def ano(rotulo):
    m = re.match(r"^(\d+)", rotulo.strip())
    if not m:
        return ""
    n = int(m.group(1))
    return "0km" if n == 32000 else n


def nome_arquivo(marca):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", marca).strip("_") + ".csv"


def juntar(pasta, destino):
    arquivos = sorted(glob.glob(os.path.join(pasta, "*.csv")))
    n = 0
    with open(destino, "w", newline="", encoding="utf-8-sig") as out:
        w = csv.writer(out, delimiter=";")
        cab = False
        for a in arquivos:
            with open(a, newline="", encoding="utf-8-sig") as fh:
                linhas = list(csv.reader(fh, delimiter=";"))
            if not linhas:
                continue
            if not cab:
                w.writerow(linhas[0])
                cab = True
            w.writerows(linhas[1:])
            n += len(linhas) - 1
    print(f"{n} linhas de {len(arquivos)} marcas em {destino}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tipo", default="carros", choices=list(TIPOS))
    ap.add_argument("--marca", help="filtra marcas pelo nome (contem)")
    ap.add_argument("--saida", default="fipe_saida", help="pasta de saida")
    ap.add_argument("--juntar", metavar="ARQUIVO",
                    help="ao final, junta os CSVs por marca neste arquivo")
    ap.add_argument("--pausa", type=float, default=0.5,
                    help="segundos entre requisicoes (padrao 0.5)")
    args = ap.parse_args()

    s = requests.Session()
    s.headers.update({
        "Referer": "https://veiculos.fipe.org.br/",
        "Origin": "https://veiculos.fipe.org.br",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) fipe-csv/1.0",
        "Accept": "application/json",
    })
    tipo = TIPOS[args.tipo]

    tabelas = post(s, "ConsultarTabelaDeReferencia", {})
    tabela = tabelas[0]  # a mais recente
    print(f"Tabela de referencia: {tabela['Mes'].strip()}")
    base = {"codigoTipoVeiculo": tipo, "codigoTabelaReferencia": tabela["Codigo"]}

    marcas = post(s, "ConsultarMarcas", base)
    if args.marca:
        f = args.marca.lower()
        marcas = [m for m in marcas if f in m["Label"].lower()]
    if not marcas:
        sys.exit("Nenhuma marca encontrada.")

    os.makedirs(args.saida, exist_ok=True)
    for marca in marcas:
        destino = os.path.join(args.saida, nome_arquivo(marca["Label"]))
        if os.path.exists(destino):
            print(f"Marca {marca['Label']}: ja existe, pulando")
            continue
        print(f"Marca {marca['Label']}")
        modelos = post(s, "ConsultarModelos",
                       {**base, "codigoMarca": marca["Value"]})["Modelos"]
        time.sleep(args.pausa)

        linhas = []
        for mod in modelos:
            anos = post(s, "ConsultarAnoModelo",
                        {**base, "codigoMarca": marca["Value"],
                         "codigoModelo": mod["Value"]})
            time.sleep(args.pausa)
            for a in anos:
                linhas.append([
                    args.tipo, marca["Label"], mod["Label"],
                    ano(a["Label"]), combustivel(a["Label"]),
                    marca["Value"], mod["Value"], a["Value"],
                ])

        # grava so no fim da marca (via .tmp) para nao deixar CSV pela metade
        tmp = destino + ".tmp"
        with open(tmp, "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.writer(fh, delimiter=";")
            w.writerow(["tipo", "marca", "modelo", "ano", "combustivel",
                        "codigo_marca", "codigo_modelo", "codigo_ano"])
            w.writerows(linhas)
        os.replace(tmp, destino)
        print(f"  {len(modelos)} modelos, {len(linhas)} linhas")

    if args.juntar:
        juntar(args.saida, args.juntar)


if __name__ == "__main__":
    main()
