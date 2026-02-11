const payload = {
    "executionContextCode": "PURCHASE",
    "script": "INSERT \"Purchase Header\" WITH VALIDATION\n| RECORD (\n  \"Document Type\" = 'Invoice',\n  \"Buy-from Vendor No.\" = 'K00080',\n  \"Document Date\" = '2026-02-11',\n  \"Posting Date\" = '2026-02-11',\n  \"Vendor Invoice No.\" = 'EKX001',\n  \"Currency Code\" = 'EUR',\n  \"Prices Including VAT\" = false\n)\n\n-- Ermittle die soeben erzeugte Document No. (neuester Eintrag mit diesen Kriterien)\nFROM \"Purchase Header\" AS ph\n| FILTER ph.\"Buy-from Vendor No.\" = 'K00080' AND ph.\"Vendor Invoice No.\" = 'EKX001'\n| SELECT ph.\"No.\", ph.SystemCreatedAt\n| ORDER BY ph.SystemCreatedAt DESC\n| LIMIT 1"
};

const json = JSON.stringify(payload);
console.log(`JSON length: ${json.length}`);
console.log(`Char at 285: '${json[285]}'`);
console.log(`Snippet around 285: '${json.substring(280, 290)}'`);

// Replicate PowerShell escaping
const psEscaped = json.replace(/'/g, "''");
console.log(`PS Escaped Char at 285: '${psEscaped[285]}'`);
console.log(`PS Snippet around 285: '${psEscaped.substring(280, 290)}'`);
