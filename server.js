require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());            // allow http://localhost:* and file:// pages
app.use(express.json());

// ---- dirs & flags ----
const uploadsDir = path.join(__dirname, 'uploads');   // kept for clarity; not used with memory storage
const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

const SAVE_OUTPUTS = String(process.env.SAVE_OUTPUTS).toLowerCase() === 'true';

// serve saved outputs (handy in browser)
app.use('/outputs', express.static(outputsDir));
app.get('/outputs/list', async (_req, res) => {
  try {
    const files = (await fsp.readdir(outputsDir))
      .filter(f => f.endsWith('.json'))
      .sort();
    res.json({ files });
  } catch (e) {
    res.json({ files: [], error: e.message });
  }
});

// ---- multer (resume ONLY, memory storage to avoid Windows ENOENT) ----
const upload = multer({ storage: multer.memoryStorage() });

// ---- anthropic client ----
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ---- Claude model fallback helper ----
const MODEL_CANDIDATES = [
  process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-haiku-20240307'
];

async function callClaude(systemPrompt, userPayload) {
  if (!anthropic) throw new Error('Anthropic client not configured');
  let lastErr;
  for (const model of MODEL_CANDIDATES) {
    try {
      const msg = await anthropic.messages.create({
        model,
        max_tokens: 1800,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(userPayload) }]
      });
      return msg;
    } catch (e) {
      const status = e?.response?.status;
      const body = e?.response?.data;
      const msg = e?.message || String(e);
      const notFound = status === 404 || /not_found_error/i.test(msg) || /model/i.test(msg);
      if (notFound) {
        console.warn('Model not available, trying next:', model, body ? `\n${JSON.stringify(body)}` : '');
        lastErr = e;
        continue;
      }
      throw e; // other errors: stop
    }
  }
  throw lastErr || new Error('No available Claude models from candidate list.');
}

// ---- helpers ----
async function parsePDFBuffer(buf) {
  try {
    const data = await pdfParse(buf);
    return data.text || '';
  } catch (e) {
    console.error('PDF parse error:', e.message);
    return '';
  }
}

// Build up to 5 chunks (~500–800 chars), sentence-aware
function createChunksFromText(text, artifactId = 'a1', maxChunks = 5) {
  const chunks = [];
  const excerpt = (text || '').slice(0, 2000);
  const sentences = excerpt.split(/(?<=[.!?])\s+/);
  let buf = '';
  for (const s of sentences) {
    const next = buf ? buf + ' ' + s : s;
    if (next.length > 800) {
      if (buf.length > 120) chunks.push({ artifact_id: artifactId, text: buf.trim() });
      buf = s;
    } else {
      buf = next;
    }
    if (chunks.length >= maxChunks) break;
  }
  if (buf.length > 120 && chunks.length < maxChunks) {
    chunks.push({ artifact_id: artifactId, text: buf.trim() });
  }
  return chunks.slice(0, maxChunks);
}

// ---- health ----
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    anthropic_configured: !!anthropic,
    model_candidates: MODEL_CANDIDATES,
    storage: 'memory',
    save_outputs: SAVE_OUTPUTS
  });
});

// ---- resume-only processor ----
app.post('/process', upload.single('resume'), async (req, res) => {
  try {
    const about = req.body?.about || '';
    if (!req.file) return res.status(400).json({ error: 'Resume (PDF) is required' });

    // 1) PDF -> text (from memory buffer)
    console.log('Got resume bytes:', req.file.buffer?.length || 0);
    const resumeText = await parsePDFBuffer(req.file.buffer);

    // 2) Build artifact
    const artifact = {
      id: 'a1',
      type: 'pdf',
      title: req.file.originalname || 'resume.pdf',
      source_url: null,
      text_excerpt: (resumeText || '').slice(0, 2000)
    };

    // 3) Create chunks
    const chunks = createChunksFromText(resumeText, 'a1');

    // 4) Ask Claude (if key present), else fallback
    let extracted = { skills: [], projects: [], keywords: [], profile: {} };

    if (anthropic && chunks.length) {
      try {
        const systemPrompt = `You extract only verifiable information from a resume PDF and a short self-description.

Return VALID JSON ONLY with:
{
  "profile": {"about":"1–2 sentences using ONLY provided 'about'","interests":["k1","k2","k3"]},
  "skills":[{"name":"...","level":"beginner|intermediate|advanced","evidence":[{"artifact_id":"a1","snippet":"20–40 word VERBATIM quote from the resume"}]}],
  "projects":[{"title":"...","summary":"one line","evidence":[{"artifact_id":"a1","snippet":"..."}]}],
  "keywords":["normalized","skill","tags"]
}
Rules: no speculation; every listed skill must include at least one evidence item with artifact_id "a1"; output JSON ONLY (no prose outside JSON).`;

        const msg = await callClaude(systemPrompt, { about, artifacts: chunks });
        const txt = msg?.content?.[0]?.text || '{}';
        try { extracted = JSON.parse(txt); } catch {}
      } catch (e) {
        console.error('Claude error:', e?.response?.data || e.message);
      }
    } else {
      // Fallback if no key
      extracted = {
        skills: [
          { name: 'Communication', level: 'intermediate', evidence: [{ artifact_id: 'a1', snippet: 'Presented results to stakeholders and coordinated cross-team deliverables.' }] }
        ],
        projects: [],
        keywords: ['communication']
      };
    }

    // 5) Final response (resume-only)
    const response = {
      session_id: 'resume-demo',
      artifacts: [artifact],
      skills: extracted.skills || [],
      projects: extracted.projects || [],
      keywords: extracted.keywords || [],
      profile: extracted.profile || {}
    };

    // 6) Save to outputs/
    if (SAVE_OUTPUTS) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outPath = path.join(outputsDir, `resume_${stamp}.json`);
      await fsp.writeFile(outPath, JSON.stringify(response, null, 2));
      await fsp.writeFile(path.join(outputsDir, 'latest.json'), JSON.stringify(response, null, 2));
      console.log('💾 Saved output to:', outPath);

      // also save the plain text excerpt for quick viewing (optional)
      await fsp.writeFile(path.join(outputsDir, 'artifact_a1.txt'), artifact.text_excerpt || '');
    }

    return res.json(response);
  } catch (e) {
    console.error('Process error:', e);
    return res.status(500).json({ error: 'Processing failed', message: e.message });
  }
});

// ---- start ----
app.listen(PORT, () => {
  console.log(`Prooffolio (resume-only) running on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️ ANTHROPIC_API_KEY not set (using fallback data)');
  }
});
