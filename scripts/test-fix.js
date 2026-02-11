/**
 * Strips single-line comments (-- or //) from a JMXQuery script.
 * Correcty handles comments outside of single or double quoted strings.
 */
function stripJmxqComments(script) {
    if (!script) return script;

    const lines = script.split(/\r?\n/);
    const cleanedLines = lines.map(line => {
        let inSingleQuote = false;
        let inDoubleQuote = false;
        let escaped = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === "'" && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                continue;
            }

            if (char === '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                continue;
            }

            if (!inSingleQuote && !inDoubleQuote) {
                // Check for -- or //
                if ((char === '-' && line[i + 1] === '-') || (char === '/' && line[i + 1] === '/')) {
                    return line.substring(0, i).trimEnd();
                }
            }
        }
        return line;
    });

    return cleanedLines.filter(line => line.trim().length > 0).join('\n');
}

// TEST CASES
const tests = [
    {
        name: "Simple comment stripping",
        input: "FROM Customer -- This is a comment\n| SELECT *",
        expected: "FROM Customer\n| SELECT *"
    },
    {
        name: "Comment with //",
        input: "FROM Item // Another comment\n| LIMIT 10",
        expected: "FROM Item\n| LIMIT 10"
    },
    {
        name: "Symbols inside single quotes",
        input: "FROM Customer\n| FILTER Name = 'Test -- Not a comment'",
        expected: "FROM Customer\n| FILTER Name = 'Test -- Not a comment'"
    },
    {
        name: "Symbols inside double quotes",
        input: 'FROM "Table -- With Hyphens"\n| SELECT *',
        expected: 'FROM "Table -- With Hyphens"\n| SELECT *'
    },
    {
        name: "Multiple comments",
        input: "-- Header comment\nFROM Customer -- Inline comment\n| SELECT * -- Final comment",
        expected: "FROM Customer\n| SELECT *"
    },
    {
        name: "Escaped quotes",
        input: "FROM Customer | FILTER Name = 'O\\'Brian' -- Comment here",
        expected: "FROM Customer | FILTER Name = 'O\\'Brian'"
    },
    {
        name: "User script from log",
        input: `INSERT "Purchase Header" WITH VALIDATION
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
| LIMIT 1`,
        expected: `INSERT "Purchase Header" WITH VALIDATION
| RECORD (
  "Document Type" = 'Invoice',
  "Buy-from Vendor No." = 'K00080',
  "Document Date" = '2026-02-11',
  "Posting Date" = '2026-02-11',
  "Vendor Invoice No." = 'EKX001',
  "Currency Code" = 'EUR',
  "Prices Including VAT" = false
)
FROM "Purchase Header" AS ph
| FILTER ph."Buy-from Vendor No." = 'K00080' AND ph."Vendor Invoice No." = 'EKX001'
| SELECT ph."No.", ph.SystemCreatedAt
| ORDER BY ph.SystemCreatedAt DESC
| LIMIT 1`
    }
];

let failed = 0;
tests.forEach(t => {
    const actual = stripJmxqComments(t.input);
    if (actual === t.expected) {
        console.log(`PASS: ${t.name}`);
    } else {
        console.log(`FAIL: ${t.name}`);
        console.log(`  Expected: ${JSON.stringify(t.expected)}`);
        console.log(`  Actual:   ${JSON.stringify(actual)}`);
        failed++;
    }
});

process.exit(failed > 0 ? 1 : 0);
