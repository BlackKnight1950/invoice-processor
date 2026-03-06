const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Clients ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;

const SHEET_ID = '7449139886378884';
const COL = {
  primary:      5691029989314436,
  orgName:      3439230175629188,
  invoiceNum:   7942829802999684,
  dateInvoice:  5128080035893124,
  amountDue:    624480408522628,
  paymentDue:   2876280222207876,
  invoiceOwner: 8940737536937860,
};

// ── Multer: memory storage, max 10MB ─────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
    ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only PDF, PNG, JPG allowed'));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── POST /api/process-invoice ─────────────────────────────────────────────────
app.post('/api/process-invoice', upload.single('invoice'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const fileName = req.file.originalname;
  const base64Data = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype;

  try {
    // ── Step 1: Extract invoice data with Claude AI ──────────────────────────
    console.log(`[${fileName}] Extracting with AI...`);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          {
            type: 'text',
            text: `Extract these fields from the invoice. Return ONLY valid JSON, no markdown, no explanation:
{
  "organizationName": "...",
  "invoiceNumber": "...",
  "dateOfInvoice": "MM/DD/YYYY",
  "amountDue": "numeric only, no $ or commas",
  "paymentDueDate": "MM/DD/YYYY",
  "invoiceOwner": "the name of the person or entity the invoice is billed to or addressed to (the recipient/buyer, not the sender)"
}
Use empty string for any field not found. Dates must be MM/DD/YYYY.`
          }
        ]
      }]
    });

    const raw = message.content.map(c => c.text || '').join('').trim();
    const extracted = JSON.parse(raw.replace(/```json|```/g, '').trim());
    console.log(`[${fileName}] Extracted:`, JSON.stringify(extracted));

    // ── Step 2: Add row to Smartsheet ────────────────────────────────────────
    console.log(`[${fileName}] Adding row to Smartsheet...`);

    const ssRes = await axios.post(
      `https://api.smartsheet.com/2.0/sheets/${SHEET_ID}/rows`,
      [{ toBottom: true, cells: [
        { columnId: COL.primary,      value: fileName },
        { columnId: COL.orgName,      value: extracted.organizationName },
        { columnId: COL.invoiceNum,   value: extracted.invoiceNumber },
        { columnId: COL.dateInvoice,  value: extracted.dateOfInvoice },
        { columnId: COL.amountDue,    value: extracted.amountDue },
        { columnId: COL.paymentDue,   value: extracted.paymentDueDate },
        { columnId: COL.invoiceOwner, value: extracted.invoiceOwner },
      ]}],
      { headers: { Authorization: `Bearer ${SMARTSHEET_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    console.log(`[${fileName}] Smartsheet row response:`, JSON.stringify(ssRes.data));

    const rowId = ssRes.data?.result?.[0]?.id;
    if (!rowId) throw new Error('Smartsheet did not return a row ID — check your API token');

    // ── Step 3: Attach the original file to the row ──────────────────────────
    console.log(`[${fileName}] Attaching file to row ${rowId}...`);

    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: fileName,
      contentType: mediaType,
      knownLength: req.file.buffer.length
    });

    const attachRes = await axios.post(
      `https://api.smartsheet.com/2.0/sheets/${SHEET_ID}/rows/${rowId}/attachments`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${SMARTSHEET_TOKEN}`,
          ...formData.getHeaders()
        }
      }
    );

    console.log(`[${fileName}] Attachment response:`, JSON.stringify(attachRes.data));

    const attachmentId = attachRes.data?.result?.id;
    if (!attachmentId) {
      console.warn(`[${fileName}] Warning: file attached but no attachment ID returned`);
    }

    res.json({ success: true, extracted, rowId, attachmentId, fileName });

  } catch (err) {
    console.error(`[${fileName}] Error:`, err.message);
    if (err.response) {
      console.error(`[${fileName}] Response data:`, JSON.stringify(err.response.data));
    }
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`PMOE Invoice Processor running on port ${PORT}`));
