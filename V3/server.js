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

app.use(cors());
app.use(express.json());

// ---- dirs & flags ----
const uploadsDir = path.join(__dirname, 'uploads'); // clarity
const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

const SAVE_OUTPUTS = String(process.env.SAVE_OUTPUTS).toLowerCase() === 'true';

// saved outputs (handy in browser)
app.use('/outputs', express.static(outputsDir));
app.get('/outputs/list', async (_req, res) => {
  try {
    const files = (await fsp.readdir(outputsDir)).filter(f => f.endsWith('.json')).sort();
    res.json({ files });
  } catch (e) {
    res.json({ files: [], error: e.message });
  }
});

// ---- Serve frontend at "/" ----
const FRONTEND_DIR = path.join(__dirname, '../frontend');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get('/', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
} else {
  console.warn('⚠️ Frontend directory not found at:', FRONTEND_DIR);
}

// ---- multer: resume (optional), papers[] (optional) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// ---- anthropic client ----
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ---- model fallback cycle ----
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
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(userPayload) }]
      });
      return msg;
    } catch (e) {
      const status = e?.response?.status;
      const msg = e?.message || String(e);
      const notFound = status === 404 || /not_found_error/i.test(msg) || /model/i.test(msg);
      if (notFound) { lastErr = e; continue; }
      throw e;
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

// sentence-aware chunking
function createChunksFromText(text, artifactId, maxChunks = 5, maxChars = 2200) {
  const chunks = [];
  const excerpt = (text || '').slice(0, maxChars);
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
  if (buf.length > 120 && chunks.length < maxChunks) chunks.push({ artifact_id: artifactId, text: buf.trim() });
  return chunks.slice(0, maxChunks);
}

// ---------- skill merge/dedupe ----------
const LEVEL_RANK = { beginner: 1, intermediate: 2, advanced: 3 };
function normName(s=''){ return s.trim().toLowerCase(); }
function mergeSkills(base=[], incoming=[]) {
  const map = new Map(base.map(s => [normName(s.name), { ...s, evidence: Array.isArray(s.evidence)? s.evidence.slice(0,3) : [] }]));
  for (const s of (incoming||[])) {
    const key = normName(s.name);
    const ev = Array.isArray(s.evidence) ? s.evidence : [];
    if (map.has(key)) {
      const cur = map.get(key);
      const curRank = LEVEL_RANK[cur.level] || 0;
      const incRank = LEVEL_RANK[s.level] || 0;
      const level = incRank > curRank ? s.level : cur.level;
      // merge up to 3 distinct evidence snippets
      const mergedEv = [];
      const seenSnips = new Set();
      for (const e of [...cur.evidence, ...ev]) {
        const snip = (e?.snippet||'').slice(0,240);
        const id = `${e?.artifact_id||''}|${snip}`;
        if (!seenSnips.has(id)) {
          seenSnips.add(id);
          mergedEv.push({ artifact_id: e.artifact_id, snippet: snip });
        }
        if (mergedEv.length >= 3) break;
      }
      map.set(key, { ...cur, level, evidence: mergedEv });
    } else {
      map.set(key, { ...s, evidence: ev.slice(0,3) });
    }
  }
  return [...map.values()].slice(0, 80);
}

function uniqStrings(arr=[]) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    const k = normName(String(s||''));
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

// =====================================================
//                JOB MATCHING
// =====================================================

const JOBS_PATH = path.join(__dirname, 'jobs', 'jobs.json');
let JOBS = [];
try {
  if (fs.existsSync(JOBS_PATH)) JOBS = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  else console.warn('⚠️ jobs.json not found at', JOBS_PATH);
} catch (e) {
  console.error('Failed to read jobs.json:', e.message);
  JOBS = [];
}

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
function deriveProfileKeywords(profileJson) {
  const words = [];
  (profileJson.skills || []).forEach(s => words.push(s.name, s.level));
  (profileJson.projects || []).forEach(p => {
    words.push(p.title, p.summary);
    (p.methods || []).forEach(m => words.push(m));
    (p.tech_stack || []).forEach(t => words.push(t));
    (p.outcomes || []).forEach(o => words.push(o));
  });
  (profileJson.artifacts || []).forEach(a => words.push(a.title, a.type, a.text_excerpt));
  if (Array.isArray(profileJson.keywords)) words.push(...profileJson.keywords);
  if (Array.isArray(profileJson.profile?.interests)) words.push(...profileJson.profile.interests);
  if (profileJson.profile?.about) words.push(profileJson.profile.about);
  const toks = tokenize(words.join(' '));
  return uniq(toks).slice(0, 120);
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
  }).sort((a,b) => b.score - a.score).slice(0, topN);
}
async function rerankWithClaude(profile, candidates, limit = 10) {
  if (!anthropic) {
    return candidates.slice(0, limit).map(({job, score}) => ({
      ...job, match_score: Math.round(score * 100), reason: 'Keyword overlap baseline'
    }));
  }
  const compactCands = candidates.map(({job, score}) => ({
    id: job.id, title: job.title, company: job.company, location: job.location,
    keywords: job.keywords, description: (job.description || '').slice(0, 500),
    baseline: Math.round(score * 100)
  }));
  const profileExcerpt = {
    skills: (profile.skills || []).slice(0, 30),
    projects: (profile.projects || []).slice(0, 15),
    artifacts: (profile.artifacts || []).slice(0, 8).map(a => ({
      id: a.id || a.title, type: a.type, text_excerpt: (a.text_excerpt || '').slice(0, 240)
    })),
    keywords: profile.keywords || [],
    about: profile.profile?.about || ''
  };
  const systemPrompt = `You are a matching engine. Given a candidate profile and candidate jobs, return ONLY strict JSON:
{ "matches": [ { "job_id": "...", "score": 0-100, "reason": "short" } ] }
Rules:
- Start from provided "baseline" (keyword overlap).
- Adjust for fit/mismatch using profile skills/projects/methods/tech_stack/outcomes.
- Reasons <= 140 chars, concise and factual.
- Return up to ${limit} items.`;
  const msg = await callClaude(systemPrompt, { profile: profileExcerpt, candidates: compactCands, limit });
  const txt = msg?.content?.[0]?.text || '{}';
  let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { matches: [] }; }
  const byId = Object.fromEntries(JOBS.map(j => [j.id, j]));
  const out = (parsed.matches || []).map(m => {
    const j = byId[m.job_id];
    if (!j) return null;
    return { ...j, match_score: typeof m.score === 'number' ? m.score : 0, reason: m.reason || '' };
  }).filter(Boolean);
  if (!out.length) {
    return candidates.slice(0, limit).map(({job, score}) => ({
      ...job, match_score: Math.round(score * 100), reason: 'Keyword overlap baseline'
    }));
  }
  return out.slice(0, limit);
}

// ---------- extraction prompts ----------
const RESUME_PROMPT = `Extract ONLY verifiable information from a resume and short 'about'. Return STRICT JSON:
{
  "profile": {"about":"1–2 sentences using ONLY provided 'about'","interests":["k1","k2","k3"]},
  "skills":[{"name":"...","level":"beginner|intermediate|advanced",
             "evidence":[{"artifact_id":"a1","snippet":"20–40 word VERBATIM quote"}]}],
  "projects":[{"title":"...","summary":"one line",
              "evidence":[{"artifact_id":"a1","snippet":"..."}]}],
  "keywords":["normalized","skill","tags"]
}
Rules:
- No speculation; every skill MUST include evidence with artifact_id "a1".
- Deduplicate skills/keywords; VALID JSON ONLY (no extra text).`;

function paperPromptFor(id) {
  return `Extract ONLY verifiable information from a scholarly/industry paper that the user worked on. Treat it as a real project. Return STRICT JSON:
{
  "skills":[
    {"name":"...","level":"beginner|intermediate|advanced",
     "evidence":[{"artifact_id":"${id}","snippet":"20–40 word VERBATIM quote"}]}
  ],
  "projects":[
    {"title":"...","summary":"one line (what & why)","role":"lead|contributor|author",
     "venue":"conf/journal/company report (if stated)","year":"YYYY or empty",
     "methods":["e.g., CRF","transformers","Monte Carlo"], "tech_stack":["e.g., Python","PyTorch","FastAPI","Rust"],
     "outcomes":["e.g., accuracy 92%","A/B +6%","open-source release"], "links":{"doi":"","url":""},
     "evidence":[{"artifact_id":"${id}","snippet":"..."}]}
  ],
  "keywords":["normalized","tags","methods","domains"]
}
Rules:
- Be conservative but assume authorship/contribution unless contradicted.
- Every skill & project MUST include at least one evidence item with artifact_id "${id}".
- Prefer concrete contributions, methods, datasets, metrics, tools.
- Deduplicate; VALID JSON ONLY (no extra text).`;
}

// ---------- per-source extraction ----------
async function extractFromResume(about, resumeChunks) {
  const payload = { about, artifacts: resumeChunks };
  const msg = await callClaude(RESUME_PROMPT, payload);
  const txt = msg?.content?.[0]?.text || '{}';
  let out; try { out = JSON.parse(txt); } catch { out = {}; }
  return {
    skills: out.skills || [],
    projects: out.projects || [],
    keywords: out.keywords || [],
    profile: out.profile || {}
  };
}

async function extractFromPaper(paperId, paperChunks) {
  const payload = { artifacts: paperChunks };
  const msg = await callClaude(paperPromptFor(paperId), payload);
  const txt = msg?.content?.[0]?.text || '{}';
  let out; try { out = JSON.parse(txt); } catch { out = {}; }
  return {
    skills: out.skills || [],
    projects: out.projects || [],
    keywords: out.keywords || []
  };
}

// latest profile cache
let LAST_PROFILE = null;

// ---- health ----
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    anthropic_configured: !!anthropic,
    save_outputs: SAVE_OUTPUTS,
    jobs_loaded: JOBS.length
  });
});

/* =====================================================
   /process accepts:
   - resume: single PDF (optional)
   - papers: 0..N PDFs (optional; name="papers", multiple)
   Requires at least one source.
   ===================================================== */
app.post('/process',
  upload.fields([{ name: 'resume', maxCount: 1 }, { name: 'papers', maxCount: 10 }]),
  async (req, res) => {
    try {
      const about = req.body?.about || '';
      const resumeFile = req.files?.resume?.[0];
      const paperFiles = req.files?.papers || [];

      if (!resumeFile && paperFiles.length === 0) {
        return res.status(400).json({ error: 'Provide a resume or at least one paper PDF.' });
      }

      const artifacts = [];
      const perSourceChunks = {}; // id -> chunks

      // Resume (optional) -> artifact a1
      if (resumeFile) {
        const resumeText = await parsePDFBuffer(resumeFile.buffer);
        const a1 = {
          id: 'a1',
          type: 'pdf',
          title: resumeFile.originalname || 'resume.pdf',
          source_url: null,
          text_excerpt: (resumeText || '').slice(0, 2400)
        };
        artifacts.push(a1);
        perSourceChunks[a1.id] = createChunksFromText(resumeText, a1.id, 5, 2400);
      }

      // Papers (optional) -> artifacts p1..pN (stronger extraction: more chunks)
      let paperIndex = 0;
      for (const pf of paperFiles) {
        paperIndex += 1;
        const pid = `p${paperIndex}`;
        const paperText = await parsePDFBuffer(pf.buffer);
        const pa = {
          id: pid,
          type: 'pdf',
          title: pf.originalname || `paper_${paperIndex}.pdf`,
          source_url: null,
          text_excerpt: (paperText || '').slice(0, 3000)
        };
        artifacts.push(pa);
        // stronger: up to 6 chunks / more chars per paper
        perSourceChunks[pid] = createChunksFromText(paperText, pid, 6, 3600);
      }

      let finalSkills = [];
      let finalProjects = [];
      let finalKeywords = [];
      let finalProfile = {};

      if (anthropic) {
        // Extract per source and merge
        if (perSourceChunks['a1']) {
          const r = await extractFromResume(about, perSourceChunks['a1']);
          finalSkills = mergeSkills(finalSkills, r.skills);
          finalProjects = [...finalProjects, ...(r.projects || [])];
          finalKeywords = uniqStrings([...(finalKeywords||[]), ...(r.keywords||[])]);
          finalProfile = { ...(r.profile || {}) };
        }

        for (const a of artifacts) {
          if (a.id === 'a1') continue;
          const pr = await extractFromPaper(a.id, perSourceChunks[a.id] || []);
          finalSkills = mergeSkills(finalSkills, pr.skills);
          finalProjects = [...finalProjects, ...(pr.projects || [])];
          finalKeywords = uniqStrings([...(finalKeywords||[]), ...(pr.keywords||[])]);
        }
      } else {
        // Fallback
        const firstId = artifacts[0]?.id || 'a1';
        finalSkills = mergeSkills([], [
          { name: 'Communication', level: 'intermediate', evidence: [{ artifact_id: firstId, snippet: 'Presented results to stakeholders and coordinated cross-team deliverables.' }] }
        ]);
        finalKeywords = ['communication'];
      }

      const response = {
        session_id: 'profile-multi-source-strong-papers',
        artifacts,
        skills: finalSkills,
        projects: finalProjects,
        keywords: finalKeywords,
        profile: finalProfile,
        counts: { resume: resumeFile ? 1 : 0, papers: paperFiles.length }
      };

      LAST_PROFILE = response;

      if (SAVE_OUTPUTS) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outPath = path.join(outputsDir, `profile_${stamp}.json`);
        await fsp.writeFile(outPath, JSON.stringify(response, null, 2));
        await fsp.writeFile(path.join(outputsDir, 'latest.json'), JSON.stringify(response, null, 2));
        for (const a of artifacts) {
          await fsp.writeFile(path.join(outputsDir, `artifact_${a.id}.txt`), a.text_excerpt || '');
        }
        console.log('💾 Saved output to:', outPath);
      }

      return res.json(response);
    } catch (e) {
      console.error('Process error:', e);
      return res.status(500).json({ error: 'Processing failed', message: e.message });
    }
  }
);

// ---- recommendations ----
app.get('/jobs/recommend', async (req, res) => {
  try {
    let profile = null;
    const latestPath = path.join(outputsDir, 'latest.json');
    if (fs.existsSync(latestPath)) { try { profile = JSON.parse(fs.readFileSync(latestPath, 'utf8')); } catch {} }
    if (!profile) profile = LAST_PROFILE;

    if (!profile) return res.status(400).json({ error: 'No profile found. Run /process first.' });
    if (!Array.isArray(JOBS) || JOBS.length === 0) {
      return res.json({ profile_terms: [], total_jobs: 0, returned: 0, matches: [] });
    }

    const limit = Math.min(parseInt(req.query.limit || '10', 10), 25);
    const profileTokens = deriveProfileKeywords(profile);
    const pre = prefilterCandidates(profileTokens, 30);
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
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠️ ANTHROPIC_API_KEY not set (using baseline keyword matching only)');
  console.log(`Frontend dir: ${FRONTEND_DIR} ${fs.existsSync(FRONTEND_DIR) ? '(found)' : '(missing)'}`);
  console.log(`Jobs loaded: ${JOBS.length}`);
});
