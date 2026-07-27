#!/usr/bin/env python3
"""Convert the per-brand supplier price-list templates (CSV/XLSX drops in
incoming/pricing-templates/) into the universal price-list file
src/seed/data/price-lists.json, consumed by `npm run import:pricing`.

Stdlib only — CSVs are sniffed as utf-8-sig or cp1252, XLSX is read straight
from the zip (sharedStrings + sheet1). Every template shares one 14-column
layout; this script normalises the messy bits (currency naming, item-type
casing, Excel serial dates, float noise) and fails loudly on anything it
cannot map, listing every offending file:line.

Usage: python3 scripts/convert-price-lists.py [input-dir] [output-json]
"""
import csv
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_IN = REPO / 'incoming' / 'pricing-templates'
DEFAULT_OUT = REPO / 'src' / 'seed' / 'data' / 'price-lists.json'

EXPECTED_HEADER = [
    'date effective', 'product range', 'code', 'description', 'item type',
    'pack type', 'contents', 'width', 'repeat', 'vertical repeat',
    'duty rate', 'wholesale rate', 'currency', 'freight rate',
]

CATEGORY_BY_ITEM_TYPE = {
    'fabrics': 'fabric',
    'w/p': 'wallpaper',
    'trimmings': 'trimming',
    'accessories': 'accessory',
}
CATEGORY_BY_FILE_TOKEN = {'FABRIC': 'fabric', 'WPPR': 'wallpaper', 'TRIMMING': 'trimming'}
UNIT_BY_PACK = {'p/m': 'metre', 'p/y': 'yard', 'p/roll': 'roll', 'p/p': 'piece'}
CURRENCY_MAP = {'euro': 'EUR', 'us dollar': 'USD', 'pound sterling': 'GBP'}
FREIGHT_CLASSES = {'A', 'B', 'C', 'D', 'E'}
DUTY_CLASSES = {'A'}

# Filename prefixes whose plain title-casing would mangle the supplier name.
SUPPLIER_OVERRIDES = {
    'JV': 'Jannelli Volpi',
    'JV DESIGN LICENSE': 'JV Design',
    'JWALL': 'JWall',
    'C&C MILANO': 'C&C Milano',
}

FILENAME_RE = re.compile(r'^(?P<name>.+?)(?:\s+(?P<token>FABRIC|WPPR|TRIMMING))?\s+PL\b')
EXCEL_EPOCH = date(1899, 12, 30)
XML_NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def parse_filename(stem):
    match = FILENAME_RE.match(stem)
    if not match:
        raise ValueError(f'cannot derive supplier from filename "{stem}"')
    prefix = match.group('name').strip()
    supplier = SUPPLIER_OVERRIDES.get(prefix) or ' '.join(w.capitalize() for w in prefix.split())
    return supplier, CATEGORY_BY_FILE_TOKEN.get(match.group('token') or '')


def sniff_decode(raw):
    for encoding in ('utf-8-sig', 'cp1252'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode('latin-1')


def csv_rows(path):
    reader = csv.reader(io.StringIO(sniff_decode(path.read_bytes())))
    for line_no, row in enumerate(reader, 1):
        yield line_no, row


def xlsx_rows(path):
    with zipfile.ZipFile(path) as z:
        try:
            sst_root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            strings = [''.join(t.text or '' for t in si.iter(f'{XML_NS}t')) for si in sst_root]
        except KeyError:
            strings = []
        sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    for line_no, row in enumerate(sheet.iter(f'{XML_NS}row'), 1):
        cells = {}
        for c in row.findall(f'{XML_NS}c'):
            col = 0
            for ch in c.get('r', ''):
                if not ch.isalpha():
                    break
                col = col * 26 + ord(ch.upper()) - 64
            v = c.find(f'{XML_NS}v')
            value = '' if v is None or v.text is None else v.text
            if c.get('t') == 's' and value != '':
                value = strings[int(value)]
            cells[col - 1] = value
        width = max(cells, default=-1) + 1
        yield line_no, [cells.get(i, '') for i in range(width)]


def parse_date(value, is_xlsx):
    value = value.strip()
    if not value:
        return None
    if is_xlsx:
        return (EXCEL_EPOCH + timedelta(days=int(float(value)))).isoformat()
    day, month, year = value.split('/')
    return date(int(year), int(month), int(day)).isoformat()


def clean_measure(value):
    """Trim; collapse float noise like '256.60000000000002' to '256.6'."""
    value = value.strip()
    if not value:
        return None
    try:
        return format(round(float(value), 4), 'g')
    except ValueError:
        return value


def normalise_row(row, line_no, source, supplier, file_category, is_xlsx, errors, skipped):
    def fail(message):
        errors.append(f'{source}:{line_no}: {message}')

    row = [(cell or '').strip() for cell in (row + [''] * 14)[:14]]
    (raw_date, product_range, code, description, item_type, pack, contents,
     width, repeat, vertical_repeat, duty, wholesale, currency, freight) = row

    category = CATEGORY_BY_ITEM_TYPE.get(item_type.lower()) or file_category
    if not category:
        return fail(f'unmappable item type "{item_type}"')
    unit = UNIT_BY_PACK.get(pack.lower())
    if not unit:
        return fail(f'unmappable pack type "{pack}"')
    iso_currency = CURRENCY_MAP.get(' '.join(currency.lower().split()))
    if not iso_currency:
        return fail(f'unmappable currency "{currency}"')
    freight = freight.upper() or None
    if freight and freight not in FREIGHT_CLASSES:
        return fail(f'unknown freight class "{freight}"')
    duty = duty.upper() or None
    if duty and duty not in DUTY_CLASSES:
        return fail(f'unknown duty class "{duty}"')
    if not code:
        return fail('empty code')
    # Platform decision 6 (15 Jul): standardise supplier codes to the uniform
    # format on import; keep the raw code so mismatches stay traceable.
    code_normalized = re.sub(r'-+', '-', re.sub(r'[^A-Z0-9]+', '-', code.upper())).strip('-')
    if not code_normalized:
        return fail(f'code "{code}" normalises to nothing')
    try:
        # No comma handling on purpose: "65,50" is ambiguous (EU decimal vs thousands),
        # and no current template uses commas — fail loudly so a human decides.
        rate = round(float(wholesale), 4)
    except ValueError:
        return fail(f'non-numeric wholesale rate "{wholesale}"')
    if rate == 0:
        # Unpriced rows (price on application / not yet priced) carry nothing usable.
        return skipped.append(f'{source}:{line_no}: {code} "{description}" has no wholesale rate')
    if rate < 0:
        return fail(f'negative wholesale rate {rate}')
    try:
        effective = parse_date(raw_date, is_xlsx)
    except (ValueError, IndexError):
        return fail(f'bad date "{raw_date}"')

    return {
        'supplier': supplier,
        'product_range': product_range or None,
        'category': category,
        'code': code,
        'code_normalized': code_normalized,
        'description': description or None,
        'contents': contents or None,
        'unit': unit,
        'width': clean_measure(width),
        'repeat': clean_measure(repeat),
        'vertical_repeat': clean_measure(vertical_repeat),
        'duty_class': duty,
        'wholesale_rate': rate,
        'currency': iso_currency,
        'freight_class': freight,
        'date_effective': effective,
        'source_file': source,
    }


def convert(input_dir, output_path):
    files = sorted(p for p in input_dir.iterdir() if p.suffix.lower() in ('.csv', '.xlsx'))
    if not files:
        raise SystemExit(f'no price-list files found in {input_dir}')

    items, errors, skipped, duplicates_dropped = {}, [], [], 0
    for path in files:
        is_xlsx = path.suffix.lower() == '.xlsx'
        supplier, file_category = parse_filename(path.stem)
        rows = xlsx_rows(path) if is_xlsx else csv_rows(path)
        line_no, header = next(rows)
        normalised_header = [' '.join(h.lower().split()) for h in header[:14]]
        if normalised_header != EXPECTED_HEADER:
            errors.append(f'{path.name}:{line_no}: unexpected header {header}')
            continue
        for line_no, row in rows:
            if not any(str(cell).strip() for cell in row):
                continue
            item = normalise_row(row, line_no, path.name, supplier, file_category, is_xlsx, errors, skipped)
            if item is None:
                continue
            key = (item['supplier'], item['category'], item['code'])
            existing = items.get(key)
            if existing is None:
                items[key] = item
            elif {**existing, 'source_file': ''} == {**item, 'source_file': ''}:
                duplicates_dropped += 1
            else:
                errors.append(
                    f'{path.name}:{line_no}: key {key} conflicts with earlier row from {existing["source_file"]}'
                )

    if errors:
        print(f'{len(errors)} error(s) — nothing written:', file=sys.stderr)
        for error in errors:
            print(f'  {error}', file=sys.stderr)
        raise SystemExit(1)

    ordered = [items[key] for key in sorted(items)]
    lines = ',\n'.join(json.dumps(item, ensure_ascii=False) for item in ordered)
    output_path.write_text(f'[\n{lines}\n]\n', encoding='utf-8')

    if skipped:
        print(f'Skipped {len(skipped)} unpriced row(s):', file=sys.stderr)
        for entry in skipped:
            print(f'  {entry}', file=sys.stderr)

    suppliers = {item['supplier'] for item in ordered}
    print(
        f'Wrote {len(ordered)} items from {len(files)} files '
        f'({len(suppliers)} suppliers, {duplicates_dropped} exact duplicate rows dropped) -> {output_path}'
    )


if __name__ == '__main__':
    input_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IN
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    convert(input_dir, output_path)
