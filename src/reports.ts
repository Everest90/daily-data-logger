import { formatDate, formatTime } from "./reportFormatting";
import type { LogRecord } from "./types";

type ReportScope = "today" | "all";

export async function downloadPdfReport(
  records: LogRecord[],
  scope: ReportScope,
  date: string,
  workspaceName?: string,
  localCopy = false,
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const tableWidth = pageWidth - margin * 2;
  const columns = [
    { title: "Date", width: 21, value: (record: LogRecord) => formatDate(record.date, { day: "2-digit", month: "short", year: "2-digit" }) },
    { title: "Label", width: 17, value: (record: LogRecord) => record.label },
    { title: "Depositor", width: 28, value: (record: LogRecord) => record.depositor },
    { title: "Item", width: 25, value: (_record: LogRecord, item: LogRecord["items"][number]) => item.type === "Others" ? item.detail.replace(/^Other item: /, "") : item.type },
    { title: "Statement / detail", width: 48, value: (_record: LogRecord, item: LogRecord["items"][number]) => `${item.statement}${item.detail && item.type !== "Others" ? ` · ${item.detail}` : ""}` },
    { title: "Payment", width: 19, value: (_record: LogRecord, item: LogRecord["items"][number]) => item.payment },
    { title: "Collector", width: 25, value: (_record: LogRecord, item: LogRecord["items"][number]) => item.collector || "—" },
    { title: "Status / done time", width: 29, value: (_record: LogRecord, item: LogRecord["items"][number]) => item.completed ? `Completed${item.completedAt ? ` · ${formatTime(item.completedAt)}` : ""}` : "Pending" },
    { title: "Created", width: 23, value: (record: LogRecord) => formatTime(record.createdAt) },
  ];
  const totalItems = records.reduce((sum, record) => sum + record.items.length, 0);
  const completed = records.reduce((sum, record) => sum + record.items.filter((item) => item.completed).length, 0);
  const title = scope === "today" ? `Daily activity · ${formatDate(date)}` : "Daily activity · All records";
  let y = 16;

  const drawHeader = (continued = false) => {
    doc.setFillColor(19, 34, 57);
    doc.rect(0, 0, pageWidth, 33, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(continued ? `${title} (continued)` : title, margin, 13);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(`${workspaceName ? `Workspace: ${workspaceName} · ` : "Local device · "}${records.length} ${records.length === 1 ? "entry" : "entries"} · ${totalItems} items · ${completed} completed · ${totalItems - completed} pending`, margin, 21);
    if (localCopy) {
      doc.setTextColor(255, 211, 130);
      doc.text("LOCAL COPY — other devices may have unsynced changes.", margin, 28);
    } else {
      doc.setTextColor(210, 220, 238);
      doc.text(`Generated ${new Date().toLocaleString()}`, margin, 28);
    }
    doc.setTextColor(28, 38, 53);
    y = 40;
    doc.setFillColor(235, 239, 246);
    doc.rect(margin, y - 5, tableWidth, 8, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    let x = margin + 1;
    for (const column of columns) {
      doc.text(column.title, x, y);
      x += column.width;
    }
    y += 6;
  };

  if (columns.reduce((sum, column) => sum + column.width, 0) > tableWidth) {
    throw new Error("The PDF report columns exceed the printable page width.");
  }

  drawHeader();
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  for (const record of records) {
    for (const item of record.items) {
      const cells = columns.map((column) => column.value(record, item));
      const wrapped = cells.map((cell, index) => doc.splitTextToSize(cell, columns[index].width - 2) as string[]);
      const rowHeight = Math.max(5, ...wrapped.map((lines) => lines.length * 3.2 + 1));
      if (y + rowHeight > pageHeight - 14) {
        doc.addPage();
        drawHeader(true);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
      }
      if (Math.floor(y / 6) % 2 === 0) {
        doc.setFillColor(249, 250, 252);
        doc.rect(margin, y - 3.5, tableWidth, rowHeight, "F");
      }
      let x = margin + 1;
      wrapped.forEach((lines, index) => {
        doc.text(lines, x, y);
        x += columns[index].width;
      });
      y += rowHeight;
    }
  }

  if (totalItems === 0) {
    doc.setTextColor(95, 105, 120);
    doc.text("No records to report.", margin, y + 3);
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setTextColor(110, 120, 135);
    doc.setFontSize(7);
    doc.text(`Page ${page} of ${pages}`, pageWidth - margin, pageHeight - 6, { align: "right" });
  }

  doc.save(`daily-data-logger-${scope}-${date}.pdf`);
}
