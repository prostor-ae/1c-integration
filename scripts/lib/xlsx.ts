/**
 * Dependency-free CSV and XLSX writers shared by the repository scripts.
 *
 * The XLSX writer emits a minimal SpreadsheetML workbook (inline strings, no
 * shared string table) inside a stored (uncompressed) ZIP container.
 */
import { Buffer } from "node:buffer";
import fs from "node:fs";

export type CsvCell = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvCell>;
export type ExcelSheet = {
  name: string;
  headers: string[];
  rows: CsvRow[];
};
type ZipEntry = {
  name: string;
  data: Buffer;
};

export function toCsv(headers: string[], rows: CsvRow[]): string {
  const headerLine = headers.map(escapeCsvCell).join(",");
  const rowLines = rows.map((row) =>
    headers.map((header) => escapeCsvCell(row[header])).join(","),
  );
  return `${[headerLine, ...rowLines].join("\n")}\n`;
}

function escapeCsvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function writeExcelWorkbook(
  filePath: string,
  sheets: ExcelSheet[],
): void {
  const workbookSheets = toExcelWorkbookSheets(sheets);
  const files: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(contentTypesXml(workbookSheets.length), "utf8"),
    },
    { name: "_rels/.rels", data: Buffer.from(rootRelationshipsXml(), "utf8") },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(workbookXml(workbookSheets), "utf8"),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        workbookRelationshipsXml(workbookSheets.length),
        "utf8",
      ),
    },
  ];

  workbookSheets.forEach((sheet, index) => {
    files.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(worksheetXml(sheet.headers, sheet.rows), "utf8"),
    });
  });

  fs.writeFileSync(filePath, createStoredZip(files));
}

function toExcelWorkbookSheets(sheets: ExcelSheet[]): ExcelSheet[] {
  const used = new Set<string>();

  return sheets.map((sheet, index) => {
    const baseName =
      normalizeExcelSheetName(sheet.name) || `Sheet ${index + 1}`;
    let name = baseName;
    let suffix = 2;

    while (used.has(name.toLowerCase())) {
      const suffixText = ` ${suffix}`;
      name = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }

    used.add(name.toLowerCase());
    return { ...sheet, name };
  });
}

function normalizeExcelSheetName(name: string): string {
  return name
    .replace(/\.csv$/i, "")
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
}

function contentTypesXml(sheetCount: number): string {
  const worksheetOverrides = Array.from({ length: sheetCount }, (_, index) => {
    const sheetNumber = index + 1;
    return `<Override PartName="/xl/worksheets/sheet${sheetNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }).join("");

  return xmlDeclaration(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      worksheetOverrides +
      `</Types>`,
  );
}

function rootRelationshipsXml(): string {
  return xmlDeclaration(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
}

function workbookXml(sheets: ExcelSheet[]): string {
  const sheetXml = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${
          index + 1
        }"/>`,
    )
    .join("");

  return xmlDeclaration(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheetXml}</sheets>` +
      `</workbook>`,
  );
}

function workbookRelationshipsXml(sheetCount: number): string {
  const relationships = Array.from({ length: sheetCount }, (_, index) => {
    const sheetNumber = index + 1;
    return `<Relationship Id="rId${sheetNumber}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetNumber}.xml"/>`;
  }).join("");

  return xmlDeclaration(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      relationships +
      `</Relationships>`,
  );
}

function worksheetXml(headers: string[], rows: CsvRow[]): string {
  const worksheetRows = [
    headers,
    ...rows.map((row) => headers.map((header) => row[header])),
  ];

  const sheetData = worksheetRows
    .map((values, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = values
        .map((value, columnIndex) =>
          excelCellXml(value, columnIndex + 1, rowNumber),
        )
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return xmlDeclaration(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${sheetData}</sheetData>` +
      `</worksheet>`,
  );
}

function excelCellXml(
  value: CsvCell,
  columnNumber: number,
  rowNumber: number,
): string {
  const cellRef = `${excelColumnName(columnNumber)}${rowNumber}`;
  const text = value === null || value === undefined ? "" : String(value);
  const preserveSpace = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";

  return `<c r="${cellRef}" t="inlineStr"><is><t${preserveSpace}>${escapeXmlText(
    text,
  )}</t></is></c>`;
}

function excelColumnName(columnNumber: number): string {
  let name = "";
  let current = columnNumber;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }

  return name;
}

function xmlDeclaration(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const flags = 0x0800;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  });

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce(
    (total, part) => total + part.length,
    0,
  );
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectorySize, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endOfCentralDirectory]);
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);

  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;

  for (let index = 0; index < data.length; index++) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
