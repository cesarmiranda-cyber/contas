#!/usr/bin/env python3
"""
Extrai marca / modelo / ano / combustivel da Tabela FIPE para CSV, usando os
endpoints do site oficial (veiculos.fipe.org.br). Nao precisa de token.

Gera UM CSV POR MODELO, um depois do outro, em saida/<marca>/<modelo>.csv.
Pula modelos cujo CSV ja existe, entao se for interrompido basta rodar de
novo para retomar.

Uso:
  python fipe_csv.py --marca toyota --modelo hilux corolla etios
  python fipe_csv.py --marca ford --marca fiat --modelo ka uno
  python fipe_csv.py --marca toyota              (todos os modelos da marca)
  python fipe_csv.py --tipo carros               (todas as marcas e modelos)
  python fipe_csv.py --marca toyota --juntar toyota.csv

--marca e --modelo podem ser repetidos ou receber varios valores; cada um
filtra pelo nome (contem). Os modelos sao processados na ordem informada.

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


def limpo(nome):
    return re.sub(r"[^A-Za-z0-9_-]+", "_", nome).strip("_")


def juntar(pasta, destino):
    arquivos = sorted(glob.glob(os.path.join(pasta, "**", "*.csv"),
                                recursive=True))
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
    print(f"{n} linhas de {len(arquivos)} arquivos em {destino}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tipo", default="carros", choices=list(TIPOS))
    ap.add_argument("--marca", nargs="+", action="extend",
                    help="filtra marcas pelo nome (contem); aceita varias")
    ap.add_argument("--modelo", nargs="+", action="extend",
                    help="filtra modelos pelo nome (contem); aceita varios")
    ap.add_argument("--saida", default="fipe_saida", help="pasta de saida")
    ap.add_argument("--juntar", metavar="ARQUIVO",
                    help="ao final, junta todos os CSVs neste arquivo")
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
        fs = [f.lower() for f in args.marca]
        marcas = [m for m in marcas
                  if any(f in m["Label"].lower() for f in fs)]
    if not marcas:
        sys.exit("Nenhuma marca encontrada.")

    for marca in marcas:
        print(f"Marca {marca['Label']}")
        modelos = post(s, "ConsultarModelos",
                       {**base, "codigoMarca": marca["Value"]})["Modelos"]
        time.sleep(args.pausa)

        if args.modelo:
            # na ordem informada: um filtro por vez, sem repetir modelo
            escolhidos, vistos = [], set()
            for f in args.modelo:
                for mod in modelos:
                    if f.lower() in mod["Label"].lower() \
                            and mod["Value"] not in vistos:
                        vistos.add(mod["Value"])
                        escolhidos.append(mod)
                if not any(f.lower() in m["Label"].lower() for m in modelos):
                    print(f"  modelo '{f}' nao encontrado nesta marca")
            modelos = escolhidos

        pasta = os.path.join(args.saida, limpo(marca["Label"]))
        os.makedirs(pasta, exist_ok=True)
        for mod in modelos:
            destino = os.path.join(
                pasta, f"{limpo(mod['Label'])}_{mod['Value']}.csv")
            if os.path.exists(destino):
                print(f"  {mod['Label']}: ja existe, pulando")
                continue
            anos = post(s, "ConsultarAnoModelo",
                        {**base, "codigoMarca": marca["Value"],
                         "codigoModelo": mod["Value"]})
            time.sleep(args.pausa)
            # grava via .tmp para nao deixar CSV pela metade
            tmp = destino + ".tmp"
            with open(tmp, "w", newline="", encoding="utf-8-sig") as fh:
                w = csv.writer(fh, delimiter=";")
                w.writerow(["tipo", "marca", "modelo", "ano", "combustivel",
                            "codigo_marca", "codigo_modelo", "codigo_ano"])
                for a in anos:
                    w.writerow([
                        args.tipo, marca["Label"], mod["Label"],
                        ano(a["Label"]), combustivel(a["Label"]),
                        marca["Value"], mod["Value"], a["Value"],
                    ])
            os.replace(tmp, destino)
            print(f"  {mod['Label']}: {len(anos)} linhas -> {destino}")

    if args.juntar:
        juntar(args.saida, args.juntar)


if __name__ == "__main__":
    main()
