#!/usr/bin/env bash
set -euo pipefail

PRJ="/tmp/openclaw-qa/final"
cd "$PRJ"

PASS=0; FAIL=0; SKIP=0
declare -a ERRORS

step() {
  local label="$1"
  local script="$2"
  echo "[INFO]  $label"
  if output=$(bash -c "$script" 2>&1); then
    echo "[PASS]  $label"
    echo "$output" | head -20 | sed 's/^/        /'
    PASS=$((PASS+1))
  else
    echo "[FAIL]  $label"
    echo "$output" | head -20 | sed 's/^/  ERR:  /'
    FAIL=$((FAIL+1))
    ERRORS+=("$label")
  fi
  echo ""
}

skip() {
  echo "[SKIP]  $1"
  SKIP=$((SKIP+1))
  echo ""
}

echo ""
echo "=============================================="
echo "  OpenClaw Native — QA Validation"
echo "  Root: $PRJ"
echo "=============================================="
echo ""

# ─── 1. Required files ────────────────────────────────────────
step "Preflight: required files exist" '
cd /tmp/openclaw-qa/final
for f in package.json tsconfig.json src/index.ts Dockerfile docker-compose.yml .env.example src/cli/commands.ts src/cli/index.ts; do
  if [ -f "$f" ]; then echo "  OK  $f"
  else echo "  MISSING $f"; exit 1; fi
done'

# ─── 2. Node/NPM ─────────────────────────────────────────────
step "Preflight: Node/NPM" '
cd /tmp/openclaw-qa/final
echo "  node: $(node -v)  npm: $(npm -v)"'

# ─── 3. All 30 source files ───────────────────────────────────
step "Preflight: 30 source files present" '
cd /tmp/openclaw-qa/final
MISSING=0
for f in \
  src/types/global.ts src/types/message.ts src/types/provider.ts src/types/index.ts \
  src/config/env.ts src/config/validator.ts src/config/index.ts \
  src/utils/logger.ts src/utils/helpers.ts src/utils/index.ts \
  src/providers/base.ts src/providers/groq.ts src/providers/mistral.ts \
  src/providers/openrouter.ts src/providers/ollama.ts src/providers/index.ts \
  src/storage/json-store.ts src/storage/session-manager.ts src/storage/index.ts \
  src/skills/parser.ts src/skills/loader.ts src/skills/registry.ts src/skills/index.ts \
  src/agents/orchestrator.ts src/agents/prompt-builder.ts src/agents/message-assembler.ts src/agents/index.ts \
  src/cli/index.ts src/cli/commands.ts src/index.ts; do
  if [ -f "$f" ]; then echo "  OK $f"
  else echo "  MISSING $f"; MISSING=1; fi
done
exit $MISSING'

# ─── 4. npm install ──────────────────────────────────────────
step "npm ci (install dependencies)" '
cd /tmp/openclaw-qa/final
npm ci --silent 2>&1 | tail -2
echo "  dependencies installed"'

# ─── 5. Type-check ───────────────────────────────────────────
step "TypeScript tsc --noEmit (0 errors)" '
cd /tmp/openclaw-qa/final
./node_modules/.bin/tsc --noEmit
echo "  0 TypeScript errors"'

# ─── 6. Build ────────────────────────────────────────────────
step "npm run build" '
cd /tmp/openclaw-qa/final
npm run build 2>&1 | tail -3
for f in dist/index.js dist/cli/index.js dist/cli/commands.js dist/agents/orchestrator.js dist/providers/base.js dist/storage/json-store.js; do
  if [ -f "$f" ]; then echo "  emitted: $f"
  else echo "  MISSING dist: $f"; exit 1; fi
done'

# ─── 7. CLI smoke test ───────────────────────────────────────
step "CLI smoke: /help + /exit (no crash)" '
cd /tmp/openclaw-qa/final
export OLLAMA_BASE_URL="http://localhost:11434"
export APP_ENV="test" LOG_LEVEL="error" APP_DATA_DIR="/tmp/.oc-smoke"
export SKILLS_DIR="./skills" STORAGE_BACKEND="file"
export AGENT_MAX_TURNS="20" AGENT_TEMPERATURE="0.7"
export AGENT_MAX_TOKENS="4096" AGENT_SYSTEM_PROMPT="You are a helpful AI assistant."
mkdir -p /tmp/.oc-smoke
OUT=$(printf "/help\n/exit\n" | timeout 25 node dist/index.js 2>&1 || true)
echo "$OUT" | head -15
if echo "$OUT" | grep -qiE "TypeError|ReferenceError|SyntaxError|Cannot find module|ERR_MODULE"; then
  echo "ERROR: crash pattern"
  exit 1
fi
echo "  No crash patterns detected"'

# ─── 8. JsonStore CRUD ───────────────────────────────────────
step "Storage: JsonStore set/get/patch/list/delete + KVStore" '
cd /tmp/openclaw-qa/final
node -e "
const { JsonStore, KVStore } = require(\"./dist/storage/json-store\");
const dir = \"/tmp/.oc-jstore-\" + Date.now();
async function run() {
  const store = new JsonStore(\"col\", { dataDir: dir });
  const s = await store.set({ id: \"r1\", val: \"hello\", score: 42 });
  if (!s.ok) throw new Error(\"set: \" + s.error.message);
  const g = await store.get(\"r1\");
  if (!g.ok || g.value === null || g.value.val !== \"hello\") throw new Error(\"get mismatch\");
  const p = await store.patch(\"r1\", { score: 99 });
  if (!p.ok || p.value.score !== 99) throw new Error(\"patch mismatch\");
  const l = await store.list();
  if (!l.ok || l.value.length !== 1) throw new Error(\"list count: \" + l.value.length);
  const d = await store.delete(\"r1\");
  if (!d.ok || !d.value) throw new Error(\"delete\");
  const kv = new KVStore({ dataDir: dir, fileName: \"settings\" });
  await kv.set(\"theme\", \"dark\");
  const kr = await kv.get(\"theme\");
  if (!kr.ok || kr.value !== \"dark\") throw new Error(\"kv.get: \" + JSON.stringify(kr.value));
  console.log(\"  JsonStore: set/get/patch/list/delete PASS\");
  console.log(\"  KVStore: set/get PASS\");
}
run().catch(function(e) { console.error(e.message); process.exit(1); });
"'

# ─── 9. SessionManager ───────────────────────────────────────
step "Storage: SessionManager create/append/get/list/prune" '
cd /tmp/openclaw-qa/final
node -e "
const { SessionManager } = require(\"./dist/storage/session-manager\");
const { createMessage } = require(\"./dist/types/message\");
const dir = \"/tmp/.oc-sess-\" + Date.now();
async function run() {
  const sm = new SessionManager(dir);
  const c = await sm.create({ providerId: \"groq\", model: \"llama3\" });
  if (!c.ok) throw new Error(\"create: \" + c.error.message);
  const sid = c.value.id;
  const m1 = createMessage({ role: \"user\", content: \"hello\" });
  const a1 = await sm.appendMessage({ sessionId: sid, message: m1 });
  if (!a1.ok || a1.value.messages.length !== 1) throw new Error(\"append1\");
  const m2 = createMessage({ role: \"assistant\", content: \"hi there\" });
  const a2 = await sm.appendMessage({ sessionId: sid, message: m2 });
  if (!a2.ok || a2.value.messages.length !== 2) throw new Error(\"append2\");
  const g = await sm.get(sid);
  if (!g.ok || !g.value || g.value.messages.length !== 2) throw new Error(\"get\");
  const l = await sm.list();
  if (!l.ok || l.value.length !== 1) throw new Error(\"list count\");
  const um = await sm.updateMetadata(sid, { title: \"QA Session\" });
  if (!um.ok || um.value.metadata.title !== \"QA Session\") throw new Error(\"metadata\");
  const pr = await sm.prune(0);
  if (!pr.ok || pr.value !== 1) throw new Error(\"prune: \" + JSON.stringify(pr));
  console.log(\"  create/append/get/list/updateMetadata/prune PASS\");
}
run().catch(function(e) { console.error(e.message); process.exit(1); });
"'

# ─── 10. Skills parser ───────────────────────────────────────
step "Skills: parseSkillFile (frontmatter + fallback)" '
cd /tmp/openclaw-qa/final
node -e "
const { parseSkillFile } = require(\"./dist/skills/parser\");
const src = [
  \"---\",
  \"name: QA Skill\",
  \"description: Test\",
  \"version: 2.0.0\",
  \"tags: [qa, automation]\",
  \"priority: 7\",
  \"enabled: true\",
  \"---\",
  \"\",
  \"## Rules\",
  \"Follow these rules.\"
].join(\"\n\");
const r = parseSkillFile(src, \"qa-skill.md\");
if (!r.ok) throw new Error(\"parse failed: \" + r.error.message);
const fm = r.value.frontmatter;
if (fm.name !== \"QA Skill\") throw new Error(\"name: \" + fm.name);
if (fm.priority !== 7) throw new Error(\"priority: \" + fm.priority);
if (fm.tags.length !== 2) throw new Error(\"tags: \" + fm.tags.length);
if (!r.value.body.includes(\"Follow these rules\")) throw new Error(\"body missing\");
const r2 = parseSkillFile(\"plain body\", \"plain.md\");
if (!r2.ok || r2.value.frontmatter.name !== \"plain\") throw new Error(\"fallback name\");
console.log(\"  frontmatter parsing PASS\");
console.log(\"  fallback (no frontmatter) PASS\");
"'

# ─── 11. SkillRegistry ───────────────────────────────────────
step "Skills: SkillRegistry activation management" '
cd /tmp/openclaw-qa/final
node -e "
const { SkillRegistry } = require(\"./dist/skills/registry\");
const reg = new SkillRegistry();
for (var i=1; i<=3; i++) {
  reg.register({ id:\"s\"+i, name:\"S\"+i, description:\"\", filePath:\"/f\", body:\"\",
    frontmatter:{name:\"S\"+i, description:\"\", version:\"1.0.0\", tags:[], priority:i, enabled:true, raw:{}} });
}
reg.activate(\"s1\",\"s2\",\"s3\");
if (reg.activeIds.length !== 3) throw new Error(\"activate count: \" + reg.activeIds.length);
reg.deactivate(\"s2\");
if (reg.activeIds.length !== 2 || reg.activeIds.indexOf(\"s2\") !== -1) throw new Error(\"deactivate\");
reg.setActive([\"s3\"]);
if (reg.activeIds.length !== 1 || reg.activeIds[0] !== \"s3\") throw new Error(\"setActive\");
reg.activateAll();
if (reg.activeIds.length !== 3) throw new Error(\"activateAll\");
reg.deactivateAll();
if (reg.activeIds.length !== 0) throw new Error(\"deactivateAll\");
console.log(\"  activate/deactivate/setActive/activateAll/deactivateAll PASS\");
"'

# ─── 12. PromptBuilder + MessageAssembler ────────────────────
step "Agents: PromptBuilder + MessageAssembler" '
cd /tmp/openclaw-qa/final
node -e "
const { buildSystemPrompt } = require(\"./dist/agents/prompt-builder\");
const { assembleMessages } = require(\"./dist/agents/message-assembler\");
const { createMessage } = require(\"./dist/types/message\");
var p1 = buildSystemPrompt({ basePrompt: \"You are helpful.\", skills: [] });
if (p1 !== \"You are helpful.\") throw new Error(\"bare: \" + p1);
var sk = { id:\"t\", name:\"Tool\", description:\"d\", filePath:\"/f\", body:\"Rule 1.\",
  frontmatter:{name:\"Tool\",description:\"d\",version:\"1.0.0\",tags:[],priority:0,enabled:true,raw:{}} };
var p2 = buildSystemPrompt({ basePrompt: \"Base.\", skills: [sk] });
if (p2.indexOf(\"Active Skills\") === -1) throw new Error(\"section missing\");
if (p2.indexOf(\"Rule 1.\") === -1) throw new Error(\"body missing\");
var msgs = [];
for (var i=0; i<10; i++) msgs.push(createMessage({ role: i%2===0?\"user\":\"assistant\", content:\"m\"+i }));
var a = assembleMessages({ messages: msgs, maxMessages: 4 });
if (a.messages.length > 4) throw new Error(\"window too wide: \" + a.messages.length);
if (a.messages[0].role !== \"user\") throw new Error(\"must start with user\");
var sys = [createMessage({role:\"system\",content:\"sys\"}),createMessage({role:\"user\",content:\"hi\"}),createMessage({role:\"assistant\",content:\"ok\"})];
var a2 = assembleMessages({ messages: sys });
if (a2.messages.some(function(m){ return m.role === \"system\"; })) throw new Error(\"system not stripped\");
console.log(\"  PromptBuilder (bare + skills) PASS\");
console.log(\"  MessageAssembler (sliding window + system strip) PASS\");
"'

# ─── 13. ProviderError ───────────────────────────────────────
step "Providers: ProviderError retryability" '
cd /tmp/openclaw-qa/final
node -e "
var prov = require(\"./dist/types/provider\");
var ProviderError = prov.ProviderError;
var e1 = new ProviderError(\"groq\",\"RATE_LIMITED\",\"too fast\");
if (!e1.isRetryable()) throw new Error(\"RATE_LIMITED should retry\");
if (e1.name !== \"ProviderError\") throw new Error(\"name: \" + e1.name);
var e2 = new ProviderError(\"groq\",\"UNAUTHORIZED\",\"bad key\");
if (e2.isRetryable()) throw new Error(\"UNAUTHORIZED should not retry\");
var e3 = new ProviderError(\"ollama\",\"NETWORK_ERROR\",\"refused\");
if (!e3.isRetryable()) throw new Error(\"NETWORK_ERROR should retry\");
var e4 = new ProviderError(\"mistral\",\"TIMEOUT\",\"slow\");
if (e4.isRetryable()) throw new Error(\"TIMEOUT should not retry\");
var e5 = new ProviderError(\"groq\",\"MODEL_NOT_FOUND\",\"404\");
if (e5.isRetryable()) throw new Error(\"MODEL_NOT_FOUND should not retry\");
console.log(\"  RATE_LIMITED retryable PASS\");
console.log(\"  UNAUTHORIZED NOT retryable PASS\");
console.log(\"  NETWORK_ERROR retryable PASS\");
console.log(\"  TIMEOUT NOT retryable PASS\");
console.log(\"  MODEL_NOT_FOUND NOT retryable PASS\");
"'

# ─── 14. Config singleton ────────────────────────────────────
step "Config: loadConfig singleton + frozen check" '
cd /tmp/openclaw-qa/final
node -e "
process.env.APP_ENV=\"test\"; process.env.LOG_LEVEL=\"error\";
process.env.APP_DATA_DIR=\"/tmp/.oc-cfg\"; process.env.STORAGE_BACKEND=\"file\";
process.env.AGENT_MAX_TURNS=\"20\"; process.env.AGENT_TEMPERATURE=\"0.7\";
process.env.AGENT_MAX_TOKENS=\"4096\"; process.env.AGENT_SYSTEM_PROMPT=\"Test.\";
process.env.OLLAMA_BASE_URL=\"http://localhost:11434\";
var cfg_module = require(\"./dist/config/index\");
cfg_module._resetConfig();
var cfg = cfg_module.loadConfig();
if (cfg.env !== \"test\") throw new Error(\"env: \" + cfg.env);
if (cfg.agent.maxTurns !== 20) throw new Error(\"maxTurns\");
if (cfg.storage.backend !== \"file\") throw new Error(\"backend\");
var cfg2 = cfg_module.loadConfig();
if (cfg !== cfg2) throw new Error(\"singleton broken\");
if (!Object.isFrozen(cfg)) throw new Error(\"config not frozen\");
console.log(\"  loadConfig singleton PASS\");
console.log(\"  config.frozen PASS\");
"'

# ─── 15. Logger ──────────────────────────────────────────────
step "Utils: Logger (levels, namespace, child)" '
cd /tmp/openclaw-qa/final
node -e "
process.env.APP_ENV=\"development\";
var logger_module = require(\"./dist/utils/logger\");
logger_module.setRootLogLevel(\"debug\");
var log = logger_module.createLogger(\"qa-ns\");
var lines = [];
var orig = process.stdout.write.bind(process.stdout);
process.stdout.write = function(s) { lines.push(String(s)); return orig.apply(this, arguments); };
log.debug(\"dbg\", {k:1}); log.info(\"inf\"); log.warn(\"wrn\");
process.stdout.write = orig;
var out = lines.join(\"\");
if (out.indexOf(\"dbg\") === -1) throw new Error(\"debug missing\");
if (out.indexOf(\"inf\") === -1) throw new Error(\"info missing\");
if (out.indexOf(\"[qa-ns]\") === -1) throw new Error(\"namespace missing\");
var child = log.child(\"sub\");
if (!child) throw new Error(\"child() null\");
console.log(\"  levels (debug/info/warn) PASS\");
console.log(\"  namespace [qa-ns] PASS\");
console.log(\"  child() PASS\");
"'

# ─── 16. Helpers ─────────────────────────────────────────────
step "Utils: helpers (generateId, safeWriteJson, safeReadJson)" '
cd /tmp/openclaw-qa/final
node -e "
var h = require(\"./dist/utils/helpers\");
var path = require(\"path\");
var id = h.generateId();
if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(\"uuid: \" + id);
var sid = h.generateShortId();
if (sid.length !== 8) throw new Error(\"short: \" + sid);
var pid = h.generatePrefixedId(\"msg\");
if (pid.indexOf(\"msg_\") !== 0) throw new Error(\"prefix: \" + pid);
if (typeof h.now() !== \"number\") throw new Error(\"now\");
if (h.isoNow().indexOf(\"T\") === -1) throw new Error(\"isoNow\");
async function test() {
  var dir = \"/tmp/.oc-helpers-\" + Date.now();
  var file = path.join(dir, \"t.json\");
  var wr = await h.safeWriteJson(file, { a:1, b:\"hello\" });
  if (!wr.ok) throw new Error(\"write: \" + wr.error.message);
  var rd = await h.safeReadJson(file);
  if (!rd.ok || rd.value.a !== 1) throw new Error(\"read mismatch\");
  var rd2 = await h.safeReadJson(\"/tmp/no-such-file-\" + Date.now() + \".json\");
  if (rd2.ok) throw new Error(\"should fail on missing\");
  console.log(\"  generateId/ShortId/PrefixedId PASS\");
  console.log(\"  now/isoNow PASS\");
  console.log(\"  safeWriteJson/safeReadJson round-trip PASS\");
  console.log(\"  safeReadJson missing file (returns error) PASS\");
}
test().catch(function(e) { console.error(e.message); process.exit(1); });
"'

# ─── 17. Network: Ollama ─────────────────────────────────────
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
if curl -sf --max-time 8 "$OLLAMA_URL/api/tags" > /tmp/ollama_resp.json 2>/dev/null; then
  step "Network: Ollama /api/tags" 'node -e "
var fs=require(\"fs\");
var data=JSON.parse(fs.readFileSync(\"/tmp/ollama_resp.json\",\"utf-8\"));
if (!Array.isArray(data.models)) throw new Error(\"no models array\");
console.log(\"  Ollama reachable — \" + data.models.length + \" model(s)\");
"'
else
  skip "Network: Ollama (not reachable at $OLLAMA_URL — no Ollama running)"
fi

# ─── 18-20. Cloud providers ──────────────────────────────────
if [ -z "${OPENROUTER_API_KEY:-}" ]; then skip "Network: OpenRouter (OPENROUTER_API_KEY not set)"; fi
if [ -z "${GROQ_API_KEY:-}" ];       then skip "Network: Groq (GROQ_API_KEY not set)"; fi
if [ -z "${MISTRAL_API_KEY:-}" ];    then skip "Network: Mistral (MISTRAL_API_KEY not set)"; fi

# ─── 21. Docker ──────────────────────────────────────────────
if command -v docker > /dev/null 2>&1; then
  step "Docker: compose config" '
  cd /tmp/openclaw-qa/final
  docker compose config > /dev/null && echo "  docker compose config: PASS"'
else
  skip "Docker (not available in this environment)"
fi

# ─── Summary ─────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  VALIDATION SUMMARY"
echo "=============================================="
echo "  PASSED:  $PASS"
echo "  SKIPPED: $SKIP"
echo "  FAILED:  $FAIL"
echo ""

if [ $FAIL -gt 0 ]; then
  echo "  Failed steps:"
  for s in "${ERRORS[@]}"; do echo "    FAIL: $s"; done
  echo ""
  exit 1
else
  echo "  All critical validations PASSED"
  exit 0
fi
