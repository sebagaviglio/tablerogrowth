"""
azure_to_sheets.py

Exporta las "campañas" vigentes de Azure DevOps a la pestaña "Campañas" del
mismo Google Sheet que ya alimenta el Tablero de Growth de Bancor, y le
agrega una columna con una interpretación en texto generada por Claude
(Anthropic) a partir de la Description de cada work item.

IMPORTANTE — esto NO usa un work item type custom "Campaña" (no existe en
Azure DevOps). Las campañas son work items tipo "Requirement" que viven bajo
el Area Path de Growth, con los datos de la campaña (nombre, ID, canales,
etc.) escritos como texto libre dentro del campo Description, con formato
"· Campo: valor" por línea.

Criterio de filtrado (confirmado con capturas reales de un work item):
  - System.WorkItemType = 'Requirement'
  - System.State = 'Active'  (vigente hoy)
  - System.AreaPath UNDER 'Servicios\\Marketing\\PRD-Growth'

Columnas que se exportan por campaña:
  - ID: System.Id de Azure DevOps. Se usa como clave para no volver a
    gastar API de Claude en campañas que ya tienen interpretación cargada
    de una corrida anterior.
  - Nombre: System.Title tal cual.
  - Estado: System.State.
  - Fecha inicio / Fecha fin: sin dato disponible hoy, quedan vacías.
  - Squad/Canal: último segmento del Area Path.
  - Presupuesto: se busca una línea "Presupuesto: ..." en la Description
    (texto libre); si no está, queda vacío.
  - Interpretación IA: párrafo generado por Claude a partir de la
    Description completa (objetivo, canal, público). SOLO se genera para
    campañas nuevas o que todavía no tengan una interpretación cargada —
    las que ya la tienen de una corrida anterior se reusan tal cual, para
    no re-gastar API cada día.

Pensado para correr como job programado (ver
.github/workflows/azure-campaigns-sync.yml) — NO se ejecuta desde el
browser ni desde el dashboard, así que el PAT, las credenciales de Google
y la API key de Claude nunca quedan expuestos en el HTML/JS del cliente.

Requisitos:
    pip install requests gspread google-auth
"""

import base64
import html
import os
import re
import sys
import tempfile
import time

import requests
import gspread
from google.oauth2.service_account import Credentials

# ============================================================
# CONFIGURACIÓN — todo sale de variables de entorno
# ============================================================

# --- Azure DevOps ---
AZURE_ORG = os.environ["AZURE_ORG"]
AZURE_PROJECT = os.environ["AZURE_PROJECT"]
AZURE_PAT = os.environ["AZURE_DEVOPS_PAT"]

CAMPAIGN_WORK_ITEM_TYPE = os.environ.get("AZURE_CAMPAIGN_WIT", "Requirement")
CAMPAIGN_STATE = os.environ.get("AZURE_CAMPAIGN_STATE", "Active")
CAMPAIGN_AREA_PATH_ROOT = os.environ.get(
    "AZURE_CAMPAIGN_AREA_PATH", r"Servicios\Marketing\PRD-Growth"
)

WIQL_QUERY = f"""
SELECT [System.Id]
FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] = '{CAMPAIGN_WORK_ITEM_TYPE}'
  AND [System.State] = '{CAMPAIGN_STATE}'
  AND [System.AreaPath] UNDER '{CAMPAIGN_AREA_PATH_ROOT}'
ORDER BY [System.Id]
"""

FIELDS = [
    "System.Id",
    "System.Title",
    "System.State",
    "System.AreaPath",
    "System.Description",
]

SHEET_HEADERS = [
    "ID", "Nombre", "Estado", "Fecha inicio", "Fecha fin",
    "Squad/Canal", "Presupuesto", "Interpretación IA",
]

# --- Google Sheets ---
GOOGLE_SERVICE_ACCOUNT_JSON_B64 = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON_B64"]
GOOGLE_SHEET_ID = os.environ["GOOGLE_SHEET_ID"]
GOOGLE_SHEET_TAB_NAME = "Campañas"

# --- Claude (Anthropic) ---
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

# ============================================================
# LÓGICA
# ============================================================

AZURE_BASE_URL = f"https://dev.azure.com/{AZURE_ORG}/{AZURE_PROJECT}/_apis"

_TAG_RE = re.compile(r"<[^>]+>")
_BUDGET_RE = re.compile(r"presupuesto\s*[:\-]\s*(.+)", re.IGNORECASE)


def get_auth_header():
    token = base64.b64encode(f":{AZURE_PAT}".encode()).decode()
    return {"Authorization": f"Basic {token}", "Content-Type": "application/json"}


def get_work_item_ids():
    url = f"{AZURE_BASE_URL}/wit/wiql?api-version=7.1"
    body = {"query": WIQL_QUERY}
    resp = requests.post(url, json=body, headers=get_auth_header())
    resp.raise_for_status()
    return [wi["id"] for wi in resp.json().get("workItems", [])]


def get_work_items_details(ids):
    all_items = []
    batch_size = 200
    for i in range(0, len(ids), batch_size):
        batch_ids = ids[i:i + batch_size]
        ids_str = ",".join(str(x) for x in batch_ids)
        fields_str = ",".join(FIELDS)
        url = (
            f"{AZURE_BASE_URL}/wit/workitems"
            f"?ids={ids_str}&fields={fields_str}&api-version=7.1"
        )
        resp = requests.get(url, headers=get_auth_header())
        resp.raise_for_status()
        all_items.extend(resp.json().get("value", []))
    return all_items


def strip_html(raw):
    if not raw:
        return ""
    text = _TAG_RE.sub("\n", raw)
    return html.unescape(text)


def extract_budget(description_html):
    text = strip_html(description_html)
    m = _BUDGET_RE.search(text)
    if not m:
        return ""
    return m.group(1).split("\n")[0].strip()


def squad_from_area_path(area_path):
    if not area_path:
        return ""
    return area_path.strip().split("\\")[-1]


def generate_ai_interpretation(title, description_html):
    """Le pide a Claude un párrafo interpretando de qué se trata la campaña."""
    description_text = strip_html(description_html).strip()
    if not description_text:
        description_text = "(sin descripción cargada)"

    prompt = (
        "Este es un work item de Azure DevOps que describe una campaña de "
        "marketing de Bancor. Escribí UN SOLO PÁRRAFO en español (sin título, "
        "sin bullets, sin markdown) que interprete de qué se trata la campaña: "
        "qué objetivo tiene, qué canal(es) usa y a qué público apunta, en base "
        "a la información disponible. Si algún dato no está en el texto, no lo "
        "inventes ni lo menciones. Máximo 4-5 líneas.\n\n"
        f"Título: {title}\n\n"
        f"Descripción:\n{description_text}"
    )

    body = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": 300,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    for attempt in range(3):
        try:
            resp = requests.post(ANTHROPIC_API_URL, json=body, headers=headers, timeout=30)
            if resp.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            data = resp.json()
            parts = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
            return " ".join(parts).strip()
        except requests.exceptions.RequestException as e:
            print(f"  AVISO: falló la llamada a Claude (intento {attempt+1}/3): {e}")
            time.sleep(1)
    return ""


def load_existing_interpretations(worksheet):
    """Lee lo que ya está en la pestaña y arma {ID: interpretación} para no
    volver a generar interpretaciones de campañas que ya la tenían."""
    try:
        rows = worksheet.get_all_values()
    except Exception:
        return {}
    if not rows:
        return {}
    header = [h.strip().lower() for h in rows[0]]
    try:
        id_idx = header.index("id")
        interp_idx = header.index("interpretación ia")
    except ValueError:
        # Pestaña de una corrida anterior sin estas columnas todavía.
        return {}
    existing = {}
    for row in rows[1:]:
        if len(row) <= max(id_idx, interp_idx):
            continue
        wid, interp = row[id_idx].strip(), row[interp_idx].strip()
        if wid and interp:
            existing[wid] = interp
    return existing


def flatten_work_item(item, existing_interpretations):
    fields = item.get("fields", {})
    wid = str(item.get("id", ""))
    title = fields.get("System.Title", "")
    state = fields.get("System.State", "")
    area_path = fields.get("System.AreaPath", "")
    description = fields.get("System.Description", "")

    if wid in existing_interpretations:
        interpretation = existing_interpretations[wid]
        print(f"  #{wid}: interpretación ya existía, la reuso.")
    else:
        print(f"  #{wid}: generando interpretación nueva con Claude...")
        interpretation = generate_ai_interpretation(title, description)

    return [
        wid,
        title,
        state,
        "",  # Fecha inicio — sin dato disponible hoy
        "",  # Fecha fin — sin dato disponible hoy
        squad_from_area_path(area_path),
        extract_budget(description),
        interpretation,
    ]


def get_sheet():
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds_json = base64.b64decode(GOOGLE_SERVICE_ACCOUNT_JSON_B64).decode("utf-8")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
        tmp.write(creds_json)
        tmp_path = tmp.name
    try:
        creds = Credentials.from_service_account_file(tmp_path, scopes=scopes)
    finally:
        os.remove(tmp_path)
    client = gspread.authorize(creds)
    return client.open_by_key(GOOGLE_SHEET_ID)


def get_or_create_worksheet(sheet, n_rows):
    try:
        return sheet.worksheet(GOOGLE_SHEET_TAB_NAME), True
    except gspread.exceptions.WorksheetNotFound:
        ws = sheet.add_worksheet(
            title=GOOGLE_SHEET_TAB_NAME, rows=max(n_rows + 10, 20), cols=len(SHEET_HEADERS) + 2
        )
        return ws, False


def main():
    print(
        f"Consultando '{CAMPAIGN_WORK_ITEM_TYPE}' con State='{CAMPAIGN_STATE}' "
        f"bajo Area Path '{CAMPAIGN_AREA_PATH_ROOT}'..."
    )
    ids = get_work_item_ids()
    print(f"  -> {len(ids)} campañas vigentes encontradas.")

    sheet = get_sheet()
    worksheet, existed = get_or_create_worksheet(sheet, len(ids))
    existing_interpretations = load_existing_interpretations(worksheet) if existed else {}
    print(f"  -> {len(existing_interpretations)} interpretaciones reutilizables de corridas anteriores.")

    if not ids:
        print("No hay campañas vigentes. Escribo solo encabezados y termino.")
        worksheet.clear()
        worksheet.update([SHEET_HEADERS])
        return

    print("Obteniendo detalles de cada campaña...")
    items = get_work_items_details(ids)

    print("Procesando datos (Presupuesto por texto, Interpretación IA solo si hace falta)...")
    rows = [flatten_work_item(item, existing_interpretations) for item in items]

    print(f"Escribiendo en la pestaña '{GOOGLE_SHEET_TAB_NAME}' del Google Sheet...")
    worksheet.clear()
    worksheet.update([SHEET_HEADERS] + rows)

    print("Listo! Campañas exportadas correctamente.")


if __name__ == "__main__":
    try:
        main()
    except requests.exceptions.HTTPError as e:
        print(f"ERROR de API: {e}", file=sys.stderr)
        print(f"  Respuesta: {e.response.text if e.response is not None else ''}", file=sys.stderr)
        sys.exit(1)
