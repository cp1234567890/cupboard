/* Cupboard — Dinners: weekly dinner planner.
 *
 * Data lives in two files next to Ingredients.txt:
 *   Dinners.json    — the dinner library plus planning rules (staples, avoid list, packs)
 *   MealPlans.json  — one entry per week (Monday date), seven days each
 *
 * The first half of this file is plain logic (reading Claude replies, generating
 * weeks) with no DOM access, so it can be tested on its own. The second half is the
 * Dinners tab UI and its hook into the Shopping tab. It relies on helpers defined in
 * index.html (escapeHtml, convertQty, items, sameIngredient, …), all of which are
 * only called after the page has loaded.
 */

const DN_DINNERS_PATH = "Dinners.json";
const DN_PLANS_PATH = "MealPlans.json";
const DN_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DN_DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DN_MEASURE = {g: 1, kg: 1000, ml: 1, l: 1000, tsp: 5, tbsp: 15, cups: 250};

const DN_DEFAULT_RULES = {
  officeDays: [2, 3],          // Wednesday, Thursday
  maxWeeknightMins: 30,
  packs: {
    "chicken thigh": {size: 4, label: "pack of 4"},
    "salmon fillet": {size: 2, label: "pack of 2"},
    "pak choi": {size: 2, label: "pack of 2"}
  },
  avoid: ["cheese", "parmesan", "mozzarella", "cheddar", "feta", "halloumi", "paneer",
    "prawn", "shrimp", "egg", "omelette", "noodle", "greek yogurt", "fish sauce",
    "oyster sauce", "smoked paprika"],
  staples: ["olive oil", "sunflower oil", "sesame oil", "soy sauce", "honey", "salt",
    "chilli flakes", "paprika", "cumin", "turmeric", "garam masala", "ground coriander",
    "ground ginger", "garlic powder", "onion powder", "mixed herbs", "sesame seeds",
    "rice vinegar", "basmati rice", "brown rice", "quinoa", "red lentils", "pasta",
    "spaghetti", "vegetable stock", "tomato puree", "hoisin sauce", "miso paste",
    "gochujang paste"]
};

/* =========================================================================
 *  Text helpers
 * ========================================================================= */

function dnNorm(s){
  return String(s || "").toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function dnSingularWord(w){
  if(/(ss|us|is)$/.test(w)) return w;
  if(/oes$/.test(w)) return w.slice(0, -2);        // tomatoes, potatoes
  if(/ies$/.test(w)) return w.slice(0, -3) + "y";  // berries
  if(/(ches|shes)$/.test(w)) return w.slice(0, -2);
  if(/s$/.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
}

// "Chicken Thighs" -> "chicken thigh". Only the last word changes.
function dnSingular(name){
  const words = String(name || "").trim().toLowerCase().split(/\s+/);
  if(!words[0]) return "";
  words[words.length - 1] = dnSingularWord(words[words.length - 1]);
  return words.join(" ");
}

function dnTitle(s){
  return String(s || "").trim().replace(/\b([a-z])/g, c => c.toUpperCase());
}

// Strip bullets, markdown emphasis, heading marks and quote markers from a line.
function dnClean(line){
  let s = String(line || "").replace(/ /g, " ").trim();
  s = s.replace(/^>+\s*/, "");
  s = s.replace(/^#{1,6}\s*/, "");
  s = s.replace(/^[•●▪◦·*–-]\s+/, "");
  s = s.replace(/\*\*|__/g, "");
  s = s.replace(/^\*(.+)\*$/, "$1").replace(/^_(.+)_$/, "$1");
  return s.trim();
}

function dnParseNum(t){
  const map = {"½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3};
  if(t in map) return map[t];
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if(frac) return Number(frac[1]) / Number(frac[2]);
  const mixed = t.match(/^(\d+)\s*([½¼¾])$/);
  if(mixed) return Number(mixed[1]) + map[mixed[2]];
  return parseFloat(t);
}

// Split on commas that aren't inside brackets.
function dnSplitTop(s){
  const out = [];
  let depth = 0, cur = "";
  for(const ch of s){
    if(ch === "(") depth++;
    if(ch === ")") depth = Math.max(0, depth - 1);
    if(ch === "," && depth === 0){ out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/* =========================================================================
 *  Ingredient lines
 * ========================================================================= */

const DN_UNIT_WORDS = {
  g: "g", gram: "g", grams: "g", kg: "kg", ml: "ml", l: "l", litre: "l", litres: "l",
  liter: "l", liters: "l", tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", cup: "cups", cups: "cups",
  tin: "tin", tins: "tin", can: "tin", cans: "tin", clove: "clove", cloves: "clove",
  handful: "handful", handfuls: "handful", pack: "pack", packs: "pack",
  packet: "pack", packets: "pack", bunch: "bunch", bunches: "bunch",
  pinch: "pinch", pinches: "pinch", slice: "slice", slices: "slice",
  squeeze: "squeeze", squeezes: "squeeze", drop: "drop", drops: "drop"
};
const DN_UNIT_RE = new RegExp("^(" + Object.keys(DN_UNIT_WORDS)
  .sort((a, b) => b.length - a.length).join("|") + ")\\b\\.?\\s*(?:of\\s+)?", "i");

function dnParseOneIngredient(text){
  const notes = [];
  let s = text.replace(/\(([^()]*)\)/g, (_, t) => { if(t.trim()) notes.push(t.trim()); return " "; });
  const comma = s.indexOf(",");
  if(comma >= 0){
    const rest = s.slice(comma + 1).trim();
    if(rest) notes.unshift(rest);
    s = s.slice(0, comma);
  }
  s = s.replace(/\s+/g, " ").trim();
  if(!s) return null;

  let qty = null;
  let unit = "";
  let m = s.match(/^(\d+\s*[½¼¾]|\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|[½¼¾⅓⅔])\s*/);
  if(m){
    qty = dnParseNum(m[1].replace(/\s+/g, ""));
    s = s.slice(m[0].length);
  }else if((m = s.match(/^half\s+(?:an?\s+)?/i))){
    qty = 0.5; s = s.slice(m[0].length);
  }else if((m = s.match(/^(?:a few|a couple of|a couple|few)\s+/i))){
    qty = 3; s = s.slice(m[0].length);
  }else if((m = s.match(/^(?:an?|one)\s+/i))){
    qty = 1; s = s.slice(m[0].length);
  }else if((m = s.match(/^two\s+/i))){
    qty = 2; s = s.slice(m[0].length);
  }

  s = s.replace(/^(?:large|small|medium|big|generous|heaped|level)\s+/i, "");
  m = s.match(DN_UNIT_RE);
  if(m){
    unit = DN_UNIT_WORDS[m[1].toLowerCase()];
    s = s.slice(m[0].length);
    if(qty === null) qty = 1;      // "Handful of lettuce"
  }

  let name = s.replace(/^of\s+/i, "").split(/\s+or\s+/i)[0];
  name = name.replace(/^(?:large|small|medium|big)\s+/i, "").trim().toLowerCase();

  // "2 garlic cloves" -> 2 clove garlic
  const trailing = name.match(/^(.+?)\s+(cloves?|tins?|cans?|handfuls?)$/);
  if(trailing && !unit){
    unit = DN_UNIT_WORDS[trailing[2]];
    name = trailing[1];
  }
  if(!name) return null;

  // Slices/squeezes/drops of something are a fraction of one item.
  if(["slice", "squeeze", "drop"].includes(unit)){
    qty = 0.25;
    unit = "pcs";
  }
  if(qty !== null && !unit) unit = "pcs";
  if(unit === "pcs" || unit === "clove") name = dnSingular(name);

  const out = {name, quantity: qty === null ? 0 : Math.round(qty * 1000) / 1000, unit: qty === null ? "" : unit};
  if(notes.length) out.note = notes.join("; ");
  return out;
}

// One line can hold several ingredients ("Side salad: lettuce, 1 tomato, …").
function dnParseIngredientLine(line){
  const s = dnClean(line);
  if(!s) return [];
  const group = s.match(/^(side salad|salad|topping(?:\s+per\s+(?:portion|serving))?|to serve|garnish|dressing)\s*:\s*(.+)$/i);
  if(group){
    const perPortion = /per\s+(portion|serving)/i.test(group[1]);
    return dnSplitTop(group[2]).map(dnParseOneIngredient).filter(Boolean).map(r => {
      if(perPortion) r.perPortion = true;
      return r;
    });
  }
  const one = dnParseOneIngredient(s);
  return one ? [one] : [];
}

/* =========================================================================
 *  Dinner records
 * ========================================================================= */

function dnTypeFor(name, ingredients){
  const title = dnNorm(name);
  const test = re => re.test(title);
  if(test(/\bchicken\b/)) return "chicken";
  if(test(/\bsalmon\b/)) return "salmon";
  if(test(/\blamb\b/)) return "lamb";
  if(test(/\bpork\b/)) return "pork";
  if(test(/\bbeef\b/)) return "beef";
  if(test(/\b(cod|haddock|fish|tuna|trout|mackerel|sea bass)\b/)) return "fish";
  const ings = (ingredients || []).map(i => i.name).join(" | ");
  if(/chicken/.test(ings)) return "chicken";
  if(/salmon/.test(ings)) return "salmon";
  if(/lamb/.test(ings)) return "lamb";
  if(/pork|bacon|chorizo/.test(ings)) return "pork";
  if(/beef/.test(ings)) return "beef";
  return "veg";
}

const DN_TYPE_LABEL = {chicken: "Chicken", salmon: "Salmon", lamb: "Lamb", pork: "Pork",
  beef: "Beef", fish: "Fish", veg: "Vegetarian"};

function dnNormaliseDinner(d){
  const ingredients = (Array.isArray(d.ingredients) ? d.ingredients : []).map(i => {
    const out = {
      name: String(i.name || "").trim().toLowerCase(),
      quantity: Number(i.quantity) || 0,
      unit: String(i.unit || "")
    };
    if(i.note) out.note = String(i.note);
    if(i.perPortion) out.perPortion = true;
    return out;
  }).filter(i => i.name);
  const out = {
    name: String(d.name || "").trim(),
    serves: Math.max(1, parseInt(d.serves, 10) || 1),
    mins: parseInt(d.mins, 10) || null,
    protein: parseInt(d.protein, 10) || null,
    type: d.type || dnTypeFor(d.name, ingredients),
    ingredients,
    method: (Array.isArray(d.method) ? d.method : []).map(String).filter(Boolean)
  };
  if(d.tip) out.tip = String(d.tip);
  if(d.boost) out.boost = String(d.boost);
  if(d.retired) out.retired = true;
  return out;
}

// Which avoid-list words appear in a dinner (name or ingredients)?
function dnAvoidHits(dinner, avoid){
  const hay = " " + dnNorm([dinner.name].concat((dinner.ingredients || []).map(i => i.name)).join(" | ")) + " ";
  return (avoid || []).filter(word => {
    const w = dnNorm(word);
    if(!w) return false;
    const re = new RegExp("\\b" + w.replace(/ /g, "\\s+") + "(e?s)?\\b");
    return re.test(hay);
  });
}

function dnHasIngredient(dinner, name){
  return (dinner.ingredients || []).some(i => dnSingular(i.name) === name);
}

function dnIngredientCount(dinner, name){
  return (dinner.ingredients || []).filter(i => dnSingular(i.name) === name)
    .reduce((sum, i) => sum + (i.unit === "pcs" ? i.quantity : 1), 0);
}

/* =========================================================================
 *  Reading a Claude reply: recipes and/or a weekly plan
 * ========================================================================= */

const DN_DAY_RE = /^(mon|tues|wednes|thurs|fri|satur|sun)day\b\s*(?:[—–:-]+\s*|\s+)(.+)$/i;

function dnLooksLikeTitle(s){
  return s && s.length < 140 && !/[.]$/.test(s) && !/^(protein|tip|boost|serves|ingredients|method)\b/i.test(s);
}

function dnCleanTitle(s){
  let t = s.replace(/^recipe\s*\d*\s*[:.\-–—]\s*/i, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/:$/, "").trim();
  const retired = /\(retired[^)]*\)/i.test(t);
  t = t.replace(/\(retired[^)]*\)/ig, "").replace(/\s+/g, " ").trim();
  return {title: t, retired};
}

function dnParseRecipes(lines){
  const starts = [];
  for(let i = 0; i < lines.length; i++){
    if(!/^serves\s+\d+/i.test(lines[i])) continue;
    // Title: nearest earlier line that looks like one (skips a short description).
    let j = i - 1, seen = 0, titleIdx = -1;
    while(j >= 0 && seen < 3){
      if(lines[j]){
        seen++;
        if(dnLooksLikeTitle(lines[j])){ titleIdx = j; break; }
      }
      j--;
    }
    if(titleIdx >= 0) starts.push({titleIdx, servesIdx: i});
  }

  return starts.map((st, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].titleIdx : lines.length;
    const {title, retired} = dnCleanTitle(lines[st.titleIdx]);
    const servesLine = lines[st.servesIdx];
    const serves = parseInt(servesLine.match(/^serves\s+(\d+)/i)[1], 10);
    const tm = servesLine.match(/(\d+)\s*(?:[–-]\s*(\d+)\s*)?(min|mins|minutes|hr|hrs|hour|hours)\b/i);
    let mins = null;
    if(tm){
      mins = parseInt(tm[2] || tm[1], 10);
      if(/^h/i.test(tm[3])) mins *= 60;
    }

    const recipe = {name: title, serves, mins, protein: null, ingredients: [], method: []};
    if(retired) recipe.retired = true;
    let mode = "pre";
    const tip = [];
    for(let i = st.servesIdx + 1; i < end; i++){
      const s = lines[i];
      if(!s || /^-{3,}$/.test(s)) continue;
      if(/^week\s+\d+/i.test(s) || /^(shopping list|meal plan)\b/i.test(s) || DN_DAY_RE.test(s)){
        if(mode !== "pre") break;
        continue;
      }
      let m;
      if((m = s.match(/^protein\s*:\s*~?\s*(\d+)/i))){ recipe.protein = parseInt(m[1], 10); continue; }
      if((m = s.match(/^boost(?:\s+it)?\s*:\s*(.+)$/i))){ recipe.boost = m[1].trim(); continue; }
      if(/^ingredients?\s*:?$/i.test(s)){ mode = "ing"; continue; }
      if(/^(method|instructions|steps|directions)\s*:?$/i.test(s)){ mode = "method"; continue; }
      if((m = s.match(/^tips?\s*:\s*(.*)$/i))){ mode = "tip"; if(m[1]) tip.push(m[1]); continue; }
      if(mode === "ing"){
        if(/^for the\b/i.test(s) && /:?$/.test(s) && !/^\d/.test(s)) continue;   // sub-heading
        recipe.ingredients.push(...dnParseIngredientLine(s));
      }else if(mode === "method"){
        m = s.match(/^(\d+)[.)]\s*(.+)$/);
        recipe.method.push(m ? m[2].trim() : s);
      }else if(mode === "tip"){
        tip.push(s);
      }
    }
    if(tip.length) recipe.tip = tip.join(" ");
    return dnNormaliseDinner(recipe);
  }).filter(r => r.name && (r.ingredients.length || r.method.length));
}

function dnParsePlanWeeks(lines){
  const weeks = [];
  let cur = null;
  const startWeek = label => { cur = {label, days: []}; weeks.push(cur); };
  for(const s of lines){
    if(!s) continue;
    const head = s.match(/^(week\s+\d+[^:]*|meal plan[^:]*|dinner plan[^:]*)$/i);
    if(head && !/recipes?$/i.test(s)){ startWeek(head[1].trim()); continue; }
    const m = s.match(DN_DAY_RE);
    if(!m) continue;
    const dayIndex = DN_DAYS.findIndex(d => d.toLowerCase().startsWith(m[1].toLowerCase()));
    if(!cur || cur.days.some(d => d.dayIndex === dayIndex)) startWeek(cur ? "" : "Plan");
    cur.days.push({dayIndex, text: m[2].trim()});
  }
  return weeks.filter(w => w.days.length);
}

// One plan line -> {mode, dish, note}
function dnClassifyDay(text){
  const notes = [];
  let t = text.trim();
  if(/^\(optional\)\s*/i.test(t)){ notes.push("optional"); t = t.replace(/^\(optional\)\s*/i, ""); }
  let guard = 0;
  while(/\)\s*$/.test(t) && guard++ < 3){
    const m = t.match(/\(([^()]*)\)\s*$/);
    if(!m) break;
    notes.unshift(m[1].trim());
    t = t.slice(0, m.index).trim();
  }
  t = t.split(/\s+[—–]\s+/)[0].trim();
  const plus = t.match(/,\s*plus\s+(.+)$/i);
  if(plus){ notes.unshift("plus " + plus[1]); t = t.slice(0, plus.index).trim(); }
  const note = notes.join("; ");
  const all = text.toLowerCase();

  if(/^(no dinner|no cooking|nothing|out\b|out with|away|eating out|takeaway|dinner out)/i.test(t)){
    return {mode: "out", dish: "", note: note || t};
  }
  if(/already sorted|nothing to plan/.test(all)) return {mode: "sorted", dish: t, note};
  if(/^leftovers?\b/i.test(t)){
    return {mode: "leftover", dish: t.replace(/^leftovers?\s*(of\s+)?/i, "").trim(), note};
  }
  return {mode: "cook", dish: t, note};
}

function dnMatchDinner(name, dinners){
  const n = dnNorm(name);
  if(!n) return null;
  let hit = dinners.find(d => dnNorm(d.name) === n);
  if(hit) return hit;
  // Plan text often adds sides ("…, plus salad") or drops them.
  const prefix = dinners.filter(d => {
    const dn = dnNorm(d.name);
    return dn.length >= 12 && (n.startsWith(dn) || dn.startsWith(n));
  }).sort((a, b) => dnNorm(b.name).length - dnNorm(a.name).length);
  if(prefix.length) return prefix[0];
  const words = s => new Set(dnNorm(s).split(" ").filter(w => w.length > 2 && !["with", "and", "the"].includes(w)));
  const a = words(name);
  let best = null, bestScore = 0;
  dinners.forEach(d => {
    const b = words(d.name);
    let both = 0;
    a.forEach(w => { if(b.has(w)) both++; });
    const score = both / (a.size + b.size - both || 1);
    if(score > bestScore){ bestScore = score; best = d; }
  });
  return bestScore >= 0.6 ? best : null;
}

// Main entry for pasted text.
function dnParseClaudeText(text){
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(dnClean);
  return {recipes: dnParseRecipes(lines), weeks: dnParsePlanWeeks(lines)};
}

// Turn a parsed week into seven plan days, matching dishes against the library.
function dnPlanFromParsed(week, dinners){
  const days = DN_DAYS.map(() => ({mode: "free"}));
  week.days.forEach(({dayIndex, text}) => {
    const c = dnClassifyDay(text);
    const day = {mode: c.mode};
    if(c.note) day.note = c.note;
    if(c.mode === "cook" || c.mode === "leftover" || c.mode === "sorted"){
      const hit = c.dish ? dnMatchDinner(c.dish, dinners) : null;
      if(hit) day.dinner = hit.name;
      else if(c.dish) day.text = c.dish;
    }
    days[dayIndex] = day;
  });
  // A bare "Leftovers" day borrows the most recent batch cook before it.
  days.forEach((d, i) => {
    if(d.mode !== "leftover" || d.dinner) return;
    for(let j = i - 1; j >= 0; j--){
      if(days[j].mode === "cook" && days[j].dinner){ d.dinner = days[j].dinner; delete d.text; break; }
    }
  });
  return days;
}

/* =========================================================================
 *  Week generator
 * ========================================================================= */

function dnRandom(seed){
  // mulberry32: repeatable when tests pass a seed, random otherwise
  let a = (seed === undefined ? Math.floor(Math.random() * 2 ** 32) : seed) >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function dnPickWeighted(list, weight, rand){
  const ws = list.map(weight);
  const total = ws.reduce((a, b) => a + b, 0);
  if(total <= 0) return list[Math.floor(rand() * list.length)];
  let r = rand() * total;
  for(let i = 0; i < list.length; i++){
    r -= ws[i];
    if(r <= 0) return list[i];
  }
  return list[list.length - 1];
}

function dnUsable(dinners, rules){
  return dinners.filter(d => !d.retired && !dnAvoidHits(d, rules.avoid).length);
}

/* Fill a week.
 * opts.days     — current seven days. Kept as-is: locked days, "out", "sorted",
 *                 and the leftover night after a locked batch cook.
 * opts.recent   — arrays of dinner names from the previous weeks, newest first.
 * Returns {days, score, checks}.
 */
function dnGenerateWeek(opts){
  const rules = Object.assign({}, DN_DEFAULT_RULES, opts.rules || {});
  const rand = dnRandom(opts.seed);
  const pool = dnUsable(opts.dinners || [], rules);
  const byName = new Map(pool.map(d => [d.name, d]));
  const recent = (opts.recent || []).map(names => new Set(names));
  const base = (opts.days || DN_DAYS.map(() => ({mode: "free"}))).map(d => Object.assign({}, d));

  const fixed = base.map((d, i) => d.locked || d.mode === "out" || d.mode === "sorted");
  base.forEach((d, i) => {
    if(d.mode === "leftover" && i > 0 && fixed[i - 1] && base[i - 1].dinner === d.dinner) fixed[i] = true;
    if(d.mode === "leftover" && d.locked) fixed[i] = true;
  });
  const free = fixed.map(f => !f);

  const pools = {
    chicken: pool.filter(d => d.type === "chicken" && d.serves === 1),
    salmon: pool.filter(d => d.type === "salmon" && d.serves === 1),
    vegBatch: pool.filter(d => d.type === "veg" && d.serves >= 2),
    vegSingle: pool.filter(d => d.type === "veg" && d.serves === 1),
    meatBatch: pool.filter(d => d.type !== "veg" && d.type !== "chicken" && d.type !== "salmon" && d.serves >= 2),
    meatSingle: pool.filter(d => ["lamb", "pork", "beef", "fish"].includes(d.type) && d.serves === 1)
  };

  function pickDish(list, usedNow){
    return dnPickWeighted(list, d => {
      let w = 1;
      if(usedNow.has(d.name)) w *= 0.05;
      if(recent[0] && recent[0].has(d.name)) w *= 0.35;
      if(recent[1] && recent[1].has(d.name)) w *= 0.7;
      if(d.protein && d.protein < 15) w *= 0.6;
      return w;
    }, rand);
  }

  function fillOnce(){
    const days = base.map(d => Object.assign({}, d));
    const used = new Set(days.filter(d => d.dinner).map(d => d.dinner));
    const blocks = {C: 0, S: 0, B: 0};
    for(let i = 0; i < 7; i++){
      if(!free[i]) continue;
      const pair = i < 6 && free[i + 1];
      const options = [];
      if(pair && pools.chicken.length) options.push(["C", blocks.C ? 0.25 : 3]);
      if(pair && pools.salmon.length) options.push(["S", blocks.S ? 0.25 : 3]);
      if(pair && pools.vegBatch.length) options.push(["B", blocks.B ? 0.4 : 2.2]);
      if(pair && pools.meatBatch.length) options.push(["P", 0.25]);
      if(pools.vegSingle.length) options.push(["V", 1]);
      if(pools.meatSingle.length) options.push(["M", 0.2]);
      if(!options.length){
        if(pools.chicken.length) options.push(["c", 1]);
        if(pools.salmon.length) options.push(["s", 1]);
        if(pools.vegBatch.length) options.push(["b", 1]);
      }
      if(!options.length) break;
      const kind = dnPickWeighted(options, o => o[1], rand)[0];
      const cook = (idx, dish) => { days[idx] = {mode: "cook", dinner: dish.name}; used.add(dish.name); };

      if(kind === "C" || kind === "S"){
        const list = kind === "C" ? pools.chicken : pools.salmon;
        const a = pickDish(list, used); cook(i, a);
        const b = pickDish(list, used); cook(i + 1, b);
        blocks[kind]++;
        i++;
      }else if(kind === "B" || kind === "P"){
        const dish = pickDish(kind === "B" ? pools.vegBatch : pools.meatBatch, used);
        cook(i, dish);
        days[i + 1] = {mode: "leftover", dinner: dish.name};
        if(kind === "B") blocks.B++;
        i++;
      }else if(kind === "V"){
        cook(i, pickDish(pools.vegSingle, used));
      }else if(kind === "M"){
        cook(i, pickDish(pools.meatSingle, used));
      }else{
        const list = kind === "c" ? pools.chicken : kind === "s" ? pools.salmon : pools.vegBatch;
        cook(i, pickDish(list, used));
      }
    }
    return days;
  }

  let best = null;
  const tries = opts.tries || 700;
  for(let t = 0; t < tries; t++){
    const days = fillOnce();
    const res = dnScoreWeek(days, byName, rules, recent);
    const jittered = res.score + rand() * 1.5;
    if(!best || jittered > best.jittered) best = {days, score: res.score, checks: res.checks, jittered};
  }
  return {days: best.days, score: best.score, checks: best.checks};
}

// Score a week against the rules. Also used to show the checklist under a plan.
function dnScoreWeek(days, byName, rules, recent){
  rules = Object.assign({}, DN_DEFAULT_RULES, rules || {});
  recent = recent || [];
  let s = 0;
  const checks = [];
  const dish = d => d && d.dinner ? byName.get(d.dinner) : null;
  const cooks = days.map((d, i) => ({d, i, dinner: d.mode === "cook" ? dish(d) : null}));
  const planned = days.filter(d => d.mode !== "out").length;

  // Packs: chicken (4 thighs = 2 nights) and salmon (2 fillets) on consecutive nights.
  ["chicken", "salmon"].forEach(type => {
    const idx = cooks.filter(c => c.dinner && c.dinner.type === type && c.dinner.serves === 1).map(c => c.i);
    const label = type === "chicken" ? "Chicken pack" : "Salmon pack";
    if(!idx.length){
      if(planned >= 5) s -= 1.5;
      return;
    }
    let paired = 0, singles = 0;
    for(let k = 0; k < idx.length; k++){
      if(k + 1 < idx.length && idx[k + 1] === idx[k] + 1){ paired++; k++; }
      else singles++;
    }
    s += paired * 4 - Math.max(0, paired - 1) * 3 - singles * 3;
    if(singles) checks.push({ok: false, text: `${label} split: ${singles} night on its own (packs are used over 2 nights)`});
    else checks.push({ok: true, text: `${label} used over consecutive nights`});
  });

  // Batch cook covering the next night.
  const batches = cooks.filter(c => c.dinner && c.dinner.serves >= 2);
  batches.forEach(c => {
    const next = days[c.i + 1];
    if(next && next.mode === "leftover" && next.dinner === c.dinner.name){
      s += c.dinner.type === "veg" ? 2 : 1;
    }
  });

  // Office nights.
  const office = [];
  rules.officeDays.forEach(i => {
    const d = days[i];
    if(!d) return;
    if(d.mode === "leftover"){ s += 3; office.push(`${DN_DAYS_SHORT[i]} leftovers`); return; }
    if(d.mode !== "cook") return;
    const din = dish(d);
    const mins = din && din.mins;
    if(!mins){ office.push(`${DN_DAYS_SHORT[i]} ?`); return; }
    if(mins <= 25){ s += 1; office.push(`${DN_DAYS_SHORT[i]} ${mins} min`); }
    else if(mins <= rules.maxWeeknightMins){ s -= 1; office.push(`${DN_DAYS_SHORT[i]} ${mins} min`); }
    else { s -= 4; office.push(`${DN_DAYS_SHORT[i]} ${mins} min`); }
  });
  const slowOffice = rules.officeDays.some(i => {
    const din = days[i] && days[i].mode === "cook" ? dish(days[i]) : null;
    return din && din.mins > rules.maxWeeknightMins;
  });
  if(office.length) checks.push({ok: !slowOffice, text: `Office nights: ${office.join(", ")}`});

  // Weeknight time limit.
  const slow = [];
  for(let i = 0; i < 5; i++){
    const din = days[i].mode === "cook" ? dish(days[i]) : null;
    if(din && din.mins > rules.maxWeeknightMins){ slow.push(DN_DAYS_SHORT[i]); if(!rules.officeDays.includes(i)) s -= 4; }
  }
  checks.push(slow.length
    ? {ok: false, text: `Over ${rules.maxWeeknightMins} min on a weeknight: ${slow.join(", ")}`}
    : {ok: true, text: `Weeknights all ${rules.maxWeeknightMins} min or under`});

  // Vegetarian early in the week; salmon later (defrosting).
  [0, 1].forEach(i => {
    const din = days[i].mode === "cook" ? dish(days[i]) : null;
    if(din && din.type === "veg") s += 1.5;
  });
  const firstSalmon = cooks.find(c => c.dinner && c.dinner.type === "salmon");
  const firstChicken = cooks.find(c => c.dinner && c.dinner.type === "chicken");
  if(firstSalmon && firstSalmon.i >= 4) s += 1.5;
  else if(firstSalmon && firstSalmon.i >= 3) s += 0.75;
  if(firstChicken && firstChicken.i <= 3) s += 1;

  // Pak choi: comes in a pack of 2.
  let pak = 0;
  cooks.forEach(c => { if(c.dinner) pak += dnIngredientCount(c.dinner, "pak choi"); });
  if(pak === 2) s += 5;
  else if(pak === 0) s -= 1;
  else if(pak === 4) s -= 1;
  else s -= 4;
  checks.push({ok: pak === 2 || pak === 4, text: pak === 2 ? "Pak choi used twice (one pack)"
    : pak === 0 ? "No pak choi this week" : `Pak choi used ${pak} times (packs are 2)`});

  // Variety.
  const names = cooks.filter(c => c.dinner).map(c => c.dinner.name);
  const seen = new Set();
  let repeats = 0;
  names.forEach(n => { if(seen.has(n)) repeats++; seen.add(n); });
  s -= repeats * 3;
  // Near-duplicates: "Gochujang Chicken with Brown Rice…" and "…with Basmati Rice…".
  const bases = new Set();
  let samey = 0;
  [...seen].forEach(n => {
    const b = dnNorm(n.split(/\s+with\s+/i)[0]);
    if(bases.has(b)) samey++;
    bases.add(b);
  });
  s -= samey * 2.5;
  if(recent[0]) s -= names.filter(n => recent[0].has(n)).length * 1.5;
  if(recent[1]) s -= names.filter(n => recent[1].has(n)).length * 0.75;
  const brown = cooks.filter(c => c.dinner && dnHasIngredient(c.dinner, "brown rice")).length;
  if(brown > 1) s -= brown - 1;
  cooks.forEach(c => { if(c.dinner && c.dinner.protein && c.dinner.protein < 15) s -= 0.5; });

  // Avoid list (pasted plans can include anything).
  const flagged = cooks.filter(c => c.dinner && dnAvoidHits(c.dinner, rules.avoid).length);
  if(flagged.length){
    s -= 10 * flagged.length;
    checks.push({ok: false, text: "Contains something on your avoid list: " +
      flagged.map(c => `${c.dinner.name} (${dnAvoidHits(c.dinner, rules.avoid).join(", ")})`).join("; ")});
  }

  return {score: s, checks};
}

// Notes shown under each day: packs, defrosting, batch cooking.
function dnAutoNotes(days, byName, rules){
  rules = Object.assign({}, DN_DEFAULT_RULES, rules || {});
  const notes = days.map(() => []);
  const dish = d => d && d.mode === "cook" && d.dinner ? byName.get(d.dinner) : null;
  for(let i = 0; i < 7; i++){
    const din = dish(days[i]);
    if(!din) continue;
    const prev = i > 0 ? dish(days[i - 1]) : null;
    if(din.type === "chicken" && din.serves === 1){
      const continuing = prev && prev.type === "chicken" && notes[i - 1].includes("Open chicken pack, use 2 thighs");
      notes[i].push(continuing ? "Remaining 2 thighs" : "Open chicken pack, use 2 thighs");
    }
    if(din.type === "salmon" && din.serves === 1){
      const continuing = prev && prev.type === "salmon" && notes[i - 1].includes("Open salmon pack");
      notes[i].push(continuing ? "Finish salmon pack" : "Open salmon pack");
      if(i > 0) notes[i - 1].push("Defrost a salmon fillet tonight");
    }
    if(din.serves >= 2){
      const next = days[i + 1];
      if(next && next.mode === "leftover") notes[i].push(`Batch cook for ${din.serves} portions`);
    }
  }
  days.forEach((d, i) => {
    if(d.mode === "leftover"){
      notes[i].unshift(rules.officeDays.includes(i) ? "Nothing to cook after the office" : "Nothing to cook");
    }
  });
  return notes;
}

/* =========================================================================
 *  Dates
 * ========================================================================= */

function dnIso(date){
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function dnFromIso(iso){
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function dnMonday(date){
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function dnAddDays(iso, n){
  const d = dnFromIso(iso);
  d.setDate(d.getDate() + n);
  return dnIso(d);
}
function dnPrettyDate(iso, withDay){
  const d = dnFromIso(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${withDay ? DN_DAYS_SHORT[(d.getDay() + 6) % 7] + " " : ""}${d.getDate()} ${months[d.getMonth()]}`;
}

/* =========================================================================
 *  Prompts to copy into Claude
 * ========================================================================= */

function dnPromptFormat(oneRecipe){
  return (oneRecipe ? "" :
`Meal Plan
- Monday — Dish name (short note)
- Tuesday — Leftover Dish name
- …one line for every day…

Recipes
`) +
`### Dish name
*Serves 1 | ~25 minutes*
**Protein: ~30g**

**Ingredients**
- 90g basmati rice
- 2 chicken thighs, bone-in
- 1 tbsp soy sauce

**Method**
1. First step.
2. Second step.

**Tip:** One practical tip.`;
}

function dnBuildPrompt(kind, info){
  const rules = Object.assign({}, DN_DEFAULT_RULES, info.rules || {});
  const office = rules.officeDays.map(i => DN_DAYS[i]).join(" and ");
  const ruleLines = [
    `- Never include: ${rules.avoid.join(", ")} (eggs in any form).`,
    "- Chicken thighs come in packs of 4 (2 per meal), so use them on two consecutive nights. Salmon comes frozen in packs of 2 fillets: two consecutive nights.",
    "- Pak choi comes in packs of 2: use it exactly twice in the week, steamed.",
    `- Weeknight dinners take ${rules.maxWeeknightMins} minutes or less. ${office} are office days: cover them with leftovers from a batch cook the night before, or something very quick.`,
    "- Vegetarian dinners are welcome, especially early in the week. Flavours lean Korean and Indian (gochujang, garam masala, cumin, turmeric, sesame oil).",
    "- Recipes are for one person unless they're a batch cook (Serves 2, covering two nights).",
    `- Staples I already have: ${rules.staples.join(", ")}.`
  ];
  const library = (info.library || []).map(n => `- ${n}`).join("\n");

  if(kind === "recipe"){
    return [
      `Give me one new dinner recipe${info.fancy ? `: ${info.fancy}` : ""}.`,
      "",
      "My rules:",
      ...ruleLines,
      "",
      "Make it something different from the dinners I already have:",
      library || "- (none yet)",
      "",
      "Reply with the recipe in exactly this format so my app can read it (start every ingredient line with an amount and unit):",
      "",
      dnPromptFormat(true)
    ].join("\n");
  }

  const fixed = (info.fixedDays || []).map(f => `- ${f}`).join("\n");
  return [
    `Plan my dinners for the week starting ${info.weekLabel}${info.fancy ? `. This week I fancy: ${info.fancy}` : ""}.`,
    "",
    "My rules:",
    ...ruleLines,
    ...(fixed ? ["", "These days are already decided, keep them as they are:", fixed] : []),
    "",
    "Dinners I already have recipes for (reuse the names exactly when you pick one; only write out full recipes for new dishes):",
    library || "- (none yet)",
    "",
    "Reply in exactly this format so my app can read it (start every ingredient line with an amount and unit):",
    "",
    dnPromptFormat(false)
  ].join("\n");
}

if(typeof module !== "undefined" && module.exports){
  module.exports = {dnParseClaudeText, dnParseIngredientLine, dnPlanFromParsed, dnGenerateWeek,
    dnScoreWeek, dnAutoNotes, dnClassifyDay, dnMatchDinner, dnNormaliseDinner, dnAvoidHits,
    dnBuildPrompt, dnSingular, DN_DEFAULT_RULES, DN_DAYS};
}

/* =========================================================================
 *  UI — everything below needs the page
 * ========================================================================= */

let dnData = {rules: JSON.parse(JSON.stringify(DN_DEFAULT_RULES)), dinners: []};
let dnDataSha = null;
let dnPlans = {weeks: []};
let dnPlansSha = null;
let dnSaveTimers = {};
let dnMode = "plan";               // "plan" | "library"
let dnWeekId = null;
let dnExpanded = null;             // day index (plan) or dinner name (library)
let dnLibSearch = "";
let dnParsed = null;               // last pasted reply, while reviewing
let dnLoaded = false;

function dnRules(){ return Object.assign({}, DN_DEFAULT_RULES, dnData.rules || {}); }
function dnByName(){ return new Map(dnData.dinners.map(d => [d.name, d])); }
function dnThisMonday(){ return dnIso(dnMonday(new Date())); }

function dnNormaliseData(raw){
  const out = {rules: JSON.parse(JSON.stringify(DN_DEFAULT_RULES)), dinners: []};
  if(raw && typeof raw === "object"){
    if(raw.rules && typeof raw.rules === "object"){
      ["avoid", "staples"].forEach(k => { if(Array.isArray(raw.rules[k])) out.rules[k] = raw.rules[k].map(String); });
      if(Array.isArray(raw.rules.officeDays)) out.rules.officeDays = raw.rules.officeDays.map(Number);
      if(raw.rules.maxWeeknightMins) out.rules.maxWeeknightMins = Number(raw.rules.maxWeeknightMins);
      if(raw.rules.packs && typeof raw.rules.packs === "object") out.rules.packs = raw.rules.packs;
    }
    if(Array.isArray(raw.dinners)) out.dinners = raw.dinners.map(dnNormaliseDinner).filter(d => d.name);
  }
  return out;
}

function dnNormalisePlans(raw){
  const weeks = raw && Array.isArray(raw.weeks) ? raw.weeks : [];
  return {weeks: weeks.filter(w => w && /^\d{4}-\d{2}-\d{2}$/.test(w.start)).map(w => ({
    start: w.start,
    onList: !!w.onList,
    days: DN_DAYS.map((_, i) => {
      const d = (w.days || [])[i] || {};
      const mode = ["cook", "leftover", "out", "sorted", "free"].includes(d.mode) ? d.mode : "free";
      const out = {mode};
      ["dinner", "text", "note"].forEach(k => { if(d[k]) out[k] = String(d[k]); });
      if(d.locked) out.locked = true;
      return out;
    })
  })).sort((a, b) => a.start.localeCompare(b.start))};
}

/* ---------- GitHub sync ---------- */

async function dnFetchAll(){
  const [data, plans] = await Promise.all([getGithubFile(DN_DINNERS_PATH), getGithubFile(DN_PLANS_PATH)]);
  dnDataSha = data ? data.sha : null;
  dnPlansSha = plans ? plans.sha : null;
  try{ dnData = dnNormaliseData(data ? JSON.parse(data.text) : null); }
  catch(e){ throw new Error("Dinners.json is not valid JSON"); }
  try{ dnPlans = dnNormalisePlans(plans ? JSON.parse(plans.text) : null); }
  catch(e){ throw new Error("MealPlans.json is not valid JSON"); }
  dnLoaded = true;
  if(typeof currentView !== "undefined" && currentView === "dinners") renderDinners();
}

async function dnPush(path, obj, which, message){
  setStatus("busy", "Saving…");
  const getSha = () => which === "data" ? dnDataSha : dnPlansSha;
  const setSha = v => { if(which === "data") dnDataSha = v; else dnPlansSha = v; };
  try{
    const body = {message, content: b64EncodeUtf8(JSON.stringify(obj, null, 2) + "\n"), branch: BRANCH};
    if(getSha()) body.sha = getSha();
    const send = () => fetch(apiUrl(path), {method: "PUT", headers: authHeaders(), body: JSON.stringify(body)});
    let res = await send();
    if(res.status === 409 || res.status === 422){
      const fresh = await fetch(apiUrl(path), {headers: authHeaders()});
      if(fresh.ok){ setSha((await fresh.json()).sha); body.sha = getSha(); }
      res = await send();
    }
    if(!res.ok) throw new Error(`GitHub error ${res.status}`);
    setSha((await res.json()).content.sha);
    setStatus("ok", "Synced");
    return true;
  }catch(e){
    setStatus("err", `${path} save failed`);
    return false;
  }
}

function dnQueueSave(which, message){
  clearTimeout(dnSaveTimers[which]);
  dnSaveTimers[which] = setTimeout(() => {
    if(which === "data") dnPush(DN_DINNERS_PATH, dnData, "data", message);
    else{
      // Keep the file small: the last 26 weeks and anything in the future.
      const cutoff = dnAddDays(dnThisMonday(), -7 * 26);
      dnPlans.weeks = dnPlans.weeks.filter(w => w.start >= cutoff);
      dnPush(DN_PLANS_PATH, dnPlans, "plans", message);
    }
  }, 700);
}

/* ---------- Undo hooks (called from index.html) ---------- */

function dnSnapshot(){ return JSON.parse(JSON.stringify({data: dnData, plans: dnPlans})); }
function dnRestore(snap){
  if(!snap) return;
  const dataChanged = JSON.stringify(snap.data) !== JSON.stringify(dnData);
  const plansChanged = JSON.stringify(snap.plans) !== JSON.stringify(dnPlans);
  dnData = snap.data;
  dnPlans = snap.plans;
  if(dataChanged) dnQueueSave("data", "Undo dinner change");
  if(plansChanged) dnQueueSave("plans", "Undo meal plan change");
  if(currentView === "dinners") renderDinners();
}

/* ---------- Weeks ---------- */

function dnGetWeek(id){ return dnPlans.weeks.find(w => w.start === id) || null; }

function dnEnsureWeek(id){
  let w = dnGetWeek(id);
  if(w) return w;
  w = {start: id, onList: false, days: DN_DAYS.map(() => ({mode: "free"}))};
  // Sunday's batch cook carries into Monday.
  const prev = dnGetWeek(dnAddDays(id, -7));
  const sun = prev && prev.days[6];
  const din = sun && sun.mode === "cook" && sun.dinner ? dnByName().get(sun.dinner) : null;
  if(din && din.serves >= 2) w.days[0] = {mode: "leftover", dinner: din.name, note: "From Sunday's batch cook", locked: true};
  dnPlans.weeks.push(w);
  dnPlans.weeks.sort((a, b) => a.start.localeCompare(b.start));
  return w;
}

function dnRecentNames(id){
  return [1, 2].map(n => {
    const w = dnGetWeek(dnAddDays(id, -7 * n));
    return w ? w.days.filter(d => d.dinner).map(d => d.dinner) : [];
  });
}

function dnWeekHasPlan(w){ return !!w && w.days.some(d => d.mode !== "free"); }

function dnGenerate(){
  const id = dnWeekId;
  pushUndo("generate dinner plan");
  const week = dnEnsureWeek(id);
  const usable = dnUsable(dnData.dinners, dnRules());
  if(!usable.length){
    alert("There are no dinners in your library yet. Paste some recipes from Claude first.");
    return;
  }
  const res = dnGenerateWeek({dinners: dnData.dinners, days: week.days, recent: dnRecentNames(id), rules: dnRules()});
  week.days = res.days.map((d, i) => {
    const keep = week.days[i];
    if(keep.locked || keep.mode === "out" || keep.mode === "sorted") return keep;
    const out = {mode: d.mode};
    if(d.dinner) out.dinner = d.dinner;
    return out;
  });
  week.onList = true;
  dnExpanded = null;
  dnQueueSave("plans", `Plan dinners w/c ${id}`);
  renderDinners();
  updateShopBadge();
}

/* ---------- Day edits ---------- */

function dnSetDay(i, patch, label){
  pushUndo(label || "change dinner plan");
  const week = dnEnsureWeek(dnWeekId);
  const before = week.days[i];
  const next = Object.assign({}, patch);
  if(before.locked && !("locked" in patch)) next.locked = true;
  week.days[i] = next;

  // Keep the following leftover night in step with a changed batch cook.
  const after = week.days[i + 1];
  if(after && after.mode === "leftover" && before.dinner && after.dinner === before.dinner && next.dinner !== before.dinner){
    const din = next.dinner ? dnByName().get(next.dinner) : null;
    week.days[i + 1] = din && din.serves >= 2 && next.mode === "cook"
      ? Object.assign({}, after, {dinner: din.name}) : {mode: "free"};
  }
  // A new batch cook fills an empty next night with its leftovers.
  const din = next.mode === "cook" && next.dinner ? dnByName().get(next.dinner) : null;
  if(din && din.serves >= 2 && week.days[i + 1] && week.days[i + 1].mode === "free"){
    week.days[i + 1] = {mode: "leftover", dinner: din.name};
  }
  dnQueueSave("plans", `Update dinners w/c ${dnWeekId}`);
  renderDinners();
  updateShopBadge();
}

function dnLeftoverSource(i){
  const week = dnGetWeek(dnWeekId);
  const map = dnByName();
  for(let j = i - 1; j >= 0; j--){
    const d = week.days[j];
    const din = d.mode === "cook" && d.dinner ? map.get(d.dinner) : null;
    if(din && din.serves >= 2) return din.name;
  }
  return null;
}

function dnShuffleDay(i){
  const week = dnGetWeek(dnWeekId);
  const day = week && week.days[i];
  const map = dnByName();
  const cur = day && day.dinner ? map.get(day.dinner) : null;
  const usedNow = new Set(week.days.map(d => d.dinner).filter(Boolean));
  let pool = dnUsable(dnData.dinners, dnRules());
  if(cur) pool = pool.filter(d => d.type === cur.type && (d.serves >= 2) === (cur.serves >= 2));
  else pool = pool.filter(d => d.serves === 1);
  const fresh = pool.filter(d => !usedNow.has(d.name));
  const choices = fresh.length ? fresh : pool.filter(d => !cur || d.name !== cur.name);
  if(!choices.length) return;
  const recent = dnRecentNames(dnWeekId).map(n => new Set(n));
  const rand = dnRandom();
  const pick = dnPickWeighted(choices, d => (recent[0].has(d.name) ? 0.35 : 1) * (recent[1].has(d.name) ? 0.7 : 1), rand);
  dnSetDay(i, {mode: "cook", dinner: pick.name}, `shuffle ${DN_DAYS[i]}`);
}

/* ---------- Shopping ---------- */

function dnIsStaple(name){
  const n = normaliseName(name);
  const list = dnRules().staples.map(normaliseName);
  const bare = n.replace(/^(fresh|ground|dried)\s+/, "");
  return list.includes(n) || list.includes(bare) || list.includes(dnSingular(n));
}

function dnStockFor(name){
  const n = normaliseName(name);
  const variants = [n, n.replace(/^fresh\s+/, ""), dnSingular(n), n + "s", n + "es"];
  for(const v of variants){
    const hit = items.find(i => sameIngredient(i.name, v));
    if(hit) return hit;
  }
  return null;
}

function dnPlural(unit, q){
  if(q <= 1 || !unit) return unit;
  if(unit === "pinch") return "pinches";
  if(["tin", "clove", "handful", "pack", "bunch"].includes(unit)) return unit + (unit === "bunch" ? "es" : "s");
  return unit;
}

function dnFmtAmount(q, unit){
  const n = Math.round(q * 100) / 100;
  if(!unit || unit === "pcs") return String(n);
  if(unit in DN_MEASURE) return fmtQty(n, unit);
  return `${n} ${dnPlural(unit, n)}`;
}

// Everything the weeks marked "on the shopping list" still need.
function dinnerShoppingNeeds(){
  if(!dnLoaded) return [];
  const map = dnByName();
  const packs = dnRules().packs || {};
  const groups = new Map();
  const weeks = dnPlans.weeks.filter(w => w.onList);
  weeks.forEach(w => {
    w.days.forEach(d => {
      if(d.mode !== "cook" || !d.dinner) return;
      const din = map.get(d.dinner);
      if(!din) return;
      din.ingredients.forEach(ing => {
        const q = ing.quantity * (ing.perPortion ? din.serves : 1);
        if(!q) return;
        const measure = ing.unit in DN_MEASURE;
        const family = measure ? "measure" : (ing.unit || "pcs");
        const key = "dinner:" + canonicalName(dnSingular(ing.name)) + "|" + family;
        let g = groups.get(key);
        if(!g){
          g = {key, name: ing.name, unit: measure ? (ing.unit === "kg" ? "g" : ing.unit === "l" ? "ml" : ing.unit) : ing.unit || "pcs", total: 0, dinners: []};
          groups.set(key, g);
        }
        const conv = measure ? q * DN_MEASURE[ing.unit] / DN_MEASURE[g.unit] : q;
        g.total += conv;
        const short = din.name.split(/\s+with\s+/i)[0];
        if(!g.dinners.includes(short)) g.dinners.push(short);
      });
    });
  });

  const out = [];
  groups.forEach(g => {
    const stock = dnStockFor(g.name);
    let have = 0;
    let label = dnTitle(g.unit === "pcs" ? dnSingular(g.name) : g.name);
    if(stock){
      if(stock.staple) return;
      label = stock.name;
      const conv = g.unit in DN_MEASURE ? convertQty(stock.quantity, stock.unit, g.unit)
        : (g.unit === stock.unit ? stock.quantity : null);
      have = conv === null ? 0 : Math.max(conv, 0);
    }else if(dnIsStaple(g.name)){
      return;
    }
    const short = Math.round((g.total - have) * 100) / 100;
    if(short <= 0.001) return;

    let qtyText = dnFmtAmount(short, g.unit);
    const pack = packs[dnSingular(g.name)];
    if(pack && g.unit === "pcs"){
      const n = Math.ceil(short / pack.size - 1e-9);
      qtyText = `${n} ${n === 1 ? "pack" : "packs"} (${Math.round(short * 100) / 100})`;
    }else if((g.unit === "pcs" || g.unit === "tin" || g.unit === "pack") && short % 1){
      qtyText = dnFmtAmount(Math.ceil(short), g.unit);   // you can't buy half a tin
    }
    out.push({key: g.key, name: label, qtyText, sub: "for " + g.dinners.join(", ")});
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function dnShoppingTitle(){
  const weeks = dnPlans.weeks.filter(w => w.onList).map(w => "w/c " + dnPrettyDate(w.start));
  return weeks.length ? `For dinners, ${weeks.join(" & ")}` : "For dinners";
}

/* ---------- Rendering ---------- */

function dnIngText(ing, serves){
  const q = ing.quantity * (ing.perPortion ? serves : 1);
  const name = ing.name;
  if(!q) return dnTitle(name).replace(/^./, c => c.toUpperCase()) + " (to taste)";
  let amount;
  if(ing.unit in DN_MEASURE) amount = `${Math.round(q * 100) / 100}${ing.unit === "g" || ing.unit === "kg" || ing.unit === "ml" ? "" : " "}${ing.unit}`;
  else if(ing.unit === "pcs" || !ing.unit) amount = String(Math.round(q * 100) / 100);
  else amount = `${Math.round(q * 100) / 100} ${dnPlural(ing.unit, q)}`;
  const shownName = ing.unit === "clove" ? name : (ing.unit === "pcs" && q > 1 ? name + (/(s|ch|sh)$/.test(name) ? "" : /o$/.test(name) ? "es" : "s") : name);
  return `${amount} ${shownName}${ing.note ? ` (${ing.note})` : ""}`;
}

function dnRecipeHtml(din){
  const meta = [`Serves ${din.serves}`, din.mins ? `~${din.mins} min` : null, din.protein ? `~${din.protein}g protein` : null]
    .filter(Boolean).join(" · ");
  const avoid = dnAvoidHits(din, dnRules().avoid);
  return `
    <div class="recipe-block"><div class="recipe-block-title">${escapeHtml(meta)}</div>
      ${avoid.length ? `<p class="dn-warn">Contains ${escapeHtml(avoid.join(", "))}, which is on your avoid list</p>` : ""}
      ${din.boost ? `<p class="dn-boost">Boost it: ${escapeHtml(din.boost)}</p>` : ""}
    </div>
    <div class="recipe-block"><div class="recipe-block-title">Ingredients</div>
      <ul class="dn-ings">${din.ingredients.map(i => `<li>${escapeHtml(dnIngText(i, din.serves))}</li>`).join("")}</ul>
    </div>
    ${din.method.length ? `<div class="recipe-block"><div class="recipe-block-title">Method</div>
      <ol class="method-list">${din.method.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol></div>` : ""}
    ${din.tip ? `<div class="recipe-block"><div class="recipe-block-title">Tip</div><p class="dn-tip">${escapeHtml(din.tip)}</p></div>` : ""}`;
}

function renderDinners(){
  const view = document.getElementById("dinnersView");
  if(!view) return;
  document.querySelectorAll("#dnModeChips .chip").forEach(c => c.classList.toggle("active", c.dataset.mode === dnMode));
  document.getElementById("dnPlan").classList.toggle("hidden", dnMode !== "plan");
  document.getElementById("dnLibrary").classList.toggle("hidden", dnMode !== "library");
  document.getElementById("dnGenerateBtn").classList.toggle("hidden", dnMode !== "plan");
  if(!dnWeekId) dnWeekId = dnThisMonday();
  if(dnMode === "plan") dnRenderPlan(); else dnRenderLibrary();
}

function dnRenderPlan(){
  const host = document.getElementById("dnPlan");
  const week = dnGetWeek(dnWeekId);
  const map = dnByName();
  const rules = dnRules();
  const thisMon = dnThisMonday();
  const rel = dnWeekId === thisMon ? "This week" : dnWeekId === dnAddDays(thisMon, 7) ? "Next week"
    : dnWeekId === dnAddDays(thisMon, -7) ? "Last week" : "";
  const genBtn = document.getElementById("dnGenerateBtn");
  genBtn.textContent = dnWeekHasPlan(week) ? "Regenerate week" : "Generate week";

  let html = `
    <div class="dn-weeknav">
      <button type="button" class="dn-nav" data-step="-7" aria-label="Previous week">‹</button>
      <div class="dn-weeklabel"><strong>w/c ${escapeHtml(dnPrettyDate(dnWeekId, true))}</strong>${rel ? `<small>${rel}</small>` : ""}</div>
      <button type="button" class="dn-nav" data-step="7" aria-label="Next week">›</button>
    </div>
    ${dnLoaded && dnWeekHasPlan(week) ? `<div class="dn-weektools">
      <button type="button" class="dn-clear" id="dnClearWeek">Clear week</button>
    </div>` : ""}`;

  if(!dnLoaded){
    host.innerHTML = html + `<div class="empty">Loading dinners…</div>`;
    dnWirePlan(host);
    return;
  }

  if(!dnWeekHasPlan(week)){
    html += `<div class="empty dn-empty">No dinners planned for this week yet.<br>
      Tap <b>Generate week</b> to build one from your ${dnUsable(dnData.dinners, rules).length} dinners,
      or bring in a plan from Claude.</div>`;
  }

  const days = week ? week.days : DN_DAYS.map(() => ({mode: "free"}));
  const notes = dnAutoNotes(days, map, rules);
  html += `<div class="dn-days">`;
  days.forEach((d, i) => {
    const din = d.dinner ? map.get(d.dinner) : null;
    const date = dnPrettyDate(dnAddDays(dnWeekId, i));
    let title, sub = [], cls = "dn-free";
    if(d.mode === "cook"){
      title = din ? din.name : (d.text || "Dinner");
      cls = "dn-" + (din ? din.type : "other");
      if(din){
        if(din.mins) sub.push(`${din.mins} min`);
        if(din.protein) sub.push(`${din.protein}g protein`);
      }else sub.push("No recipe saved, so not on the shopping list");
    }else if(d.mode === "leftover"){
      title = "Leftover " + (din ? din.name : (d.text || ""));
      cls = "dn-leftover";
    }else if(d.mode === "out"){
      title = "No dinner needed"; cls = "dn-out";
    }else if(d.mode === "sorted"){
      title = (din ? din.name : d.text) || "Already sorted"; cls = "dn-out";
      sub.push("Already sorted");
    }else{
      title = "Not planned";
    }
    const dayNotes = d.note ? [d.note] : notes[i];
    if(dayNotes.length && d.mode !== "free") sub.push(...dayNotes);
    const open = dnExpanded === i;
    const office = rules.officeDays.includes(i);

    html += `<div class="recipe-row dn-day ${cls}${open ? " open" : ""}" data-day="${i}">
      <div class="recipe-summary dn-summary" data-toggle="${i}">
        <div class="dn-date"><b>${DN_DAYS_SHORT[i]}</b><small>${escapeHtml(date)}</small>${office ? `<small class="dn-office">office</small>` : ""}</div>
        <div class="recipe-info">
          <div class="recipe-name">${escapeHtml(title)}</div>
          ${sub.length ? `<div class="recipe-sub">${escapeHtml(sub.join(" · "))}</div>` : ""}
        </div>
        ${d.locked ? `<span class="dn-lock" title="Locked">🔒</span>` : ""}
      </div>
      ${open ? dnDayDetails(d, i, din) : ""}
    </div>`;
  });
  html += `</div>`;

  if(dnWeekHasPlan(week)){
    const {checks} = dnScoreWeek(week.days, map, rules, []);
    html += `<div class="dn-checks">${checks.map(c =>
      `<div class="${c.ok ? "ok" : "bad"}"><span>${c.ok ? "✓" : "!"}</span>${escapeHtml(c.text)}</div>`).join("")}</div>`;
    const needs = week.onList ? dinnerShoppingNeeds().length : 0;
    html += `<div class="dn-weekactions">
      <button type="button" class="${week.onList ? "btn-secondary" : "btn-primary"}" id="dnListToggle">
        ${week.onList ? `On shopping list ✓ ${needs ? `(${needs} to buy)` : ""}` : "Add to shopping list"}</button>
    </div>`;
  }

  host.innerHTML = html;
  dnWirePlan(host);
}

function dnDayDetails(d, i, din){
  const usable = dnData.dinners.filter(x => !x.retired)
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const groups = {};
  usable.forEach(x => { (groups[x.type] = groups[x.type] || []).push(x); });
  const options = Object.keys(groups).map(t => `<optgroup label="${escapeHtml(DN_TYPE_LABEL[t] || t)}">${
    groups[t].map(x => `<option value="${escapeHtml(x.name)}"${d.mode === "cook" && d.dinner === x.name ? " selected" : ""}>${escapeHtml(x.name)}${x.serves >= 2 ? " (serves 2)" : ""}</option>`).join("")
  }</optgroup>`).join("");
  return `<div class="recipe-details">
    <select class="dn-swap" data-day="${i}" aria-label="Choose dinner for ${DN_DAYS[i]}">
      <option value="">Choose a dinner…</option>${options}
    </select>
    <div class="dn-actions">
      <button type="button" data-act="shuffle" data-day="${i}">Shuffle</button>
      <button type="button" data-act="leftover" data-day="${i}">Leftovers</button>
      <button type="button" data-act="out" data-day="${i}">Out</button>
      <button type="button" data-act="lock" data-day="${i}" class="${d.locked ? "on" : ""}">${d.locked ? "Locked" : "Lock"}</button>
      <button type="button" data-act="clear" data-day="${i}">Clear</button>
    </div>
    ${din && d.mode !== "out" ? dnRecipeHtml(din) : ""}
  </div>`;
}

function dnWirePlan(host){
  host.querySelectorAll(".dn-nav").forEach(b => b.onclick = () => {
    dnWeekId = dnAddDays(dnWeekId, Number(b.dataset.step));
    dnExpanded = null;
    renderDinners();
  });
  host.querySelectorAll("[data-toggle]").forEach(el => el.onclick = () => {
    const i = Number(el.dataset.toggle);
    dnExpanded = dnExpanded === i ? null : i;
    renderDinners();
  });
  host.querySelectorAll(".dn-swap").forEach(sel => sel.onchange = () => {
    if(!sel.value) return;
    dnSetDay(Number(sel.dataset.day), {mode: "cook", dinner: sel.value}, `swap ${DN_DAYS[sel.dataset.day]}`);
  });
  host.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    const i = Number(b.dataset.day);
    const week = dnEnsureWeek(dnWeekId);
    const cur = week.days[i];
    if(b.dataset.act === "shuffle") dnShuffleDay(i);
    else if(b.dataset.act === "leftover"){
      const src = dnLeftoverSource(i);
      dnSetDay(i, src ? {mode: "leftover", dinner: src} : {mode: "leftover", text: "Leftovers"}, `leftovers on ${DN_DAYS[i]}`);
    }
    else if(b.dataset.act === "out") dnSetDay(i, {mode: "out"}, `no dinner ${DN_DAYS[i]}`);
    else if(b.dataset.act === "clear") dnSetDay(i, {mode: "free", locked: false}, `clear ${DN_DAYS[i]}`);
    else if(b.dataset.act === "lock"){
      const next = Object.assign({}, cur);
      if(cur.locked) delete next.locked; else next.locked = true;
      dnSetDay(i, next, `${cur.locked ? "unlock" : "lock"} ${DN_DAYS[i]}`);
    }
  });
  const toggle = document.getElementById("dnListToggle");
  if(toggle) toggle.onclick = () => {
    pushUndo("change dinner shopping list");
    const w = dnEnsureWeek(dnWeekId);
    w.onList = !w.onList;
    dnQueueSave("plans", w.onList ? "Add dinners to shopping list" : "Remove dinners from shopping list");
    renderDinners();
    updateShopBadge();
  };
  const clear = document.getElementById("dnClearWeek");
  if(clear) clear.onclick = () => {
    if(!confirm("Clear every day of this week's plan?")) return;
    pushUndo("clear dinner week");
    const w = dnEnsureWeek(dnWeekId);
    w.days = DN_DAYS.map(() => ({mode: "free"}));
    w.onList = false;
    dnQueueSave("plans", `Clear dinners w/c ${dnWeekId}`);
    renderDinners();
    updateShopBadge();
  };
}

function dnRenderLibrary(){
  const host = document.getElementById("dnLibrary");
  const rules = dnRules();
  const q = normaliseName(dnLibSearch);
  const match = d => !q || normaliseName(d.name).includes(q) || d.ingredients.some(i => normaliseName(i.name).includes(q));
  const active = dnData.dinners.filter(d => !d.retired && match(d));
  const retired = dnData.dinners.filter(d => d.retired && match(d));
  const order = ["chicken", "salmon", "fish", "lamb", "pork", "beef", "veg"];
  active.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));

  const row = d => {
    const open = dnExpanded === d.name;
    const avoid = dnAvoidHits(d, rules.avoid);
    const sub = [DN_TYPE_LABEL[d.type] || d.type, d.serves >= 2 ? `serves ${d.serves}` : null,
      d.mins ? `${d.mins} min` : null, d.protein ? `${d.protein}g protein` : null].filter(Boolean).join(" · ");
    return `<div class="recipe-row dn-${d.type}${open ? " open" : ""}">
      <div class="recipe-summary" data-lib="${escapeHtml(d.name)}">
        <div class="recipe-info"><div class="recipe-name">${escapeHtml(d.name)}${avoid.length ? " ⚠" : ""}</div>
        <div class="recipe-sub">${escapeHtml(sub)}</div></div>
      </div>
      ${open ? `<div class="recipe-details">${dnRecipeHtml(d)}
        <div class="recipe-actions">
          <button type="button" class="r-edit" data-retire="${escapeHtml(d.name)}">${d.retired ? "Bring back" : "Retire"}</button>
          <button type="button" class="r-delete" data-delete="${escapeHtml(d.name)}">Delete</button>
        </div></div>` : ""}
    </div>`;
  };

  host.innerHTML = `
    <div class="search"><input type="search" id="dnLibSearch" placeholder="Search dinners or ingredients" value="${escapeHtml(dnLibSearch)}" autocomplete="off"></div>
    ${active.length ? active.map(row).join("") : `<div class="empty">${dnData.dinners.length ? "No dinners match." : "No dinners yet. Use From Claude to paste recipes in."}</div>`}
    ${retired.length ? `<div class="ideas-title">Retired: never planned</div>${retired.map(row).join("")}` : ""}
    <div class="dn-rules">
      <div class="ideas-title">Planning rules</div>
      <div class="field"><label for="dnStaples">Staples you always have (left off the shopping list unless you track them in Cupboard)</label>
        <textarea id="dnStaples" rows="4">${escapeHtml(rules.staples.join(", "))}</textarea></div>
      <div class="field"><label for="dnAvoid">Never plan dinners containing</label>
        <textarea id="dnAvoid" rows="3">${escapeHtml(rules.avoid.join(", "))}</textarea></div>
      <button type="button" class="btn-secondary dn-rules-save" id="dnRulesSave">Save rules</button>
    </div>`;

  const search = document.getElementById("dnLibSearch");
  search.oninput = () => {
    dnLibSearch = search.value;
    const pos = search.selectionStart;
    dnRenderLibrary();
    const again = document.getElementById("dnLibSearch");
    again.focus();
    again.setSelectionRange(pos, pos);
  };
  host.querySelectorAll("[data-lib]").forEach(el => el.onclick = () => {
    dnExpanded = dnExpanded === el.dataset.lib ? null : el.dataset.lib;
    dnRenderLibrary();
  });
  host.querySelectorAll("[data-retire]").forEach(b => b.onclick = () => {
    const d = dnData.dinners.find(x => x.name === b.dataset.retire);
    if(!d) return;
    pushUndo(`${d.retired ? "bring back" : "retire"} ${d.name}`);
    if(d.retired) delete d.retired; else d.retired = true;
    dnQueueSave("data", `${d.retired ? "Retire" : "Bring back"} ${d.name}`);
    dnRenderLibrary();
  });
  host.querySelectorAll("[data-delete]").forEach(b => b.onclick = () => {
    const name = b.dataset.delete;
    if(!confirm(`Delete "${name}" from your dinners? Retire keeps it but stops it being planned.`)) return;
    pushUndo(`delete ${name}`);
    dnData.dinners = dnData.dinners.filter(x => x.name !== name);
    dnExpanded = null;
    dnQueueSave("data", `Delete dinner ${name}`);
    dnRenderLibrary();
  });
  document.getElementById("dnRulesSave").onclick = () => {
    const split = id => document.getElementById(id).value.split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    pushUndo("change planning rules");
    dnData.rules = Object.assign({}, dnRules(), {staples: split("dnStaples"), avoid: split("dnAvoid")});
    dnQueueSave("data", "Update dinner planning rules");
    dnRenderLibrary();
    updateShopBadge();
  };
}

/* ---------- From Claude: copy a prompt, paste the reply ---------- */

function dnOpenClaude(){
  dnParsed = null;
  document.getElementById("dnClaudeModal").classList.remove("hidden");
  document.getElementById("dnStep1").classList.remove("hidden");
  document.getElementById("dnStep2").classList.add("hidden");
  document.getElementById("dnPaste").value = "";
  document.getElementById("dnCopied").textContent = "";
  dnError("");
}
function dnCloseClaude(){ document.getElementById("dnClaudeModal").classList.add("hidden"); dnParsed = null; }
function dnError(msg){
  const el = document.getElementById("dnClaudeError");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

async function dnCopyPrompt(kind){
  const week = dnGetWeek(dnWeekId);
  const fixed = [];
  if(week){
    week.days.forEach((d, i) => {
      if(d.mode === "out") fixed.push(`${DN_DAYS[i]}: no dinner needed`);
      else if(d.locked || d.mode === "sorted") fixed.push(`${DN_DAYS[i]}: ${d.mode === "leftover" ? "Leftover " : ""}${d.dinner || d.text || "already sorted"}`);
    });
  }
  const text = dnBuildPrompt(kind, {
    rules: dnRules(),
    library: dnUsable(dnData.dinners, dnRules()).map(d => d.name),
    weekLabel: `Monday ${dnPrettyDate(dnWeekId)}`,
    fancy: document.getElementById("dnFancy").value.trim(),
    fixedDays: fixed
  });
  const status = document.getElementById("dnCopied");
  try{
    await navigator.clipboard.writeText(text);
    status.textContent = "Copied. Paste it into Claude, then paste Claude's whole reply below.";
  }catch(e){
    const box = document.getElementById("dnPaste");
    box.value = text;
    box.select();
    status.textContent = "Couldn't copy automatically. The prompt is in the box below: copy it from there.";
  }
}

function dnReadPaste(){
  const text = document.getElementById("dnPaste").value;
  const parsed = dnParseClaudeText(text);
  if(!parsed.recipes.length && !parsed.weeks.length){
    dnError("Couldn't find a recipe or a weekly plan in that. Recipes need a \"Serves …\" line under the title; plans need lines like \"Monday — Dish name\".");
    return;
  }
  dnError("");
  dnParsed = parsed;
  dnRenderReview();
  document.getElementById("dnStep1").classList.add("hidden");
  document.getElementById("dnStep2").classList.remove("hidden");
}

function dnRenderReview(){
  const host = document.getElementById("dnReview");
  const rules = dnRules();
  const existing = new Map(dnData.dinners.map(d => [dnNorm(d.name), d]));
  let html = "";

  if(dnParsed.recipes.length){
    html += `<div class="ideas-title">Recipes found (${dnParsed.recipes.length})</div>`;
    html += dnParsed.recipes.map((r, k) => {
      const avoid = dnAvoidHits(r, rules.avoid);
      const tag = existing.has(dnNorm(r.name)) ? "Updates your saved recipe" : "New";
      const meta = [tag, `${DN_TYPE_LABEL[r.type]}`, `serves ${r.serves}`, r.mins ? `${r.mins} min` : null,
        `${r.ingredients.length} ingredient${r.ingredients.length === 1 ? "" : "s"}`,
        `${r.method.length} step${r.method.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
      return `<label class="dn-review-row">
        <input type="checkbox" data-recipe="${k}" ${avoid.length ? "" : "checked"}>
        <span><b>${escapeHtml(r.name)}</b><small>${escapeHtml(meta)}</small>
        ${avoid.length ? `<small class="dn-warn">Contains ${escapeHtml(avoid.join(", "))}: on your avoid list</small>` : ""}</span>
      </label>`;
    }).join("");
  }

  if(dnParsed.weeks.length){
    const lib = dnData.dinners.concat(dnParsed.recipes.filter(r => !existing.has(dnNorm(r.name))));
    const week = dnParsed.weeks[dnParsed.weeks.length - 1];
    const days = dnPlanFromParsed(week, lib);
    dnParsed.planDays = days;
    const thisMon = dnThisMonday();
    const choices = [-1, 0, 1, 2].map(n => dnAddDays(thisMon, 7 * n));
    const def = dnWeekHasPlan(dnGetWeek(dnWeekId)) && dnWeekId === thisMon ? dnAddDays(thisMon, 7) : dnWeekId;
    if(!choices.includes(def)) choices.push(def);
    html += `<div class="ideas-title">${dnParsed.weeks.length > 1 ? `Plan found (using the last of ${dnParsed.weeks.length} weeks)` : "Plan found"}</div>
      <label class="dn-review-row"><input type="checkbox" id="dnUsePlan" checked>
        <span>Use as the plan for
        <select id="dnPlanWeek">${choices.sort().map(c => `<option value="${c}"${c === def ? " selected" : ""}>w/c ${dnPrettyDate(c, true)}${c === thisMon ? " (this week)" : ""}</option>`).join("")}</select>
        <small>Replaces anything already planned for that week and adds it to the shopping list.</small></span></label>
      <div class="dn-review-plan">${days.map((d, i) => {
        const what = d.mode === "out" ? "No dinner" : d.mode === "free" ? "—"
          : `${d.mode === "leftover" ? "Leftover " : ""}${d.dinner || d.text || ""}`;
        const missing = d.mode === "cook" && !d.dinner;
        const din = d.dinner ? lib.find(x => x.name === d.dinner) : null;
        const avoid = din ? dnAvoidHits(din, rules.avoid) : [];
        const warn = avoid.length ? `contains ${avoid.join(", ")}` : missing ? "no recipe found, so not on the shopping list" : "";
        return `<div><b>${DN_DAYS_SHORT[i]}</b> ${escapeHtml(what)}${warn ? ` <small class="dn-warn">${escapeHtml(warn)}</small>` : ""}</div>`;
      }).join("")}</div>`;
  }
  host.innerHTML = html;
}

function dnSaveReview(){
  if(!dnParsed) return;
  pushUndo("bring in dinners from Claude");
  const picked = [...document.querySelectorAll("#dnReview [data-recipe]")].filter(b => b.checked)
    .map(b => dnParsed.recipes[Number(b.dataset.recipe)]);
  picked.forEach(r => {
    const idx = dnData.dinners.findIndex(d => dnNorm(d.name) === dnNorm(r.name));
    if(idx >= 0) dnData.dinners[idx] = Object.assign({}, r, dnData.dinners[idx].retired ? {retired: true} : {});
    else dnData.dinners.push(r);
  });
  if(picked.length) dnQueueSave("data", `Add ${picked.length} dinner${picked.length > 1 ? "s" : ""} from Claude`);

  const use = document.getElementById("dnUsePlan");
  if(dnParsed.planDays && use && use.checked){
    const id = document.getElementById("dnPlanWeek").value;
    const lib = dnData.dinners;
    const week = dnEnsureWeek(id);
    // Re-match now that the new recipes are saved.
    week.days = dnPlanFromParsed(dnParsed.weeks[dnParsed.weeks.length - 1], lib);
    week.onList = true;
    dnWeekId = id;
    dnMode = "plan";
    dnQueueSave("plans", `Plan dinners w/c ${id} from Claude`);
  }else if(picked.length && !dnParsed.planDays){
    dnMode = "library";
  }
  dnCloseClaude();
  renderDinners();
  updateShopBadge();
}

/* ---------- Styles and wiring ---------- */

(function dnInit(){
  if(typeof document === "undefined" || !document.getElementById("dinnersView")) return;

  const css = document.createElement("style");
  css.textContent = `
  #dinnerFooter{display:flex; gap:10px;}
  #dinnerFooter .recipe-footer-btn{flex:1;}
  #dnClaudeBtn{background:var(--card); color:var(--ink); border:1px solid var(--line);}
  .dn-weeknav{display:flex; align-items:center; gap:10px; margin-bottom:12px;}
  .dn-nav{width:40px; height:40px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--ink); font-size:1.3rem; cursor:pointer;}
  .dn-weeklabel{flex:1; text-align:center; display:flex; flex-direction:column;}
  .dn-weeklabel small{color:var(--ink-soft); font-size:0.8rem;}
  .dn-empty{padding:24px 12px;}
  .dn-day .dn-summary{align-items:flex-start;}
  .dn-date{width:46px; flex-shrink:0; display:flex; flex-direction:column; line-height:1.25;}
  .dn-date small{font-size:0.72rem; color:var(--ink-soft);}
  .dn-date .dn-office{color:var(--paprika);}
  .dn-lock{font-size:0.85rem;}
  .recipe-row.dn-chicken{border-left-color:var(--paprika);}
  .recipe-row.dn-salmon{border-left-color:var(--brick);}
  .recipe-row.dn-veg{border-left-color:var(--herb);}
  .recipe-row.dn-lamb, .recipe-row.dn-pork, .recipe-row.dn-beef, .recipe-row.dn-fish{border-left-color:var(--ink-soft);}
  .recipe-row.dn-leftover .recipe-name, .recipe-row.dn-out .recipe-name, .recipe-row.dn-free .recipe-name{color:var(--ink-soft);}
  .recipe-row.dn-free{border-style:dashed;}
  .dn-swap{width:100%; padding:9px; border:1px solid var(--line); border-radius:9px; background:var(--card); color:var(--ink); font:inherit; font-size:0.9rem; margin-bottom:8px;}
  .dn-actions{display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;}
  .dn-actions button{flex:1 1 0; min-width:0; padding:8px 2px; border-radius:9px; border:1px solid var(--line); background:var(--card); color:var(--ink); font-size:0.85rem; cursor:pointer;}
  .dn-actions button.on{background:var(--ink); color:var(--card); border-color:var(--ink);}
  .dn-ings{list-style:disc; padding-left:20px; margin:0; display:flex; flex-direction:column; gap:4px; font-size:0.92rem;}
  .dn-tip, .dn-boost{margin:0; font-size:0.9rem;}
  .dn-boost{color:var(--ink-soft);}
  .dn-warn{color:var(--brick); font-size:0.82rem; margin:4px 0 0; display:block;}
  .dn-checks{background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:10px 12px; margin:12px 0; font-size:0.86rem; display:flex; flex-direction:column; gap:5px;}
  .dn-checks div{display:flex; gap:8px;}
  .dn-checks span{width:16px; flex-shrink:0; text-align:center; font-weight:700;}
  .dn-checks .ok span{color:var(--herb);}
  .dn-checks .bad span{color:var(--brick);}
  .dn-weektools{display:flex; justify-content:flex-end; margin:-4px 0 10px;}
  .dn-clear{padding:7px 12px; border-radius:9px; border:1px solid var(--brick); background:none; color:var(--brick); font-size:0.85rem; cursor:pointer;}
  .dn-clear:active{background:var(--brick); color:#fff;}
  .dn-weekactions{display:flex; gap:10px; margin-bottom:16px;}
  .dn-weekactions button{flex:1; padding:11px; border-radius:10px; border:none; font-size:0.9rem; cursor:pointer;}
  .dn-rules{margin-top:20px;}
  .dn-rules textarea, #dnPaste{width:100%; padding:10px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink); font:inherit; font-size:0.9rem;}
  .dn-rules-save{width:100%; padding:10px; border-radius:10px; margin-bottom:16px; cursor:pointer;}
  .dn-copy{display:flex; gap:8px; margin-bottom:6px;}
  .dn-copy button{flex:1; padding:10px 8px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--ink); font-size:0.86rem; cursor:pointer;}
  #dnCopied{color:var(--herb-dark); font-size:0.82rem; min-height:1em; margin:4px 0 10px;}
  .dn-review-row{display:flex; gap:10px; align-items:flex-start; padding:9px 0; border-bottom:1px solid var(--line); font-size:0.92rem;}
  .dn-review-row input{margin-top:4px; width:18px; height:18px; accent-color:var(--herb); flex-shrink:0;}
  .dn-review-row small{display:block; color:var(--ink-soft); font-size:0.78rem; margin-top:2px;}
  .dn-review-row select{margin:4px 0; padding:6px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); max-width:100%;}
  .dn-review-plan{font-size:0.88rem; display:flex; flex-direction:column; gap:4px; margin:10px 0 4px;}
  .dn-review-plan b{display:inline-block; width:36px;}
  `;
  document.head.appendChild(css);

  document.querySelectorAll("#dnModeChips .chip").forEach(c => c.onclick = () => {
    dnMode = c.dataset.mode;
    dnExpanded = null;
    renderDinners();
  });
  document.getElementById("dnGenerateBtn").onclick = () => {
    const week = dnGetWeek(dnWeekId);
    if(dnWeekHasPlan(week) && week.days.some(d => (d.mode === "cook" || d.mode === "leftover") && !d.locked)
      && !confirm("Replace this week's unlocked days with a new plan? Locked days, \"Out\" days and anything marked already sorted stay.")) return;
    dnGenerate();
  };
  document.getElementById("dnClaudeBtn").onclick = dnOpenClaude;
  document.getElementById("dnCopyPlan").onclick = () => dnCopyPrompt("plan");
  document.getElementById("dnCopyRecipe").onclick = () => dnCopyPrompt("recipe");
  document.getElementById("dnClaudeCancel").onclick = dnCloseClaude;
  document.getElementById("dnClaudeRead").onclick = dnReadPaste;
  document.getElementById("dnClaudeBack").onclick = () => {
    document.getElementById("dnStep1").classList.remove("hidden");
    document.getElementById("dnStep2").classList.add("hidden");
  };
  document.getElementById("dnClaudeSave").onclick = dnSaveReview;
  document.getElementById("dnClaudeModal").addEventListener("click", e => {
    if(e.target.id === "dnClaudeModal") dnCloseClaude();
  });
})();
