const script = `INSERT "Purchase Header" WITH VALIDATION
| RECORD (
  "Document Type" = 'Invoice',
  "Buy-from Vendor No." = 'K00080',
  "Document Date" = '2026-02-11',
  "Posting Date" = '2026-02-11',
  "Vendor Invoice No." = 'EKX001',
  "Currency Code" = 'EUR',
  "Prices Including VAT" = false
)

-- Ermittle die soeben erzeugte Document No. (neuester Eintrag mit diesen Kriterien)
FROM "Purchase Header" AS ph
| FILTER ph."Buy-from Vendor No." = 'K00080' AND ph."Vendor Invoice No." = 'EKX001'
| SELECT ph."No.", ph.SystemCreatedAt
| ORDER BY ph.SystemCreatedAt DESC
| LIMIT 1`;

// Try both \n and \r\n
const withN = script;
const withRN = script.replace(/\n/g, '\r\n');

console.log(`With \\n: Char at 285: '${withN[285]}'`);
console.log(`With \\n Snippet: '${withN.substring(280, 290)}'`);

console.log(`With \\r\\n: Char at 285: '${withRN[285]}'`);
console.log(`With \\r\\n Snippet: '${withRN.substring(280, 290)}'`);
