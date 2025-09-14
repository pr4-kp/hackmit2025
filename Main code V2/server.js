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

/* ===========================================
   NEW: Serve the frontend at http://localhost:3000/
   Assumes repo layout: PROOFFOLIO-API/{frontend,backend}
   =========================================== */
const FRONTEND_DIR = path.join(__dirname, '../frontend');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
} else {
  console.warn('⚠️ Frontend directory not found at:', FRONTEND_DIR);
}

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

// ---- helpers (resume parse & chunking) ----
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

// =====================================================
//                JOB MATCHING ADDITIONS
// =====================================================

// Load jobs DB (simple JSON file)
const JOBS_PATH = path.join(__dirname, 'jobs', 'jobs.json');
let JOBS = [];
try {
  if (fs.existsSync(JOBS_PATH)) {
    JOBS = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  } else {
    console.warn('⚠️  jobs.json not found at', JOBS_PATH, '(the /jobs/recommend route will return 0 matches until you add it)');
  }
} catch (e) {
  console.error('Failed to read jobs.json:', e.message);
  JOBS = [];
}

// tokenization & scoring
const STOP = new Set(['a','an','and','the','for','to','in','of','on','with','at','as','by','or','be','is','are','am','from','that','this','it','its','we','you','they','their','our','your','i']);
const uniq = arr => [...new Set(arr)];
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\- ]/g, ' ')
    .split(/\s+/)
    .filter(x => x && !STOP.has(x));
}
function jaccard(aSet, bSet) {
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union ? inter / union : 0;
}

// extract keywords from your saved profile JSON
function deriveProfileKeywords(profileJson) {
  const words = [];
  (profileJson.skills || []).forEach(s => words.push(s.name, s.level));
  (profileJson.projects || []).forEach(p => words.push(p.title, p.summary));
  (profileJson.artifacts || []).forEach(a => words.push(a.title, a.type, a.text_excerpt));
  if (profileJson.keywords && Array.isArray(profileJson.keywords)) words.push(...profileJson.keywords);
  if (profileJson.profile?.about) words.push(profileJson.profile.about);
  const toks = tokenize(words.join(' '));
  return uniq(toks).slice(0, 100);
}
function jobKeywords(job) {
  const base = []
    .concat(job.title, job.company, job.location, job.description || '')
    .concat(job.keywords || []);
  return uniq(tokenize(base.join(' ')));
}
function prefilterCandidates(profileTokens, topN = 30) {
  const pset = new Set(profileTokens);
  return JOBS.map(j => {
    const jset = new Set(jobKeywords(j));
    return { job: j, score: jaccard(pset, jset) };
  })
  .sort((a,b) => b.score - a.score)
  .slice(0, topN);
}

// Optional Claude re-rank (uses the callClaude helper above)
async function rerankWithClaude(profile, candidates, limit = 10) {
  if (!anthropic) {
    // No key → baseline only
    return candidates.slice(0, limit).map(({job, score}) => ({
      ...job,
      match_score: Math.round(score * 100),
      reason: 'Keyword overlap baseline'
    }));
  }

  const compactCands = candidates.map(({job, score}) => ({
    id: job.id, title: job.title, company: job.company, location: job.location,
    keywords: job.keywords, description: (job.description || '').slice(0, 500),
    baseline: Math.round(score * 100)
  }));

  const profileExcerpt = {
    skills: (profile.skills || []).slice(0, 20),
    projects: (profile.projects || []).slice(0, 10),
    artifacts: (profile.artifacts || []).slice(0, 6).map(a => ({
      id: a.id || a.title, type: a.type, text_excerpt: (a.text_excerpt || '').slice(0, 200)
    })),
    keywords: profile.keywords || [],
    about: profile.profile?.about || ''
  };

  const systemPrompt = `You are a matching engine. Given a candidate profile and candidate jobs, return ONLY strict JSON:

{ "matches": [ { "job_id": "...", "score": 0-100, "reason": "short" } ] }

Rules:
- Start from provided "baseline" (keyword overlap, 0-100).
- Adjust for fit/mismatch, synonyms, and evidence in profile (skills/projects/artifacts).
- Reasons <= 140 chars, concise and factual.
- Return up to ${limit} items, highest score first.`;

  const msg = await callClaude(systemPrompt, {
    profile: profileExcerpt,
    candidates: compactCands,
    limit
  });

  const txt = msg?.content?.[0]?.text || '{}';
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = { matches: [] }; }

  const byId = Object.fromEntries(JOBS.map(j => [j.id, j]));
  const out = (parsed.matches || []).map(m => {
    const j = byId[m.job_id];
    if (!j) return null;
    return {
      ...j,
      match_score: typeof m.score === 'number' ? m.score : 0,
      reason: m.reason || ''
    };
  }).filter(Boolean);

  // If model returned nothing usable, fall back to baseline
  if (!out.length) {
    return candidates.slice(0, limit).map(({job, score}) => ({
      ...job,
      match_score: Math.round(score * 100),
      reason: 'Keyword overlap baseline'
    }));
  }

  return out.slice(0, limit);
}

// Keep most recent profile in memory too (works even if SAVE_OUTPUTS=false)
let LAST_PROFILE = null;

// =====================================================

// ---- health ----
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    anthropic_configured: !!anthropic,
    model_candidates: MODEL_CANDIDATES,
    storage: 'memory',
    save_outputs: SAVE_OUTPUTS,
    jobs_loaded: JOBS.length
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
        keywords: ['communication'],
        profile: { about }
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

    // Keep latest in-memory for recommend route
    LAST_PROFILE = response;

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

// ---- NEW: recommend jobs based on last profile ----
app.get('/jobs/recommend', async (req, res) => {
  try {
    // Load profile: prefer latest.json (if saved), else in-memory LAST_PROFILE
    let profile = null;
    const latestPath = path.join(outputsDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      try { profile = JSON.parse(fs.readFileSync(latestPath, 'utf8')); } catch {}
    }
    if (!profile) profile = LAST_PROFILE;

    if (!profile) {
      return res.status(400).json({ error: 'No profile found. Run /process first.' });
    }
    if (!Array.isArray(JOBS) || JOBS.length === 0) {
      return res.json({ profile_terms: [], total_jobs: 0, returned: 0, matches: [] });
    }

    const limit = Math.min(parseInt(req.query.limit || '10', 10), 25);
    const profileTokens = deriveProfileKeywords(profile);
    const pre = prefilterCandidates(profileTokens, 30); // shortlist
    const ranked = await rerankWithClaude(profile, pre, limit);

    res.json({
      profile_terms: profileTokens.slice(0, 30),
      total_jobs: JOBS.length,
      returned: ranked.length,
      matches: ranked
    });
  } catch (e) {
    console.error('Recommend error:', e);
    res.status(500).json({ error: 'Recommendation failed', message: e.message });
  }
});

// ---- start ----
app.listen(PORT, () => {
  console.log(`Prooffolio running on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️ ANTHROPIC_API_KEY not set (using baseline keyword matching only)');
  }
  console.log(`Frontend dir: ${FRONTEND_DIR} ${fs.existsSync(FRONTEND_DIR) ? '(found)' : '(missing)'}`);
  console.log(`Jobs loaded: ${JOBS.length}`);
});
