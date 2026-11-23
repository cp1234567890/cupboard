/* Cupboard — Ingredient check.
 *
 * Lists every ingredient your baking recipes and dinners use (plus anything in the
 * cupboard), so you can tidy them in one place:
 *   - merge names that are the same thing (they become aliases in Aliases.json,
 *     and any cupboard stock is combined);
 *   - mark as a staple, track an amount (with a unit), or leave out of the cupboard;
 *   - set where it's kept and which aisle it's in.
 * It also flags possible duplicates and units that can't be compared.
 *
 * Uses the app's own data and save functions from index.html (items, recipes,
 * aliases, shopping, locMemory, queueSave, …) and dnData from dinners.js.
 */
(function(){
  if(typeof document === "undefined") return;

  let icFilter = "all";
  let icSearch = "";
  let icOpen = null;              // key of the expanded ingredient
  const icSelected = new Set();   // keys ticked for merging

  // Units that count as "one of something", so a tin in a recipe can be
  // compared with an item tracked in pcs.
  const COUNTABLE = ["pcs", "tin", "pack"];
  // Units that can't be compared with any tracked amount.
  const LOOSE = ["clove", "handful", "pinch", "bunch", "slice", "squeeze", "drop"];
  // Words that describe rather than change an ingredient: "fresh ginger" is ginger.
  const DESCRIBERS = ["fresh", "paste", "sauce", "unsalted", "salted", "large", "medium", "small", "free range", "whole"];

  const ICUNITS = typeof UNITS !== "undefined" ? UNITS : ["g", "kg", "ml", "l", "tsp", "tbsp", "cups", "pcs"];

  function dismissed(){
    try{ return new Set(JSON.parse(localStorage.getItem("cupboard-ic-notsame") || "[]")); }catch(e){ return new Set(); }
  }
  function dismiss(a, b){
    const set = dismissed();
    set.add([a, b].sort().join("|"));
    try{ localStorage.setItem("cupboard-ic-notsame", JSON.stringify([...set])); }catch(e){}
  }

  function aliasKeyFor(key){ return Object.keys(aliases).find(k => normaliseName(k) === key) || null; }

  /* ---------- Gather every ingredient ---------- */

  function gather(){
    const groups = new Map();
    const get = name => {
      const key = canonicalName(name);
      if(!groups.has(key)) groups.set(key, {key, wordings: new Set(), uses: [], units: new Set(), item: null});
      return groups.get(key);
    };
    const addUse = (g, label, kind) => { if(!g.uses.some(u => u.label === label)) g.uses.push({label, kind}); };

    (recipes || []).forEach(r => {
      const lists = r.sections && r.sections.length ? r.sections.map(s => s.ingredients || []) : [r.ingredients || []];
      lists.forEach(list => list.forEach(ing => {
        if(!ing.name) return;
        const g = get(ing.name);
        g.wordings.add(normaliseName(ing.name));
        if(ing.unit) g.units.add(ing.unit);
        addUse(g, r.name, "Baking");
      }));
    });
    if(typeof dnData !== "undefined"){
      dnData.dinners.forEach(d => (d.ingredients || []).forEach(ing => {
        const g = get(ing.name);
        g.wordings.add(normaliseName(ing.name));
        if(ing.unit) g.units.add(ing.unit);
        addUse(g, d.name + (d.retired ? " (retired)" : ""), "Dinner");
      }));
    }
    items.forEach(it => {
      const g = get(it.name);
      g.item = it;
      g.wordings.add(normaliseName(it.name));
    });

    groups.forEach(g => {
      const ak = aliasKeyFor(g.key);
      (ak ? aliases[ak] : []).forEach(a => g.wordings.add(normaliseName(a)));
      if(ak) g.wordings.add(normaliseName(ak));
      g.display = g.item ? g.item.name : ak ? titleCase(ak) : titleCase([...g.wordings][0] || g.key);
      g.aliasList = ak ? aliases[ak].slice() : [];
      g.status = !g.item ? "none" : g.item.staple ? "staple" : "tracked";
      g.unitIssue = unitIssue(g);
    });
    const list = [...groups.values()].sort((a, b) => a.display.localeCompare(b.display));
    findDuplicates(list);
    return list;
  }

  // A tracked item whose unit recipes can't be compared with.
  function unitIssue(g){
    if(!g.item || g.item.staple) return null;
    const have = g.item.unit;
    const bad = [...g.units].filter(u => {
      if(u === have) return false;
      if(COUNTABLE.includes(u) && COUNTABLE.includes(have)) return false;
      if(LOOSE.includes(u)) return true;
      return convertQty(1, u, have, g.item.name) === null;
    });
    return bad.length ? bad : null;
  }

  function sameThing(a, b){
    // a and b are normalised names. True when they're very likely the same ingredient.
    if(a === b) return true;
    const sa = dnSingular(a), sb = dnSingular(b);
    if(sa === sb) return true;
    const strip = s => {
      let t = " " + s + " ";
      DESCRIBERS.forEach(w => { t = t.replace(" " + w + " ", " "); });
      return t.trim().replace(/\s+/g, " ");
    };
    const ta = dnSingular(strip(a)), tb = dnSingular(strip(b));
    if(ta && ta === tb) return true;
    // A typo in one word ("tumeric" / "turmeric"), with every other word the same.
    const wa = a.split(" "), wb = b.split(" ");
    if(wa.length !== wb.length) return false;
    const diff = wa.map((w, i) => [w, wb[i]]).filter(([x, y]) => x !== y);
    return diff.length === 1 && Math.min(diff[0][0].length, diff[0][1].length) >= 5 && editDistance(diff[0][0], diff[0][1]) <= 1;
  }

  function findDuplicates(list){
    const no = dismissed();
    list.forEach(g => { g.dups = []; });
    for(let i = 0; i < list.length; i++){
      for(let j = i + 1; j < list.length; j++){
        const a = list[i], b = list[j];
        if(no.has([a.key, b.key].sort().join("|"))) continue;
        if(a.item && b.item && a.item.staple !== b.item.staple && a.item.unit !== b.item.unit) {/* still allowed */}
        if(sameThing(a.key, b.key)){ a.dups.push(b); b.dups.push(a); }
      }
    }
  }

  /* ---------- Changes ---------- */

  function afterChange(){
    render();
    renderRecipes();
    if(typeof currentView !== "undefined"){
      if(currentView === "shopping") renderShopping();
      if(currentView === "dinners" && typeof renderDinners === "function") renderDinners();
    }
    updateShopBadge();
    draw();
  }

  function setStatusFor(g, status, qty, unit, each){
    const label = g.display;
    if(status === "none"){
      if(!g.item) return;
      if(!g.item.staple && g.item.quantity > 0 && !confirm(`Take ${label} out of the cupboard? It currently has ${fmtQty(g.item.quantity, g.item.unit)}.`)) return;
      pushUndo(`remove ${label}`);
      items = items.filter(i => i !== g.item);
      queueSave(`Remove ${label}`);
    }else if(status === "staple"){
      pushUndo(`mark ${label} as staple`);
      if(g.item){ g.item.staple = true; }
      else items.push(newItem(g, {quantity: 1, unit: "g", staple: true}));
      queueSave(`Mark ${label} as staple`);
    }else{
      const q = Number(qty);
      if(!(q >= 0) || !ICUNITS.includes(unit)) return;
      pushUndo(`track ${label}`);
      if(g.item){
        delete g.item.staple;
        g.item.quantity = roundQty(q);
        g.item.unit = unit;
      }else{
        items.push(newItem(g, {quantity: roundQty(q), unit}));
      }
      const it = g.item || items[items.length - 1];
      if(unit === "pcs" && each) it.each = each; else delete it.each;   // portion size only means something for pieces
      queueSave(`Track ${label}: ${fmtQty(q, unit)}${it.each ? ` (1 portion = ${it.each.qty} ${it.each.unit})` : ""}`);
    }
    afterChange();
  }

  function newItem(g, extra){
    const mem = memFor(g.display);
    return Object.assign({name: g.display, loc: mem && mem.loc ? mem.loc : "cupboard"}, mem && mem.loc2 ? {loc2: mem.loc2} : {}, extra);
  }

  function setLocation(g, loc){
    if(g.item){
      if(locOf(g.item) === loc) return;
      setItemLoc(g.item.name, loc);      // handles undo and saving
    }else{
      pushUndo(`${g.display} lives in ${loc}`);
      rememberLoc(g.display, loc);
      queueLocSave(`Remember ${g.display} lives in ${loc}`);
    }
    afterChange();
  }

  function setAisle(g, aisle){
    pushUndo(`move ${g.display} to ${aisle}`);
    shopping.aisles[g.key] = aisle;
    queueShoppingSave(`Move ${g.display} to ${aisle}`);
    afterChange();
  }

  function unalias(g, alias){
    const ak = aliasKeyFor(g.key);
    if(!ak) return;
    pushUndo(`split ${alias} from ${g.display}`);
    aliases[ak] = aliases[ak].filter(a => normaliseName(a) !== normaliseName(alias));
    if(!aliases[ak].length) delete aliases[ak];
    queueAliasSave(`Split ${alias} from ${g.display}`);
    afterChange();
  }

  // Merge `others` into `keep`. Everything the others were called becomes an alias
  // of keep; cupboard stock, locations and aisles move across.
  function merge(keep, others){
    if(!others.length) return;
    pushUndo(`merge into ${keep.display}`);
    const notes = [];
    let keepItem = keep.item;
    const keyName = keepItem ? keepItem.name : (aliasKeyFor(keep.key) || keep.display);

    // Gather every name the others go by before changing anything.
    const newAliases = [];
    others.forEach(o => {
      const ok = aliasKeyFor(o.key);
      if(ok){ newAliases.push(ok, ...aliases[ok]); delete aliases[ok]; }
      o.wordings.forEach(w => newAliases.push(w));
      newAliases.push(o.display);
    });
    const oldKeepKey = aliasKeyFor(keep.key);
    let list = oldKeepKey ? aliases[oldKeepKey] : [];
    if(oldKeepKey && oldKeepKey !== keyName){ delete aliases[oldKeepKey]; list = list.concat(oldKeepKey); }
    keep.wordings.forEach(w => list.push(w));
    const seen = new Set([normaliseName(keyName)]);
    aliases[keyName] = list.concat(newAliases).filter(a => {
      const n = normaliseName(a);
      if(!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    }).map(a => a.trim());
    if(!aliases[keyName].length) delete aliases[keyName];

    // Cupboard stock.
    others.forEach(o => {
      const oi = o.item;
      if(!oi) return;
      if(!keepItem){
        oi.name = keep.display;           // the other's stock becomes keep's
        keepItem = oi;
        return;
      }
      if(keepItem.staple || oi.staple){
        if(oi.staple && !keepItem.staple && keepItem.quantity <= 0) keepItem.staple = true;
      }else{
        const conv = convertQty(oi.quantity, oi.unit, keepItem.unit, keepItem.name);
        if(conv !== null) keepItem.quantity = roundQty(keepItem.quantity + conv);
        else notes.push(`${oi.name} (${fmtQty(oi.quantity, oi.unit)}) couldn't be added to ${keepItem.name} because the units differ, so check its amount.`);
      }
      if(!keepItem.used || (oi.used && oi.used > keepItem.used)) if(oi.used) keepItem.used = oi.used;
      items = items.filter(i => i !== oi);
    });

    // Remembered places and aisles: keep's own wins, otherwise take the other's.
    const newKey = normaliseName(keyName);
    [keep, ...others].forEach(g => {
      if(locMemory[g.key] && !locMemory[newKey]) locMemory[newKey] = locMemory[g.key];
      if(shopping.aisles[g.key] && !shopping.aisles[newKey]) shopping.aisles[newKey] = shopping.aisles[g.key];
      if(g.key !== newKey){ delete locMemory[g.key]; delete shopping.aisles[g.key]; }
    });

    const names = others.map(o => o.display).join(", ");
    queueAliasSave(`Merge ${names} into ${keep.display}`);
    queueSave(`Merge ${names} into ${keep.display}`);
    queueLocSave(`Merge ${names} into ${keep.display}`);
    queueShoppingSave(`Merge ${names} into ${keep.display}`);
    icSelected.clear();
    icOpen = normaliseName(keyName);
    afterChange();
    if(notes.length) alert(notes.join("\n\n"));
  }

  function askMerge(groups){
    const box = document.getElementById("icMergeBox");
    box.innerHTML = `
      <p class="ic-merge-q">Merge into one ingredient. Which name should it use?</p>
      ${groups.map((g, k) => `<label class="ic-merge-opt"><input type="radio" name="icKeep" value="${k}" ${k === bestKeep(groups) ? "checked" : ""}>
        <span>${escapeHtml(g.display)}<small>${escapeHtml(statusText(g))} · used in ${g.uses.length}</small></span></label>`).join("")}
      <p class="hint">The other names become aliases, so recipes that use them match this ingredient. Cupboard amounts are added together.</p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="icMergeCancel">Cancel</button>
        <button type="button" class="btn-primary" id="icMergeGo">Merge</button>
      </div>`;
    box.classList.remove("hidden");
    box.scrollIntoView({block: "nearest"});
    document.getElementById("icMergeCancel").onclick = () => { box.classList.add("hidden"); };
    document.getElementById("icMergeGo").onclick = () => {
      const k = Number(box.querySelector("input[name=icKeep]:checked").value);
      box.classList.add("hidden");
      merge(groups[k], groups.filter((_, i) => i !== k));
    };
  }

  // Suggest keeping the one in the cupboard, then the most used, then the shortest name.
  function bestKeep(groups){
    let best = 0;
    groups.forEach((g, i) => {
      const b = groups[best];
      const score = x => (x.item ? 1000 : 0) + x.uses.length * 10 - x.display.length / 100;
      if(score(g) > score(b)) best = i;
    });
    return best;
  }

  /* ---------- Drawing ---------- */

  function statusText(g){
    if(g.status === "staple") return "Staple";
    if(g.status === "tracked") return `Tracking ${amountText(g.item)}`;
    return "Not in cupboard";
  }

  function amountText(item){
    if(item.unit === "pcs" && item.each) return `${roundQty(item.quantity)} × ${item.each.qty} ${item.each.unit}`;
    return fmtQty(item.quantity, item.unit);
  }

  function needsLook(g){ return g.dups.length || g.unitIssue; }

  function draw(){
    const host = document.getElementById("icList");
    if(!host) return;
    const all = gather();
    const counts = {
      all: all.length,
      none: all.filter(g => g.status === "none").length,
      staple: all.filter(g => g.status === "staple").length,
      tracked: all.filter(g => g.status === "tracked").length,
      look: all.filter(needsLook).length,
      unused: all.filter(g => !g.uses.length).length
    };
    document.getElementById("icSummary").textContent =
      `${counts.all} ingredients · ${counts.tracked} tracked · ${counts.staple} staples · ${counts.none} not in cupboard`;
    const chips = [["all", "All"], ["look", "Needs a look"], ["none", "Not in cupboard"], ["staple", "Staples"], ["tracked", "Tracked"], ["unused", "Not in any recipe"]];
    document.getElementById("icChips").innerHTML = chips.map(([k, l]) =>
      `<button type="button" class="chip${icFilter === k ? " active" : ""}" data-f="${k}">${l} (${counts[k]})</button>`).join("");
    document.querySelectorAll("#icChips .chip").forEach(c => c.onclick = () => { icFilter = c.dataset.f; draw(); });

    const q = normaliseName(icSearch);
    const shown = all.filter(g => {
      if(icFilter === "look" && !needsLook(g)) return false;
      if(icFilter === "none" && g.status !== "none") return false;
      if(icFilter === "staple" && g.status !== "staple") return false;
      if(icFilter === "tracked" && g.status !== "tracked") return false;
      if(icFilter === "unused" && g.uses.length) return false;
      if(q && ![...g.wordings].some(w => w.includes(q)) && !normaliseName(g.display).includes(q)) return false;
      return true;
    });

    // Keep ticks only for things still on the list.
    [...icSelected].forEach(k => { if(!all.some(g => g.key === k)) icSelected.delete(k); });
    const bar = document.getElementById("icMergeBar");
    bar.classList.toggle("hidden", icSelected.size < 2);
    bar.querySelector("span").textContent = `${icSelected.size} ticked`;

    host.innerHTML = shown.length ? "" : `<div class="empty">Nothing here.</div>`;
    shown.forEach(g => host.appendChild(rowFor(g, all)));
  }

  function rowFor(g, all){
    const open = icOpen === g.key;
    const row = document.createElement("div");
    row.className = "ic-row" + (open ? " open" : "") + (g.status === "none" ? " ic-none" : "");
    const others = g.aliasList.length ? `also: ${g.aliasList.join(", ")}` : "";
    const flags = [];
    if(g.dups.length) flags.push("possible duplicate");
    if(g.unitIssue) flags.push("unit clash");
    row.innerHTML = `
      <div class="ic-head">
        <input type="checkbox" class="ic-tick" aria-label="Tick ${escapeHtml(g.display)} to merge" ${icSelected.has(g.key) ? "checked" : ""}>
        <div class="ic-main">
          <div class="ic-name">${escapeHtml(g.display)}${flags.length ? ` <span class="ic-flag">${escapeHtml(flags.join(" · "))}</span>` : ""}</div>
          <div class="ic-sub">${escapeHtml([g.uses.length ? `used in ${g.uses.length}` : "not in any recipe", others].filter(Boolean).join(" · "))}</div>
        </div>
        <span class="ic-status ic-${g.status}">${escapeHtml(g.status === "tracked" ? amountText(g.item) : g.status === "staple" ? "staple" : "—")}</span>
      </div>`;
    const tick = row.querySelector(".ic-tick");
    tick.onclick = e => {
      e.stopPropagation();
      if(tick.checked) icSelected.add(g.key); else icSelected.delete(g.key);
      draw();
    };
    row.querySelector(".ic-head").onclick = () => { icOpen = open ? null : g.key; draw(); };
    if(open) row.appendChild(detailsFor(g, all));
    return row;
  }

  function detailsFor(g, all){
    const box = document.createElement("div");
    box.className = "ic-details";
    const loc = g.item ? locOf(g.item) : ((memFor(g.display) || {}).loc || "");
    const aisle = aisleFor(g.display);
    const recipeUnits = [...g.units];
    const defaultUnit = g.item && !g.item.staple ? g.item.unit : guessUnit(recipeUnits);

    box.innerHTML = `
      ${g.dups.length ? `<div class="ic-block ic-warn-block"><b>Looks like the same thing as:</b>
        ${g.dups.map((d, k) => `<div class="ic-dup"><span>${escapeHtml(d.display)} <small>${escapeHtml(statusText(d))}</small></span>
          <button type="button" data-merge="${k}">Merge</button><button type="button" class="ic-quiet" data-notsame="${k}">Not the same</button></div>`).join("")}
      </div>` : ""}
      ${g.unitIssue ? `<div class="ic-block ic-warn-block"><b>Unit clash:</b> you track this in ${escapeHtml(g.item.unit)}, but recipes use ${escapeHtml(g.unitIssue.join(", "))}, so those recipes can't check how much you have. ${g.item.unit === "pcs" ? "Set a portion size below (e.g. 1 portion = 80 g), track it in a matching unit," : "Track it in a matching unit"} or make it a staple.</div>` : ""}

      <div class="ic-block"><div class="ic-label">In the cupboard</div>
        <div class="dn-seg ic-seg" data-k="status">
          <button type="button" data-v="none" class="${g.status === "none" ? "on" : ""}">Not in cupboard</button>
          <button type="button" data-v="staple" class="${g.status === "staple" ? "on" : ""}">Staple</button>
          <button type="button" data-v="tracked" class="${g.status === "tracked" ? "on" : ""}">Track amount</button>
        </div>
        <div class="ic-trackbox${g.status === "tracked" ? "" : " hidden"}">
          <div class="ic-track">
            <input type="number" class="ic-qty" min="0" step="any" inputmode="decimal" value="${g.item && !g.item.staple ? roundQty(g.item.quantity) : ""}" placeholder="Amount">
            <select class="ic-unit">${ICUNITS.map(u => `<option${u === defaultUnit ? " selected" : ""}>${u}</option>`).join("")}</select>
            <button type="button" class="ic-save">Save</button>
          </div>
          <div class="ic-portion${defaultUnit === "pcs" ? "" : " hidden"}">
            <span>1 portion =</span>
            <input type="number" class="ic-each" min="0" step="any" inputmode="decimal" value="${g.item && g.item.each ? g.item.each.qty : ""}" placeholder="${suggestPortion(g) || "e.g. 80"}">
            <select class="ic-each-unit">${["g", "ml"].map(u => `<option${g.item && g.item.each && g.item.each.unit === u ? " selected" : ""}>${u}</option>`).join("")}</select>
          </div>
          <small class="ic-hint ic-portion-hint${defaultUnit === "pcs" ? "" : " hidden"}">Optional. With a portion size, recipes that ask for grams can use your pieces, and the other way round.</small>
        </div>
        ${recipeUnits.length ? `<small class="ic-hint">Recipes measure it in: ${escapeHtml(recipeUnits.join(", "))}</small>` : ""}
      </div>

      <div class="ic-block"><div class="ic-label">Kept in</div>
        <div class="dn-seg ic-seg" data-k="loc">
          ${["cupboard", "fridge", "freezer"].map(l => `<button type="button" data-v="${l}" class="${loc === l ? "on" : ""}">${LOC_LABEL[l]}</button>`).join("")}
        </div>
      </div>

      <div class="ic-block"><div class="ic-label">Shopping aisle</div>
        <select class="ic-aisle">${shopping.aisleOrder.map(a => `<option${a === aisle ? " selected" : ""}>${escapeHtml(a)}</option>`).join("")}</select>
      </div>

      ${g.uses.length ? `<div class="ic-block"><div class="ic-label">Used in</div>
        <ul class="ic-uses">${g.uses.map(u => `<li>${escapeHtml(u.label)} <small>${u.kind}</small></li>`).join("")}</ul></div>` : ""}

      ${g.aliasList.length ? `<div class="ic-block"><div class="ic-label">Also called</div>
        <div class="ic-aliases">${g.aliasList.map((a, k) => `<span class="ic-alias">${escapeHtml(a)}<button type="button" data-unalias="${k}" aria-label="Split ${escapeHtml(a)} off">✕</button></span>`).join("")}</div>
        <small class="ic-hint">✕ splits a name back into its own ingredient.</small></div>` : ""}`;

    // In the cupboard
    const track = box.querySelector(".ic-trackbox");
    const showPortion = () => {
      const pcs = track.querySelector(".ic-unit").value === "pcs";
      track.querySelector(".ic-portion").classList.toggle("hidden", !pcs);
      track.querySelector(".ic-portion-hint").classList.toggle("hidden", !pcs);
    };
    track.querySelector(".ic-unit").onchange = showPortion;
    box.querySelectorAll('[data-k="status"] button').forEach(b => b.onclick = () => {
      if(b.dataset.v === "tracked"){
        if(g.status !== "tracked"){
          box.querySelectorAll('[data-k="status"] button').forEach(x => x.classList.toggle("on", x === b));
          track.classList.remove("hidden");
          track.querySelector(".ic-qty").focus();
        }
        return;
      }
      setStatusFor(g, b.dataset.v);
    });
    track.querySelector(".ic-save").onclick = () => {
      const qty = track.querySelector(".ic-qty").value;
      if(qty === "" || Number(qty) < 0){ track.querySelector(".ic-qty").focus(); return; }
      const unit = track.querySelector(".ic-unit").value;
      const each = Number(track.querySelector(".ic-each").value);
      setStatusFor(g, "tracked", qty, unit, unit === "pcs" && each > 0 ? {qty: roundQty(each), unit: track.querySelector(".ic-each-unit").value} : null);
    };
    box.querySelectorAll('[data-k="loc"] button').forEach(b => b.onclick = () => setLocation(g, b.dataset.v));
    box.querySelector(".ic-aisle").onchange = e => setAisle(g, e.target.value);
    box.querySelectorAll("[data-unalias]").forEach(b => b.onclick = () => unalias(g, g.aliasList[Number(b.dataset.unalias)]));
    box.querySelectorAll("[data-merge]").forEach(b => b.onclick = () => askMerge([g, g.dups[Number(b.dataset.merge)]]));
    box.querySelectorAll("[data-notsame]").forEach(b => b.onclick = () => { dismiss(g.key, g.dups[Number(b.dataset.notsame)].key); draw(); });
    return box;
  }

  function suggestPortion(g){
    const amounts = [];
    (typeof dnData !== "undefined" ? dnData.dinners : []).forEach(d => d.ingredients.forEach(i => {
      if(canonicalName(i.name) === g.key && (i.unit === "g" || i.unit === "ml") && i.quantity) amounts.push(i.quantity);
    }));
    if(!amounts.length) return null;
    const counts = {};
    amounts.forEach(a => { counts[a] = (counts[a] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  function guessUnit(units){
    if(units.some(u => COUNTABLE.includes(u))) return "pcs";
    if(units.includes("ml") || units.includes("l")) return "ml";
    return "g";
  }

  /* ---------- Open, close, styles ---------- */

  function openCheck(){
    icFilter = "all"; icSearch = ""; icOpen = null; icSelected.clear();
    document.getElementById("icSearch").value = "";
    document.getElementById("icMergeBox").classList.add("hidden");
    document.getElementById("icModal").classList.remove("hidden");
    draw();
  }
  function closeCheck(){ document.getElementById("icModal").classList.add("hidden"); }

  const css = document.createElement("style");
  css.textContent = `
  #icModal .modal{max-width:560px; height:92vh; max-height:92vh; display:flex; flex-direction:column;}
  .ic-top{flex-shrink:0;}
  #icSummary{color:var(--ink-soft); font-size:0.85rem; margin:2px 0 10px;}
  #icChips{margin-bottom:8px;}
  #icSearch{width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink); font-size:0.95rem; margin-bottom:8px;}
  #icMergeBar{display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:10px; background:var(--herb); color:#fff; margin-bottom:8px; font-size:0.9rem;}
  #icMergeBar span{flex:1;}
  #icMergeBar button{padding:7px 12px; border-radius:8px; border:none; background:#fff; color:var(--herb-dark); font-weight:600; cursor:pointer;}
  #icMergeBar .ic-clear{background:none; color:#fff; font-weight:400; text-decoration:underline;}
  #icMergeBox{border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:8px; background:var(--oat);}
  .ic-merge-q{margin:0 0 6px; font-weight:600;}
  .ic-merge-opt{display:flex; gap:10px; align-items:flex-start; padding:6px 0;}
  .ic-merge-opt input{margin-top:4px; accent-color:var(--herb);}
  .ic-merge-opt small{display:block; color:var(--ink-soft); font-size:0.78rem;}
  #icList{flex:1; overflow-y:auto; margin:0 -4px; padding:0 4px;}
  .ic-row{border:1px solid var(--line); border-radius:12px; background:var(--card); margin-bottom:8px;}
  .ic-row.ic-none{border-style:dashed;}
  .ic-head{display:flex; align-items:center; gap:10px; padding:10px 12px; cursor:pointer;}
  .ic-tick{width:18px; height:18px; flex-shrink:0; accent-color:var(--herb);}
  .ic-main{flex:1; min-width:0;}
  .ic-name{font-size:0.98rem;}
  .ic-flag{font-size:0.72rem; color:var(--brick); white-space:nowrap;}
  .ic-sub{font-size:0.78rem; color:var(--ink-soft); overflow:hidden; text-overflow:ellipsis;}
  .ic-status{font-size:0.82rem; color:var(--ink-soft); white-space:nowrap;}
  .ic-status.ic-staple{font-style:italic;}
  .ic-status.ic-tracked{color:var(--ink);}
  .ic-details{padding:0 12px 12px;}
  .ic-block{margin-top:10px;}
  .ic-label{font-size:0.78rem; color:var(--ink-soft); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.03em;}
  .ic-warn-block{border-left:3px solid var(--brick); padding:6px 10px; background:var(--oat); border-radius:6px; font-size:0.88rem;}
  .ic-dup{display:flex; align-items:center; gap:6px; margin-top:6px;}
  .ic-dup span{flex:1;}
  .ic-dup small{color:var(--ink-soft);}
  .ic-dup button, .ic-save{padding:6px 10px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); font-size:0.82rem; cursor:pointer;}
  .ic-dup button:not(.ic-quiet), .ic-save{background:var(--herb); color:#fff; border-color:var(--herb);}
  .ic-seg{flex:none; width:100%;}
  .ic-seg button.on{background:var(--herb); color:#fff;}
  .ic-track{display:flex; gap:8px; margin-top:8px;}
  .ic-portion{display:flex; align-items:center; gap:8px; margin-top:8px; font-size:0.9rem;}
  .ic-portion.hidden, .ic-trackbox.hidden, .ic-portion-hint.hidden{display:none;}
  .ic-each{width:90px; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); font-size:0.95rem;}
  .ic-each-unit{padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink);}
  .ic-track.hidden{display:none;}
  .ic-qty{flex:1; min-width:0; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); font-size:0.95rem;}
  .ic-unit, .ic-aisle{padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--ink); font-size:0.9rem;}
  .ic-aisle{width:100%;}
  .ic-hint{display:block; color:var(--ink-soft); font-size:0.76rem; margin-top:4px;}
  .ic-uses{margin:0; padding-left:18px; font-size:0.86rem;}
  .ic-uses small{color:var(--ink-soft);}
  .ic-aliases{display:flex; flex-wrap:wrap; gap:6px;}
  .ic-alias{display:inline-flex; align-items:center; gap:4px; padding:3px 4px 3px 10px; border:1px solid var(--line); border-radius:999px; font-size:0.84rem;}
  .ic-alias button{border:none; background:none; color:var(--ink-soft); cursor:pointer; font-size:0.8rem; padding:2px 6px;}
  .ic-open-btn{margin-top:8px;}
  `;
  document.head.appendChild(css);

  const modal = document.createElement("div");
  modal.id = "icModal";
  modal.className = "modal-backdrop hidden";
  modal.innerHTML = `
    <div class="modal">
      <div class="ic-top">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <h2>Ingredient check</h2>
          <button type="button" class="btn-secondary" id="icClose" style="padding:8px 14px; border-radius:10px; border:none; cursor:pointer;">Done</button>
        </div>
        <p id="icSummary"></p>
        <div class="chips" id="icChips"></div>
        <input type="search" id="icSearch" placeholder="Search ingredients" autocomplete="off">
        <div id="icMergeBar" class="hidden"><span></span><button type="button" class="ic-clear" id="icClearTicks">Clear</button><button type="button" id="icMergeTicked">Merge…</button></div>
        <div id="icMergeBox" class="hidden"></div>
      </div>
      <div id="icList"></div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById("icClose").onclick = closeCheck;
  modal.addEventListener("click", e => { if(e.target === modal) closeCheck(); });
  document.getElementById("icSearch").oninput = e => { icSearch = e.target.value; draw(); };
  document.getElementById("icClearTicks").onclick = () => { icSelected.clear(); draw(); };
  document.getElementById("icMergeTicked").onclick = () => {
    const all = gather();
    askMerge(all.filter(g => icSelected.has(g.key)));
  };

  // Button on the Cupboard tab, under "Paste a list or receipt".
  const quick = document.getElementById("quickBtn");
  if(quick){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "icOpenBtn";
    btn.className = "quick-btn ic-open-btn";
    btn.textContent = "Ingredient check: tidy names, staples, places & aisles";
    btn.onclick = openCheck;
    quick.insertAdjacentElement("afterend", btn);
  }

  window.openIngredientCheck = openCheck;
})();
