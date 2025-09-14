// server.js
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

// serve saved outputs
app.use('/outputs', express.static(outputsDir));
app.get('/outputs/list', async (_req, res) => {
  try {
    const files = (await fsp.readdir(outputsDir)).filter(f => f.endsWith('.json')).sort();
    res.json({ files });
  } catch (e) {
    res.json({ files: [], error: e.message });
  }
});

// ---- serve frontend at "/" (optional) ----
const FRONTEND_DIR = path.join(__dirname, '../frontend');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get('/', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
} else {
  console.warn('⚠️ Frontend directory not found at:', FRONTEND_DIR);
}

// ---- uploads: resume (optional), papers[] (optional) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// ---- anthropic client ----
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

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
        max_tokens: 1900,
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

function createChunksFromText(text, artifactId, maxChunks = 6, maxChars = 3200) {
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
function norm(s=''){ return s.trim().toLowerCase(); }
function mergeSkills(base=[], incoming=[]) {
  const map = new Map(base.map(s => [norm(s.name), { ...s, evidence: Array.isArray(s.evidence)? s.evidence.slice(0,3) : [] }]));
  for (const s of (incoming||[])) {
    const key = norm(s.name);
    const ev = Array.isArray(s.evidence) ? s.evidence : [];
    if (map.has(key)) {
      const cur = map.get(key);
      const curRank = LEVEL_RANK[cur.level] || 0;
      const incRank = LEVEL_RANK[s.level] || 0;
      const level = incRank > curRank ? s.level : cur.level;
      const mergedEv = [];
      const seen = new Set();
      for (const e of [...cur.evidence, ...ev]) {
        const snip = (e?.snippet||'').slice(0,240);
        const id = `${e?.artifact_id||''}|${snip}`;
        if (!seen.has(id)) { seen.add(id); mergedEv.push({ artifact_id: e.artifact_id, snippet: snip }); }
        if (mergedEv.length >= 3) break;
      }
      map.set(key, { ...cur, level, evidence: mergedEv });
    } else {
      map.set(key, { ...s, evidence: ev.slice(0,3) });
    }
  }
  return [...map.values()].slice(0, 120);
}

function uniqStrings(arr=[]) {
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    const k = norm(String(s||''));
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

// Parse "fill in the box" values (comma/semicolon separated or repeated fields)
function splitList(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.flatMap(x => splitList(x));
  }
  return String(v)
    .split(/[;,]/)
    .map(x => x.trim())
    .filter(Boolean);
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

function deriveSkillTokens(profile) {
  const words = [];
  (profile.skills || []).forEach(s => words.push(s.name, s.level));
  (profile.projects || []).forEach(p => {
    words.push(p.title, p.summary);
    (p.methods || []).forEach(m => words.push(m));
    (p.tech_stack || []).forEach(t => words.push(t));
    (p.outcomes || []).forEach(o => words.push(o));
  });
  (profile.artifacts || []).forEach(a => words.push(a.title, a.type, a.text_excerpt));
  if (Array.isArray(profile.keywords)) words.push(...profile.keywords);
  const toks = tokenize(words.join(' '));
  return uniq(toks).slice(0, 200);
}

function derivePreferenceTokens(profile) {
  const pref = (profile.profile && profile.profile.preferences) || {};
  const bag = [];
  if (profile.profile?.about) bag.push(profile.profile.about);
  if (Array.isArray(profile.profile?.interests)) bag.push(...profile.profile.interests);
  if (pref.summary) bag.push(pref.summary);
  const fields = ['goals','interests','industries','role_types','locations','work_modes','company_size','constraints'];
  fields.forEach(f => { if (Array.isArray(pref[f])) bag.push(...pref[f]); });
  const toks = tokenize(bag.join(' ') + ' ' + (profile.profile?.about||'')); // keep about in the mix
  return uniq(toks).slice(0, 200);
}

function jobKeywords(job) {
  const base = []
    .concat(job.title, job.company, job.location, job.description || '')
    .concat(job.keywords || []);
  return uniq(tokenize(base.join(' ')));
}

function prefilterCandidates(skillTokens, prefTokens, topN = 40) {
  const sset = new Set(skillTokens);
  const pset = new Set(prefTokens);
  return JOBS.map(j => {
    const jset = new Set(jobKeywords(j));
    const skill = jaccard(sset, jset);
    const pref  = jaccard(pset, jset);
    const composite = (pref ? 0.7*pref : 0) + (skill ? 0.3*skill : 0);
    return { job: j, baseline_skill: Math.round(skill*100), baseline_preference: Math.round(pref*100), composite };
  })
  .sort((a,b) => b.composite - a.composite)
  .slice(0, topN);
}

async function rerankWithClaude(profile, candidates, limit = 10) {
  const hasPrefs = derivePreferenceTokens(profile).length > 0;

  if (!anthropic) {
    return candidates
      .slice(0, limit)
      .map(({job, baseline_skill, baseline_preference}) => {
        const preference = baseline_preference;
        const skill = baseline_skill;
        const overall = hasPrefs
          ? Math.round(0.7*preference + 0.3*skill)
          : skill;
        return {
          ...job,
          scores: { preference, skill, overall },
          reasons: {
            preference: hasPrefs ? 'Keyword/interest overlap baseline' : 'No stated preferences; neutral',
            skill: 'Skill keyword overlap baseline'
          }
        };
      });
  }

  const compactCands = candidates.map(({job, baseline_skill, baseline_preference}) => ({
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    keywords: job.keywords,
    description: (job.description || '').slice(0, 600),
    baseline: { preference: baseline_preference, skill: baseline_skill }
  }));

  const profileExcerpt = {
    preferences: profile.profile?.preferences || {},
    interests: profile.profile?.interests || [],
    about: profile.profile?.about || '',
    skills: (profile.skills || []).slice(0, 30),
    projects: (profile.projects || []).slice(0, 15),
    keywords: profile.keywords || []
  };

  const systemPrompt = `You are a matching engine that prioritizes user preferences/goals first, then skills.
Return ONLY strict JSON:
{
  "matches": [
    {
      "job_id": "...",
      "scores": { "preference": 0-100, "skill": 0-100, "overall": 0-100 },
      "reasons": { "preference": "≤140 chars", "skill": "≤140 chars" }
    }
  ]
}
Rules:
- Use user "preferences" (summary, goals, interests, industries, locations, work_modes, company_size, constraints) as the PRIMARY signal.
- Use skills/projects/keywords as the SECONDARY signal.
- Start from provided baselines (baseline.preference & baseline.skill), then adjust with judgment.
- If the user has NO preferences, focus on skills (preference can be neutral or low).
- Overall should be ~ 0.7 * preference + 0.3 * skill. If a job has outstanding skill fit but weaker preference fit, you may raise overall by up to +10 to surface it lower in the list.
- Reasons must be concise and factual (mention specific prefs/skills that matched).
- Output at most ${limit} items, ordered by overall descending.`;

  const msg = await callClaude(systemPrompt, { profile: profileExcerpt, candidates: compactCands, limit });
  const txt = msg?.content?.[0]?.text || '{}';
  let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { matches: [] }; }

  const byId = Object.fromEntries(JOBS.map(j => [j.id, j]));
  const out = (parsed.matches || []).map(m => {
    const j = byId[m.job_id];
    if (!j) return null;
    const preference = Math.max(0, Math.min(100, Number(m?.scores?.preference||0)));
    const skill      = Math.max(0, Math.min(100, Number(m?.scores?.skill||0)));
    const overall    = Math.max(0, Math.min(100, Number(m?.scores?.overall||Math.round(0.7*preference+0.3*skill))));
    return {
      ...j,
      scores: { preference, skill, overall },
      reasons: { preference: m?.reasons?.preference || '', skill: m?.reasons?.skill || '' }
    };
  }).filter(Boolean);

  if (!out.length) {
    return candidates.slice(0, limit).map(({job, baseline_skill, baseline_preference}) => {
      const preference = baseline_preference;
      const skill = baseline_skill;
      const overall = Math.round(0.7*preference + 0.3*skill);
      return { ...job, scores: { preference, skill, overall }, reasons: { preference: 'Baseline', skill: 'Baseline' } };
    });
  }
  return out.slice(0, limit);
}

// ---------- extraction prompts ----------
const RESUME_PROMPT = `Extract ONLY verifiable information from a resume and a free-text "goals & interests" field.
Return STRICT JSON:
{
  "profile": {
    "about": "1–2 sentences using ONLY user-provided text (or empty)",
    "interests": ["k1","k2","k3"],
    "preferences": {
      "summary": "short summary of job-search goals & interests",
      "goals": ["goal1","goal2"],
      "interests": ["topic1","topic2"],
      "industries": ["industry1","industry2"],
      "role_types": ["role1","role2"],
      "locations": ["city/region1","city/region2"],
      "work_modes": ["remote","hybrid","onsite"],
      "company_size": ["startup","mid","enterprise"],
      "constraints": ["visa","timezone","salary hints if user wrote them"]
    }
  },
  "skills":[
    {"name":"...","level":"beginner|intermediate|advanced",
     "evidence":[{"artifact_id":"a1","snippet":"20–40 word VERBATIM quote"}]}
  ],
  "projects":[
    {"title":"...","summary":"one line",
     "evidence":[{"artifact_id":"a1","snippet":"..."}]}
  ],
  "keywords":["normalized","skill","tags"]
}
Rules:
- Be conservative; do not invent prefs or skills. Use the 'goals & interests' text as the main source for preferences.
- Every skill MUST include at least one evidence item with artifact_id "a1".
- Deduplicate; VALID JSON ONLY (no extra text).`;

function paperPromptFor(id) {
  return `Extract ONLY verifiable information from a scholarly/industry paper the user worked on. Return STRICT JSON:
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
   - about: free-text goals & interests (optional)
   - pref_locations: comma/semicolon separated (optional)
   - pref_work_modes: repeated or comma/semicolon separated (optional)
   Requires at least one source (resume or papers).
   ===================================================== */
app.post('/process',
  upload.fields([{ name: 'resume', maxCount: 1 }, { name: 'papers', maxCount: 10 }]),
  async (req, res) => {
    try {
      const about = req.body?.about || ''; // free-text
      const explicitLocations = splitList(req.body?.pref_locations);
      const explicitWorkModes = splitList(req.body?.pref_work_modes);

      const resumeFile = req.files?.resume?.[0];
      const paperFiles = req.files?.papers || [];

      if (!resumeFile && paperFiles.length === 0) {
        return res.status(400).json({ error: 'Please add a resume or at least one paper PDF.' });
      }

      const artifacts = [];
      const perSourceChunks = {}; // id -> chunks

      // Resume (optional) -> a1
      if (resumeFile) {
        const resumeText = await parsePDFBuffer(resumeFile.buffer);
        const a1 = {
          id: 'a1',
          type: 'pdf',
          title: resumeFile.originalname || 'resume.pdf',
          source_url: null,
          text_excerpt: (resumeText || '').slice(0, 3200)
        };
        artifacts.push(a1);
        perSourceChunks[a1.id] = createChunksFromText(resumeText, a1.id, 6, 3200);
      }

      // Papers (optional) -> p1..pN
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
          text_excerpt: (paperText || '').slice(0, 3600)
        };
        artifacts.push(pa);
        perSourceChunks[pid] = createChunksFromText(paperText, pid, 6, 3600);
      }

      // Extract and merge
      let finalSkills = [];
      let finalProjects = [];
      let finalKeywords = [];
      let finalProfile = {
        about: '',
        interests: [],
        preferences: {
          summary: '',
          goals: [],
          interests: [],
          industries: [],
          role_types: [],
          locations: [],
          work_modes: [],
          company_size: [],
          constraints: []
        }
      };

      if (anthropic) {
        if (perSourceChunks['a1']) {
          const r = await extractFromResume(about, perSourceChunks['a1']);
          finalSkills = mergeSkills(finalSkills, r.skills);
          finalProjects = [...finalProjects, ...(r.projects || [])];
          finalKeywords = uniqStrings([...(finalKeywords||[]), ...(r.keywords||[])]);
          if (r.profile) {
            finalProfile.about = r.profile.about || '';
            finalProfile.interests = Array.isArray(r.profile.interests) ? uniqStrings(r.profile.interests) : [];
            finalProfile.preferences = r.profile.preferences || finalProfile.preferences;
          }
        }
        for (const a of artifacts) {
          if (a.id === 'a1') continue;
          const pr = await extractFromPaper(a.id, perSourceChunks[a.id] || []);
          finalSkills = mergeSkills(finalSkills, pr.skills);
          finalProjects = [...finalProjects, ...(pr.projects || [])];
          finalKeywords = uniqStrings([...(finalKeywords||[]), ...(pr.keywords||[])]);
        }
      } else {
        // Fallback: simple stub using "about"
        const firstId = artifacts[0]?.id || 'a1';
        finalSkills = mergeSkills([], [
          { name: 'Communication', level: 'intermediate', evidence: [{ artifact_id: firstId, snippet: 'Presented results to stakeholders and coordinated cross-team deliverables.' }] }
        ]);
        if (about) {
          finalProfile.preferences.summary = about.slice(0, 140);
          finalProfile.interests = uniqStrings(tokenize(about)).slice(0, 5);
        }
        finalKeywords = ['communication'];
      }

      // --------- MERGE EXPLICIT PREFERENCES (priority over inferred) ---------
      if (explicitLocations.length) {
        finalProfile.preferences.locations = uniqStrings([...(finalProfile.preferences.locations||[]), ...explicitLocations]);
      }
      if (explicitWorkModes.length) {
        finalProfile.preferences.work_modes = uniqStrings([...(finalProfile.preferences.work_modes||[]), ...explicitWorkModes.map(norm)]);
      }

      // If we have explicit prefs but no summary, build a short one
      if (!finalProfile.preferences.summary) {
        const parts = [];
        if (finalProfile.preferences.work_modes?.length) parts.push(`${finalProfile.preferences.work_modes.join('/')} work mode`);
        if (finalProfile.preferences.locations?.length) parts.push(`in ${finalProfile.preferences.locations.join(', ')}`);
        finalProfile.preferences.summary = parts.length ? `Prefers ${parts.join(' ')}.` : '';
      }

      const response = {
        session_id: 'profile-with-preferences',
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

// ---- /jobs/recommend: show ALL jobs by default ----
app.get('/jobs/recommend', async (req, res) => {
  try {
    let profile = null;
    const latestPath = path.join(outputsDir, 'latest.json');
    if (fs.existsSync(latestPath)) { try { profile = JSON.parse(fs.readFileSync(latestPath, 'utf8')); } catch {} }
    if (!profile) profile = LAST_PROFILE;

    if (!profile) return res.status(400).json({ error: 'No profile found. Run /process first.' });
    if (!Array.isArray(JOBS) || JOBS.length === 0) {
      return res.json({ profile_terms: [], preference_terms: [], total_jobs: 0, returned: 0, matches: [] });
    }

    const limitParam = String(req.query.limit || 'all').toLowerCase();
    const wantAll = limitParam === 'all';
    const desiredLimit = wantAll ? JOBS.length : Math.min(parseInt(limitParam, 10) || 10, JOBS.length);

    const skillTokens = deriveSkillTokens(profile);
    const prefTokens  = derivePreferenceTokens(profile);

    const preN = wantAll ? JOBS.length : Math.max(40, desiredLimit * 2);
    const pre = prefilterCandidates(skillTokens, prefTokens, preN);

    let ranked;

    if (wantAll) {
      const topForAI = pre.slice(0, Math.min(60, pre.length));
      const aiRankedTop = await rerankWithClaude(profile, topForAI, topForAI.length);

      const rest = pre.slice(topForAI.length).map(({ job, baseline_skill, baseline_preference }) => ({
        ...job,
        scores: {
          preference: baseline_preference,
          skill: baseline_skill,
          overall: Math.round(0.7 * baseline_preference + 0.3 * baseline_skill)
        },
        reasons: { preference: 'Baseline', skill: 'Baseline' }
      }));

      ranked = [...aiRankedTop, ...rest];
    } else {
      ranked = await rerankWithClaude(profile, pre, desiredLimit);
    }

    res.json({
      profile_terms: skillTokens.slice(0, 30),
      preference_terms: prefTokens.slice(0, 30),
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
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠️ ANTHROPIC_API_KEY not set (using baseline only)');
  console.log(`Frontend dir: ${FRONTEND_DIR} ${fs.existsSync(FRONTEND_DIR) ? '(found)' : '(missing)'}`);
  console.log(`Jobs loaded: ${JOBS.length}`);
});
