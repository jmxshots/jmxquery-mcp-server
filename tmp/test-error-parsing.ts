
function testErrorParsing(message: string) {
    console.log("Original Message:", message);

    // Logic from bcClient.ts
    let processedMessage = message;

    // 1. Globally clean up PowerShell's CLI XML line breaks
    processedMessage = processedMessage.replace(/_x000D__x000A_/g, ' ');

    // 2. Strip the long "Command failed: powershell ... -EncodedCommand <base64>" prefix
    if (processedMessage.includes('-EncodedCommand')) {
        processedMessage = processedMessage.split('#< CLIXML').pop() || processedMessage;
    }

    // 3. Try to extract JSON error from CLIXML string tags <S S="Error">...</S>
    // Improved: First strip all CLIXML tags to avoid fragments breaking the JSON structure
    const cleanedMessage = processedMessage.replace(/<[^>]+>/g, '').trim();
    const jsonMatch = cleanedMessage.match(/({(?:\s|[^}]*)"error"(?:\s|[^}]*)})/);

    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.error?.message) {
                processedMessage = parsed.error.message;
                if (parsed.error.code) {
                    processedMessage += ` (${parsed.error.code})`;
                }
            } else if (parsed.error) {
                processedMessage = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
            }
        } catch (e) {
            console.error("JSON Parse failed:", e);
            // Fallback to the extracted string (cleaned)
            processedMessage = jsonMatch[0];
        }
    } else {
        // 4. Fallback: Use the cleaned message if JSON extraction failed
        processedMessage = cleanedMessage;
    }

    console.log("Processed Message:", processedMessage);
    return processedMessage;
}

const input = `Command failed: powershell ... -EncodedCommand base64data
#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">{"error":{"code":"Unknown","message":"Die Konvertierung von  </S><S S="Error">Microsoft.Dynamics.Nav.Runtime.NavJsonValue in System.Boolean ist nicht m\u00f6glich.  CorrelationId:   </S><S S="Error">2f072532-b734-49c2-8ec6-9bc66e2f2893."}}</S></Objs>`;

const expected = "Die Konvertierung von Microsoft.Dynamics.Nav.Runtime.NavJsonValue in System.Boolean ist nicht möglich. CorrelationId: 2f072532-b734-49c2-8ec6-9bc66e2f2893.";

const result = testErrorParsing(input);

if (result.replace(/\s+/g, ' ').includes("Die Konvertierung von Microsoft.Dynamics.Nav.Runtime.NavJsonValue in System.Boolean ist nicht möglich")) {
    console.log("✅ TEST PASSED");
} else {
    console.log("❌ TEST FAILED");
    process.exit(1);
}
