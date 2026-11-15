#!/usr/bin/env bash
# Scarica da AnimeClick le pagine che un lavoro deve leggere e le manda al backend.
#
#   scarica-pagine.sh <lavoro> [query]      lavoro: calendario | schede | rapporto
#   variabili: CRON_SECRET (obbligatoria), PROVA (true/false), PAUSA_SECONDI (default 8),
#              API_URL, ANIMECLICK_PREFISSO, ATTESA_RITENTATIVO (solo per le prove: i valori di sempre sono qui sotto)
#
# PERCHÉ QUI: da Render AnimeClick risponde 403 (verifica anti-bot), da GitHub Actions con la firma
# dichiarata del progetto no. Il backend dice QUALI indirizzi leggere (`GET /da-scaricare`), questo
# script li scarica uno alla volta e li manda (`POST /pagina`), poi il workflow chiama il lavoro di
# sempre, che legge le pagine dalla tabella. Vedi sql/032 e services/pagineAnimeClick.js.
#
# LA CORTESIA, che è la condizione per farlo (come in giro-animeclick.yml e copertine-volumi.yml):
#   - firma dichiarata (MangaVault/1.0), mai quella di un browser;
#   - una richiesta ogni PAUSA_SECONDI secondi (otto, se non si dice altro);
#   - se AnimeClick è in pausa (sette giri rifiutati di fila → due settimane) non si chiede niente;
#   - al primo 403 o 429 ci si ferma SUBITO, senza provare le altre pagine;
#   - una pagina che non sembra quella cercata (la verifica anti-bot risponde 200 con altro dentro)
#     vale come un rifiuto: ci si ferma;
#   - tre errori di fila (timeout, 5xx) fermano il giro;
#   - redirect: solo quelli verso l'indirizzo canonico (AnimeClick risponde 301 da
#     anime/<id>/-/ allo slug), al massimo due, solo https, e solo se l'indirizzo finale
#     resta su AnimeClick; un redirect altrove vale come errore. Niente pagine oltre i 3,5 MB.
# NON si cambia indirizzo, firma o strada per aggirare un rifiuto.
#
# Scrive su $GITHUB_OUTPUT: scaricate=<quante>, rifiutato=0|1, in_pausa=0|1, non_accettate=<quante>
# (le pagine scaricate che il backend non ha accettato: un giro così NON è riuscito, anche se AnimeClick ha risposto).
# Esce 0 anche se AnimeClick ha rifiutato (lo dicono gli output: sta al workflow farlo risultare
# fallito DOPO aver fatto il resto); esce 1 solo se il backend non risponde.

set -u

LAVORO="${1:?lavoro mancante}"
QUERY="${2:-}"
API="${API_URL:-https://mangavault10x-api.onrender.com/api/animeclick}"
PREFISSO="${ANIMECLICK_PREFISSO:-https://www.animeclick.it/}"
UA="MangaVault/1.0 (collezione personale; +https://mangavault10x-frontend.vercel.app)"
PAUSA="${PAUSA_SECONDI:-8}"
PROVA="${PROVA:-false}"
USCITA="${GITHUB_OUTPUT:-/dev/null}"

# Una chiamata al backend: ritenta, perché il primo giro sveglia Render.
backend() {
  local metodo="$1" percorso="$2" corpo="${3:-}" codice=000
  for tentativo in 1 2 3; do
    if [ -n "$corpo" ]; then
      codice=$(curl -sS -o risposta.json -w "%{http_code}" --max-time 150 -X "$metodo" \
        -H "X-Cron-Secret: $CRON_SECRET" -H "Content-Type: application/json" \
        --data-binary "@$corpo" "$API$percorso") || codice=000
    else
      codice=$(curl -sS -o risposta.json -w "%{http_code}" --max-time 150 -X "$metodo" \
        -H "X-Cron-Secret: $CRON_SECRET" "$API$percorso") || codice=000
    fi
    [ "$codice" = "200" ] && return 0
    [ "$codice" = "400" ] && break
    sleep "${ATTESA_RITENTATIVO:-10}"
  done
  echo "Il backend ha risposto HTTP $codice su $percorso" >&2
  cat risposta.json >&2 2>/dev/null || true
  return 1
}

fine() {
  { echo "scaricate=$1"; echo "rifiutato=$2"; echo "in_pausa=$3"; echo "non_accettate=${4:-0}"; } >> "$USCITA"
}

# 1. Che cosa scaricare, e se si può.
if ! backend GET "/da-scaricare?lavoro=$LAVORO$QUERY"; then
  fine 0 0 0 0
  exit 1
fi

if [ "$(jq -r '.tentare' risposta.json)" != "true" ]; then
  echo "AnimeClick è in pausa fino al $(jq -r '.in_pausa_fino' risposta.json): non chiedo niente."
  fine 0 0 1 0
  exit 0
fi

jq -r '.urls[]' risposta.json > indirizzi.txt
totale=$(wc -l < indirizzi.txt | tr -d ' ')
echo "Da scaricare: $totale pagine ($LAVORO), una ogni $PAUSA secondi."

scaricate=0
non_accettate=0
rifiutato=0
motivo=""
errori_di_fila=0
n=0

# 2. Una alla volta, distanziate.
while IFS= read -r url; do
  [ -z "$url" ] && continue
  n=$((n+1))

  case "$url" in
    "$PREFISSO"*) ;;
    *) echo "Indirizzo fuori da AnimeClick, lo salto: $url" >&2; continue ;;
  esac

  esito=$(curl -sS -o pagina.html -w "%{http_code} %{url_effective}" --max-time 40 --max-filesize 3500000 \
    -L --max-redirs 2 --proto-redir =https \
    -A "$UA" -H "Accept-Language: it-IT,it;q=0.9" "$url") || esito="000 $url"
  codice="${esito%% *}"
  finale="${esito#* }"

  # Un redirect che porta fuori da AnimeClick non si accetta: vale come errore.
  case "$finale" in
    "$PREFISSO"*) ;;
    *) echo "[$n/$totale] redirect fuori da AnimeClick, lo scarto: $finale" >&2; codice=000 ;;
  esac

  case "$codice" in
    403|429)
      echo "[$n/$totale] HTTP $codice: AnimeClick dice di no. Mi fermo."
      rifiutato=1; motivo="HTTP $codice"
      break
      ;;
    200)
      if grep -qi "animeclick" pagina.html && grep -qi "</html>" pagina.html; then
        errori_di_fila=0
        jq -n --arg u "$url" --rawfile h pagina.html '{url: $u, html: $h}' > corpo.json
        if backend POST /pagina corpo.json; then
          scaricate=$((scaricate+1))
          echo "[$n/$totale] ok: ${url#"$PREFISSO"}"
        else
          non_accettate=$((non_accettate+1))
          echo "[$n/$totale] la pagina non è stata accettata dal backend: ${url#"$PREFISSO"}"
        fi
      else
        echo "[$n/$totale] HTTP 200 ma non è una pagina di AnimeClick (verifica anti-bot?). Mi fermo."
        rifiutato=1; motivo="HTTP 200 ma pagina diversa dal previsto"
        break
      fi
      ;;
    404)
      # Una serie tolta dal sito: succede, non è un rifiuto e non conta come errore.
      echo "[$n/$totale] HTTP 404: ${url#"$PREFISSO"} non esiste più, la salto."
      errori_di_fila=0
      ;;
    *)
      errori_di_fila=$((errori_di_fila+1))
      echo "[$n/$totale] HTTP $codice su ${url#"$PREFISSO"} ($errori_di_fila di fila)"
      if [ "$errori_di_fila" -ge 3 ]; then
        echo "Tre errori di fila: mi fermo."
        rifiutato=1; motivo="tre errori di fila (ultimo HTTP $codice)"
        break
      fi
      ;;
  esac

  [ "$n" -lt "$totale" ] && sleep "$PAUSA"
done < indirizzi.txt

# 3. Com'è andata: un rifiuto conta un fallimento (uno solo per giro), un giro riuscito azzera il conto.
if [ "$rifiutato" = "1" ]; then
  jq -n --arg m "$motivo" --arg l "$LAVORO" --argjson p "$PROVA" '{riuscito: false, motivo: $m, lavoro: $l, prova: $p}' > corpo.json
  backend POST /esito corpo.json || echo "L'esito non è stato registrato." >&2
elif [ "$scaricate" -gt 0 ]; then
  jq -n --arg l "$LAVORO" --argjson p "$PROVA" '{riuscito: true, lavoro: $l, prova: $p}' > corpo.json
  backend POST /esito corpo.json || echo "L'esito non è stato registrato." >&2
fi

echo "Scaricate e mandate: $scaricate su $totale (non accettate dal backend: $non_accettate)."
fine "$scaricate" "$rifiutato" 0 "$non_accettate"
exit 0
