"""
azure_to_sheets.py

Exporta las "campañas" vigentes de Azure DevOps a la pestaña "Campañas" del
mismo Google Sheet que ya alimenta el Tablero de Growth de Bancor.

IMPORTANTE — esto NO usa un work item type custom "Campaña" (no existe en
Azure DevOps). Las campañas son work items tipo "Requirement" que viven bajo
el Area Path de Growth, con los datos de la campaña (nombre, ID, canales,
etc.) escritos como texto libre dentro del campo Description, con formato
"· Campo: valor" por línea. Ver EJEMPLO REAL más abajo.

Criterio de filtrado (confirmado con capturas reales de un work item):
  - System.WorkItemType = 'Requirement'
  - System.State = 'Active'  (vigente hoy; hay otros estados como Proposed)
  - System.AreaPath UNDER 'Servicios\\Marketing\\PRD-Growth'
      (todas las áreas de Growth cuelgan de ahí, ej.
       Servicios\\Marketing\\PRD-Growth\\SCT-Adquisicion Empresas)

Qué se exporta por campaña:
  - Nombre: se usa System.Title tal cual (ya viene con el ID de campaña
    incluido, ej. "128695  BEP84 - Bancor empresas_Alta de producto_...").
  - Estado: System.State.
  - Fecha inicio / Fecha fin: NO hay dato disponible hoy en Azure DevOps
    para esto (se decidió no usar las fechas del Sprint como proxy) —
    quedan vacías. El tablero ya maneja bien este caso (muestra "Sin
    fechas cargadas").
  - Squad/Canal: se toma el ÚLTIMO segmento del Area Path
    (ej. "SCT-Adquisicion Empresas").
  - Presupuesto: se busca una línea "Presupuesto: ..." dentro de la
    Description (texto libre); si no está, queda vacío. NO todas las
    campañas van a tener este dato cargado.

EJEMPLO REAL de Description (HTML, se le sacan las etiquetas antes de parsear):
  ESTRATEGIA DE EXPERIMENTO
  1. Información General
  · Nombre de la campaña: Bancor empresas_Alta de producto_...
  · ID Campaña: BEP84
  · Stakeholders involucrados: Cecilia Ferrer
  · Fecha de armado del brief: 10/08/2026
  · Canales a utilizar: Mail, Zócalo y Notificación Push
  · Tipo de campaña: Unica Vez
  2. Objetivo del Experimento
  ...

Pensado para correr como job programado (ver
.github/workflows/azure-campaigns-sync.yml) — NO se ejecuta desde el
browser ni desde el dashboard, así que el PAT y las credenciales de
Google nunca quedan expuestos en el HTML/JS del cliente.

Requisitos:
    pip install requests gspread google-auth
"""

import base64
import html
import os
import re
import sys
import tempfile

import requests
import gspread
from google.oauth2.service_account import Credentials

# ============================================================
# CONFIGURACIÓN — todo sale de variables de entorno
# ============================================================

# --- Azure DevOps ---
AZURE_ORG = os.environ["AZURE_ORG"]  # "BancorDigital"
AZURE_PROJECT = os.environ["AZURE_PROJECT"]  # "Servicios"
AZURE_PAT = os.environ["AZURE_DEVOPS_PAT"]

# Confirmado con captura real: las campañas son "Requirement", State "Active",
# bajo el Area Path de Growth. Ajustable por variable de entorno si hace falta
# ampliar/acotar el área más adelante, sin tocar el código.
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

SHEET_HEADERS = ["Nombre", "Estado", "Fecha inicio", "Fecha fin", "Squad/Canal", "Presupuesto"]

# --- Google Sheets ---
GOOGLE_SERVICE_ACCOUNT_JSON_B64 = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON_B64"]
GOOGLE_SHEET_ID = os.environ["GOOGLE_SHEET_ID"]
GOOGLE_SHEET_TAB_NAME = "Campañas"

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
    """Description viene como HTML — sacamos etiquetas y des-escapamos entidades."""
    if not raw:
        return ""
    text = _TAG_RE.sub("\n", raw)
    return html.unescape(text)


def extract_budget(description_html):
    """Busca una línea 'Presupuesto: ...' en la Description. No siempre está."""
    text = strip_html(description_html)
    m = _BUDGET_RE.search(text)
    if not m:
        return ""
    # Cortamos en el primer salto de línea por si el regex agarró de más.
    return m.group(1).split("\n")[0].strip()


def squad_from_area_path(area_path):
    if not area_path:
        return ""
    return area_path.strip().split("\\")[-1]


def flatten_work_item(item):
    fields = item.get("fields", {})
    title = fields.get("System.Title", "")
    state = fields.get("System.State", "")
    area_path = fields.get("System.AreaPath", "")
    description = fields.get("System.Description", "")
    return [
        title,
        state,
        "",  # Fecha inicio — sin dato disponible hoy
        "",  # Fecha fin — sin dato disponible hoy
        squad_from_area_path(area_path),
        extract_budget(description),
    ]


def write_to_google_sheet(rows):
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
    sheet = client.open_by_key(GOOGLE_SHEET_ID)
    try:
        worksheet = sheet.worksheet(GOOGLE_SHEET_TAB_NAME)
        worksheet.clear()
    except gspread.exceptions.WorksheetNotFound:
        worksheet = sheet.add_worksheet(
            title=GOOGLE_SHEET_TAB_NAME, rows=max(len(rows) + 10, 20), cols=len(SHEET_HEADERS) + 2
        )

    worksheet.update([SHEET_HEADERS] + rows)


def main():
    print(
        f"Consultando '{CAMPAIGN_WORK_ITEM_TYPE}' con State='{CAMPAIGN_STATE}' "
        f"bajo Area Path '{CAMPAIGN_AREA_PATH_ROOT}'..."
    )
    ids = get_work_item_ids()
    print(f"  -> {len(ids)} campañas vigentes encontradas.")

    if not ids:
        print("No hay campañas vigentes. Escribo solo encabezados y termino.")
        write_to_google_sheet([])
        return

    print("Obteniendo detalles de cada campaña...")
    items = get_work_items_details(ids)

    print("Procesando datos (parseando Description para Presupuesto)...")
    rows = [flatten_work_item(item) for item in items]

    print(f"Escribiendo en la pestaña '{GOOGLE_SHEET_TAB_NAME}' del Google Sheet...")
    write_to_google_sheet(rows)

    print("Listo! Campañas exportadas correctamente.")


if __name__ == "__main__":
    try:
        main()
    except requests.exceptions.HTTPError as e:
        print(f"ERROR de Azure DevOps API: {e}", file=sys.stderr)
        print(f"  Respuesta: {e.response.text if e.response is not None else ''}", file=sys.stderr)
        sys.exit(1)
